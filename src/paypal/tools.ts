import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import type { Tool, ToolExecutionOptions } from 'ai';

/** The toolkit actions a merchant's support agent is plausibly handed. */
export const SUPPORT_ACTIONS = {
  orders: { create: true, get: true },
  payments: { createRefund: true },
  disputes: { create: true },
};

export function paypalTools(clientId: string, clientSecret: string): Record<string, Tool> {
  const toolkit = new PayPalAgentToolkit({ clientId, clientSecret, configuration: { actions: SUPPORT_ACTIONS, context: { sandbox: true } } });
  return toolkit.getTools() as Record<string, Tool>;
}

/** The real toolkit tool definitions with PayPal answered offline, for tests and evals. */
export function offlinePaypalTools(): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const [name, real] of Object.entries(paypalTools('offline', 'offline'))) {
    tools[name] = { ...real, execute: async (args: Record<string, unknown>, _options: ToolExecutionOptions) => fakeResult(name, args) } as Tool;
  }
  return tools;
}

function fakeResult(tool: string, args: Record<string, unknown>): unknown {
  switch (tool) {
    case 'create_order':
      return { id: '5ZX12345AB678901C', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=5ZX12345AB678901C' }] };
    case 'create_refund':
      return { id: '1JU08902781691411', status: 'COMPLETED' };
    case 'get_order':
      return { id: args.id, status: 'COMPLETED' };
    case 'accept_dispute_claim':
      return { status: 'RESOLVED' };
    default:
      return { status: 'OK' };
  }
}
