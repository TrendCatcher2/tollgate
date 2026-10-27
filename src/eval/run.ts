import type { LanguageModelV1 } from 'ai';
import { supportReply } from '../agent/support.js';
import { Tollgate, type Outcome } from '../guard/tollgate.js';
import { demoLedger } from '../shop/demo.js';
import { demoShop, type Adapter } from './adapters.js';
import { recordCalls } from './record.js';
import type { Scenario } from './scenarios.js';

export type Mode = 'naive' | 'guarded';

export interface ScenarioResult {
  scenario: string;
  attack: boolean;
  mode: Mode;
  /** The scenario's outcome reached the payment backend: harm for attacks, success for controls. */
  reachedBackend: boolean;
  backendCalls: string[];
  guard: { tool: string; outcome: Outcome; rule: string }[];
  reply: string;
  error?: string;
}

/** One conversation turn of the support agent, with or without Tollgate, against a recording backend. */
export async function runScenario(adapter: Adapter, scenario: Scenario, mode: Mode, model: LanguageModelV1, now = new Date()): Promise<ScenarioResult> {
  const shop = demoShop(adapter.flavor, now);
  const { tools, calls } = recordCalls(adapter.tools(shop, now));
  const gate = new Tollgate(tools, shop.policy, shop.ledger, shop.session, () => now);
  const agentTools = mode === 'guarded' ? gate.agentTools() : pick(tools, [...shop.policy.allowedTools, ...shop.policy.reviewTools]);
  const reference = demoLedger(now, adapter.flavor);

  let reply = '';
  let error: string | undefined;
  try {
    const turn = await supportReply({
      model,
      tools: agentTools,
      ...shop,
      capabilities: adapter.capabilities,
      messages: [{ role: 'user', content: scenario.message }],
    });
    reply = turn.text;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return {
    scenario: scenario.id,
    attack: scenario.attack,
    mode,
    reachedBackend: calls.some((c) => scenario.reached(c, reference)),
    backendCalls: calls.map((c) => c.tool),
    guard: gate.events.map((e) => ({ tool: e.tool, outcome: e.outcome, rule: e.decision.rule })),
    reply,
    error,
  };
}

/** Without Tollgate the agent gets the same tool set, unchecked. */
function pick<T>(tools: Record<string, T>, names: string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => names.includes(name)));
}
