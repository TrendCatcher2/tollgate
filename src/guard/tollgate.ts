import type { Tool, ToolExecutionOptions } from 'ai';
import { randomUUID } from 'node:crypto';
import { toCents } from './money.js';
import { evaluate, MONEY_TOOLS, toolkitEquivalent, type Decision, type EvalContext, type Policy, type Session } from './policy.js';
import type { Ledger } from '../shop/types.js';

export type Outcome = 'executed' | 'blocked' | 'queued' | 'failed';

export interface GuardEvent {
  id: string;
  at: string;
  tool: string;
  args: Record<string, unknown>;
  decision: Decision;
  outcome: Outcome;
  result?: unknown;
  error?: string;
}

export interface PendingApproval {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  decision: Decision;
  createdAt: string;
}

/** Puts a policy check in front of every PayPal toolkit tool an agent is given. */
export class Tollgate {
  readonly events: GuardEvent[] = [];
  readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(e: GuardEvent) => void>();

  constructor(
    private readonly toolkitTools: Record<string, Tool>,
    readonly policy: Policy,
    readonly ledger: Ledger,
    readonly session: Session,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  onEvent(listener: (e: GuardEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The tools the model sees: only enabled ones, each routed through the policy. */
  agentTools(): Record<string, Tool> {
    const visible = new Set([...this.policy.allowedTools, ...this.policy.reviewTools]);
    const out: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(this.toolkitTools)) {
      if (!visible.has(name)) continue;
      out[name] = { ...tool, execute: (args: Record<string, unknown>, options: ToolExecutionOptions) => this.call(name, args, options) } as Tool;
    }
    return out;
  }

  /** Runs one tool call through the policy; the model gets a structured verdict instead of an exception. */
  async call(tool: string, args: Record<string, unknown>, options?: ToolExecutionOptions): Promise<unknown> {
    const decision = evaluate(tool, args, this.context());
    if (MONEY_TOOLS.has(tool)) this.session.moneyCalls += 1;

    if (decision.verdict === 'deny') {
      this.record(tool, args, decision, 'blocked');
      return { blocked: true, rule: decision.rule, reason: decision.reason };
    }
    if (decision.verdict === 'review') {
      const id = randomUUID();
      this.pending.set(id, { id, tool, args, decision, createdAt: this.clock().toISOString() });
      this.record(tool, args, decision, 'queued', { approvalId: id });
      return { pending_human_approval: true, approval_id: id, reason: decision.reason };
    }
    return this.run(tool, args, decision, options);
  }

  /** A person approved a queued call; hard rules are re-checked because state may have changed since. */
  async approve(id: string): Promise<GuardEvent> {
    const item = this.takePending(id);
    const decision = evaluate(item.tool, item.args, this.context());
    if (decision.verdict === 'deny') return this.record(item.tool, item.args, decision, 'blocked');
    await this.run(item.tool, item.args, { verdict: 'allow', rule: 'human-approved', reason: item.decision.reason });
    return this.events[this.events.length - 1]!;
  }

  reject(id: string): GuardEvent {
    const item = this.takePending(id);
    return this.record(item.tool, item.args, { verdict: 'deny', rule: 'human-rejected', reason: item.decision.reason }, 'blocked');
  }

  private async run(tool: string, args: Record<string, unknown>, decision: Decision, options?: ToolExecutionOptions): Promise<unknown> {
    const original = this.toolkitTools[tool];
    if (!original?.execute) {
      this.record(tool, args, decision, 'failed', { error: 'tool has no executor' });
      return { error: 'tool unavailable' };
    }
    const finalArgs = this.pinTrustedFields(tool, args);
    try {
      const result = await original.execute(finalArgs, options ?? { toolCallId: randomUUID(), messages: [] });
      this.applyEffects(tool, finalArgs);
      this.record(tool, finalArgs, decision, 'executed', { result });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.record(tool, finalArgs, decision, 'failed', { error });
      return { error };
    }
  }

  /** Redirect URLs are set by the shop, never by the model. */
  private pinTrustedFields(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    if (tool !== 'create_order') return args;
    return { ...args, returnUrl: `${this.policy.shopOrigin}/paypal/return`, cancelUrl: `${this.policy.shopOrigin}/paypal/cancel` };
  }

  private applyEffects(tool: string, rawArgs: Record<string, unknown>): void {
    const { tool: kind, args } = toolkitEquivalent(tool, rawArgs);
    if (kind !== 'create_refund') return;
    const order = this.ledger.orders.find((o) => o.captureId === args.capture_id);
    if (!order) return;
    const amount = args.amount as { value?: string } | undefined;
    const cents = amount ? toCents(amount.value) ?? 0 : order.totalCents - order.refundedCents;
    order.refundedCents += cents;
    this.session.refundedCents += cents;
  }

  private takePending(id: string): PendingApproval {
    const item = this.pending.get(id);
    if (!item) throw new Error(`no pending approval ${id}`);
    this.pending.delete(id);
    return item;
  }

  private context(): EvalContext {
    return { policy: this.policy, ledger: this.ledger, session: this.session, now: this.clock() };
  }

  private record(
    tool: string,
    args: Record<string, unknown>,
    decision: Decision,
    outcome: Outcome,
    extra: { result?: unknown; error?: string; approvalId?: string } = {},
  ): GuardEvent {
    const event: GuardEvent = { id: extra.approvalId ?? randomUUID(), at: this.clock().toISOString(), tool, args, decision, outcome, result: extra.result, error: extra.error };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }
}
