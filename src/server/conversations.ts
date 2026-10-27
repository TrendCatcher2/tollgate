import type { CoreMessage, LanguageModelV1, Tool, ToolExecutionOptions } from 'ai';
import { randomUUID } from 'node:crypto';
import { supportReply } from '../agent/support.js';
import { braintreeTools, fakeBackend, type BraintreeBackend } from '../braintree/tools.js';
import { Tollgate, type GuardEvent, type PendingApproval } from '../guard/tollgate.js';
import { ADAPTERS } from '../eval/adapters.js';
import type { RecordedCall } from '../eval/record.js';
import { hijackedModel } from '../eval/hijacked-model.js';
import { braintreeScenarios } from '../eval/scenarios-braintree.js';
import type { Scenario } from '../eval/scenarios.js';
import { demoLedger, demoPolicy, demoSession } from '../shop/demo.js';
import type { Ledger, PaidOrder } from '../shop/types.js';

export interface BackendCall extends RecordedCall {
  at: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** 'ai' is the real model; 'hijacked' replays the attacker's exact call, the worst case, with no model quota. */
export type AgentKind = 'ai' | 'hijacked';

export interface Conversation {
  id: string;
  guarded: boolean;
  agent: AgentKind;
  gate: Tollgate;
  /** The raw backend tools, before Tollgate. */
  tools: Record<string, Tool>;
  ledger: Ledger;
  messages: CoreMessage[];
  backendCalls: BackendCall[];
  lastSeen: number;
}

export interface ConversationView {
  id: string;
  guarded: boolean;
  agent: AgentKind;
  backend: string;
  customer: { name: string; orders: (PaidOrder & { refundableCents: number })[] };
  events: GuardEvent[];
  pending: PendingApproval[];
  backendCalls: BackendCall[];
  /** Attack and control messages that reference this conversation's payment ids. */
  scenarios: Pick<Scenario, 'id' | 'title' | 'attack' | 'message'>[];
}

const MAX_CONVERSATIONS = 200;
const IDLE_MS = 30 * 60_000;

/** Demo conversations between the signed-in customer and the support agent, with or without Tollgate. */
export class Conversations {
  private readonly byId = new Map<string, Conversation>();

  constructor(
    private readonly opts: {
      model: () => LanguageModelV1;
      /** Live Braintree sandbox, or null to answer offline. */
      live: {
        backend: BraintreeBackend;
        /** Catalog and vaulted customers from `npm run seed:braintree`. */
        ledger: Ledger;
        /** Fresh settled payments for one conversation. */
        seedOrders: () => Promise<PaidOrder[]>;
      } | null;
    },
  ) {}

  get backendLabel(): string {
    return this.opts.live ? 'Braintree sandbox (live)' : 'Offline Braintree stand-in';
  }

  private scenariosFor(ledger: Ledger): Scenario[] {
    const amina = ledger.orders.filter((o) => o.customerId === 'cus_amina');
    const bilal = ledger.orders.find((o) => o.customerId === 'cus_bilal');
    if (amina.length < 2 || !bilal) return [];
    const ids = { aminaRecent: { capture: amina[0]!.captureId }, aminaOld: { capture: amina[1]!.captureId }, bilal: { capture: bilal.captureId } };
    // Seeded sandbox payments are all recent, so the stale-refund attack only applies to the offline shop.
    return braintreeScenarios(ids).filter((s) => !(this.opts.live && s.id === 'stale-full-refund'));
  }

  async create(guarded: boolean, agent: AgentKind = 'ai'): Promise<Conversation> {
    this.evict();
    const ledger = await this.freshLedger();
    const session = demoSession();
    const policy = demoPolicy('braintree');
    const backend = this.opts.live?.backend ?? fakeBackend();
    const backendCalls: BackendCall[] = [];
    const tools = logCalls(braintreeTools(backend, { ledger, session }), backendCalls);
    const gate = new Tollgate(tools, policy, ledger, session);
    const convo: Conversation = { id: randomUUID(), guarded, agent, gate, tools, ledger, messages: [], backendCalls, lastSeen: Date.now() };
    this.byId.set(convo.id, convo);
    return convo;
  }

  get(id: string): Conversation {
    const convo = this.byId.get(id);
    if (!convo) throw new HttpError(404, 'conversation not found; start a new one');
    convo.lastSeen = Date.now();
    return convo;
  }

  async send(convo: Conversation, text: string): Promise<string> {
    const { gate } = convo;
    const tools = convo.guarded ? gate.agentTools() : unguarded(convo.tools, [...gate.policy.allowedTools, ...gate.policy.reviewTools]);
    const messages: CoreMessage[] = [...convo.messages, { role: 'user', content: text }];
    let model: LanguageModelV1;
    if (convo.agent === 'hijacked') {
      const scenario = this.scenariosFor(convo.ledger).find((s) => s.message === text);
      if (!scenario) throw new HttpError(400, 'the hijacked agent only replays the attack buttons; pick one, or switch to the AI agent');
      model = hijackedModel(scenario.hijackedCall);
    } else {
      model = this.opts.model();
    }
    let turn;
    try {
      turn = await supportReply({
        model,
        tools,
        ledger: convo.ledger,
        session: gate.session,
        policy: gate.policy,
        capabilities: ADAPTERS.braintree.capabilities,
        messages,
      });
    } catch (err) {
      console.error(err);
      const busy = /quota|rate|429|exhausted/i.test(String(err));
      throw new HttpError(502, busy ? 'the AI model is rate limited right now; wait a minute and resend' : 'the AI model did not answer; resend your message');
    }
    convo.messages = [...messages, ...turn.responseMessages];
    return turn.text;
  }

  view(convo: Conversation): ConversationView {
    const customer = convo.ledger.customers.find((c) => c.id === convo.gate.session.customerId);
    return {
      id: convo.id,
      guarded: convo.guarded,
      agent: convo.agent,
      backend: this.backendLabel,
      customer: {
        name: customer?.name ?? 'Guest',
        orders: convo.ledger.orders
          .filter((o) => o.customerId === customer?.id)
          .map((o) => ({ ...o, refundableCents: o.totalCents - o.refundedCents })),
      },
      events: convo.gate.events,
      pending: [...convo.gate.pending.values()],
      backendCalls: convo.backendCalls,
      scenarios: this.scenariosFor(convo.ledger).map(({ id, title, attack, message }) => ({ id, title, attack, message })),
    };
  }

  private async freshLedger(): Promise<Ledger> {
    const { live } = this.opts;
    if (!live) return demoLedger(new Date(), 'braintree');
    let orders: PaidOrder[];
    try {
      orders = await live.seedOrders();
    } catch (err) {
      console.error(err);
      throw new HttpError(502, 'could not create sandbox payments for a new conversation; try again in a minute');
    }
    return { ...structuredClone(live.ledger), orders };
  }

  private evict(): void {
    const now = Date.now();
    for (const [id, c] of this.byId) if (now - c.lastSeen > IDLE_MS) this.byId.delete(id);
    while (this.byId.size >= MAX_CONVERSATIONS) this.byId.delete(this.byId.keys().next().value!);
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Without Tollgate the agent holds the same tools, unchecked; backend errors come back as results, as they do through Tollgate. */
function unguarded(tools: Record<string, Tool>, names: string[]): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const name of names) {
    const t = tools[name];
    if (!t) continue;
    out[name] = {
      ...t,
      execute: async (args: Record<string, unknown>, options: ToolExecutionOptions) => {
        try {
          return await t.execute!(args, options);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    } as Tool;
  }
  return out;
}

/** Records every call that reaches the payment backend, whoever made it. */
function logCalls(tools: Record<string, Tool>, log: BackendCall[]): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    out[name] = {
      ...t,
      execute: async (args: Record<string, unknown>, options: ToolExecutionOptions) => {
        const at = new Date().toISOString();
        try {
          const result = await t.execute!(args, options);
          log.push({ tool: name, args, at, ok: true, result });
          return result;
        } catch (err) {
          log.push({ tool: name, args, at, ok: false, error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
      },
    } as Tool;
  }
  return out;
}
