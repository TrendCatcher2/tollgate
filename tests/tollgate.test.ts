import { describe, expect, it, vi } from 'vitest';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { Tollgate } from '../src/guard/tollgate.js';
import { goodOrder, makeLedger, makePolicy, makeSession, NOW } from './fixtures.js';

function fakeToolkit() {
  const calls: { name: string; args: unknown }[] = [];
  const make = (name: string, fail = false): Tool =>
    tool({
      description: name,
      parameters: z.object({}).passthrough(),
      execute: async (args) => {
        calls.push({ name, args });
        if (fail) throw new Error('PAYPAL_API_HTTP_ERROR');
        return { id: 'RESULT', status: 'COMPLETED' };
      },
    });
  const tools = {
    create_order: make('create_order'),
    create_refund: make('create_refund'),
    get_order: make('get_order'),
    accept_dispute_claim: make('accept_dispute_claim'),
    list_transactions: make('list_transactions'),
  };
  return { tools, calls, failing: { ...tools, create_refund: make('create_refund', true) } };
}

const gate = (tools: Record<string, Tool>) => new Tollgate(tools, makePolicy(), makeLedger(), makeSession(), () => NOW);
const opts = { toolCallId: 't1', messages: [] };

describe('Tollgate', () => {
  it('hides tools the agent was not given', () => {
    const tg = gate(fakeToolkit().tools);
    expect(Object.keys(tg.agentTools()).sort()).toEqual(['accept_dispute_claim', 'create_order', 'create_refund', 'get_order']);
  });

  it('never reaches PayPal for a denied call', async () => {
    const { tools, calls } = fakeToolkit();
    const tg = gate(tools);
    const result = await tg.agentTools().create_refund!.execute!({ capture_id: '9XY87654ZW3210987' }, opts);
    expect(result).toMatchObject({ blocked: true, rule: 'not-your-order' });
    expect(calls).toHaveLength(0);
    expect(tg.events.at(-1)).toMatchObject({ outcome: 'blocked' });
  });

  it('runs an allowed refund and records it against the order', async () => {
    const { tools, calls } = fakeToolkit();
    const tg = gate(tools);
    await tg.call('create_refund', { capture_id: '3C679366HH908993F', amount: { currency_code: 'USD', value: '20.00' } });
    expect(calls).toHaveLength(1);
    expect(tg.ledger.orders[0]!.refundedCents).toBe(2_000);
    expect(tg.session.refundedCents).toBe(2_000);
  });

  it('does not count a refund PayPal rejected', async () => {
    const tg = gate(fakeToolkit().failing);
    const result = await tg.call('create_refund', { capture_id: '3C679366HH908993F', amount: { currency_code: 'USD', value: '20.00' } });
    expect(result).toMatchObject({ error: 'PAYPAL_API_HTTP_ERROR' });
    expect(tg.ledger.orders[0]!.refundedCents).toBe(0);
    expect(tg.events.at(-1)).toMatchObject({ outcome: 'failed' });
  });

  it('pins PayPal redirects to the shop', async () => {
    const { tools, calls } = fakeToolkit();
    await gate(tools).call('create_order', goodOrder());
    expect(calls[0]!.args).toMatchObject({ returnUrl: 'https://shop.example.test/paypal/return', cancelUrl: 'https://shop.example.test/paypal/cancel' });
  });

  it('queues review calls and runs them only after approval', async () => {
    const { tools, calls } = fakeToolkit();
    const tg = gate(tools);
    const result = (await tg.call('create_refund', { capture_id: '3C679366HH908993F' })) as { approval_id: string };
    expect(result).toMatchObject({ pending_human_approval: true });
    expect(calls).toHaveLength(0);

    await tg.approve(result.approval_id);
    expect(calls).toHaveLength(1);
    expect(tg.ledger.orders[0]!.refundedCents).toBe(5_700);
    expect(tg.pending.size).toBe(0);
  });

  it('re-checks hard rules at approval time', async () => {
    const { tools, calls } = fakeToolkit();
    const tg = gate(tools);
    const queued = (await tg.call('create_refund', { capture_id: '3C679366HH908993F' })) as { approval_id: string };
    tg.ledger.orders[0]!.refundedCents = 5_700;

    const event = await tg.approve(queued.approval_id);
    expect(event).toMatchObject({ outcome: 'blocked', decision: { rule: 'already-refunded' } });
    expect(calls).toHaveLength(0);
  });

  it('records a rejection without calling PayPal', async () => {
    const { tools, calls } = fakeToolkit();
    const tg = gate(tools);
    const queued = (await tg.call('accept_dispute_claim', { dispute_id: 'PP-D-1', note: 'x' })) as { approval_id: string };
    expect(tg.reject(queued.approval_id)).toMatchObject({ outcome: 'blocked', decision: { rule: 'human-rejected' } });
    expect(calls).toHaveLength(0);
  });

  it('notifies listeners of every decision', async () => {
    const tg = gate(fakeToolkit().tools);
    const seen = vi.fn();
    tg.onEvent(seen);
    await tg.call('list_transactions', {});
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ tool: 'list_transactions', outcome: 'blocked' }));
  });
});
