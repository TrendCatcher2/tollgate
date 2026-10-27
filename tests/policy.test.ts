import { describe, expect, it } from 'vitest';
import { evaluate, type EvalContext } from '../src/guard/policy.js';
import { goodOrder, makeLedger, makePolicy, makeSession, NOW } from './fixtures.js';

const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({
  policy: makePolicy(),
  ledger: makeLedger(),
  session: makeSession(),
  now: NOW,
  ...over,
});

describe('tool scope', () => {
  it('denies tools the agent was not given', () => {
    expect(evaluate('list_transactions', {}, ctx())).toMatchObject({ verdict: 'deny', rule: 'tool-not-allowed' });
  });

  it('sends always-human tools to review regardless of arguments', () => {
    expect(evaluate('accept_dispute_claim', { dispute_id: 'PP-D-1', note: 'ok' }, ctx())).toMatchObject({ verdict: 'review', rule: 'always-human' });
  });

  it('stops payment actions after the per-conversation limit', () => {
    const session = { ...makeSession(), moneyCalls: 5 };
    expect(evaluate('create_order', goodOrder(), ctx({ session }))).toMatchObject({ verdict: 'deny', rule: 'rate-limit' });
  });
});

describe('create_order', () => {
  it('allows an order that matches the catalog', () => {
    expect(evaluate('create_order', goodOrder(), ctx())).toMatchObject({ verdict: 'allow', rule: 'catalog-match' });
  });

  it('blocks a price the agent changed', () => {
    const args = goodOrder();
    args.items[0]!.itemCost = 0.01;
    args.items[0]!.itemTotal = 0.02;
    expect(evaluate('create_order', args, ctx())).toMatchObject({ verdict: 'deny', rule: 'price-mismatch' });
  });

  it('blocks items that are not in the catalog', () => {
    const args = goodOrder();
    args.items[0]!.name = 'Gift card $500';
    expect(evaluate('create_order', args, ctx())).toMatchObject({ verdict: 'deny', rule: 'unknown-item' });
  });

  it('blocks quantities above the item limit', () => {
    const args = goodOrder();
    args.items[0]!.quantity = 50;
    args.items[0]!.itemTotal = 600;
    expect(evaluate('create_order', args, ctx())).toMatchObject({ verdict: 'deny', rule: 'quantity' });
  });

  it('blocks a line total that disagrees with price x quantity', () => {
    const args = goodOrder();
    args.items[0]!.itemTotal = 1;
    expect(evaluate('create_order', args, ctx())).toMatchObject({ verdict: 'deny', rule: 'line-total' });
  });

  it('blocks redirects to another site', () => {
    const args = { ...goodOrder(), returnUrl: 'https://paypa1-login.example.net/return' };
    expect(evaluate('create_order', args, ctx())).toMatchObject({ verdict: 'deny', rule: 'redirect-origin' });
  });

  it('accepts redirects on the shop origin', () => {
    const args = { ...goodOrder(), returnUrl: 'https://shop.example.test/thanks' };
    expect(evaluate('create_order', args, ctx()).verdict).toBe('allow');
  });

  it('blocks a changed shipping price', () => {
    expect(evaluate('create_order', { ...goodOrder(), shippingCost: 0 }, ctx())).toMatchObject({ verdict: 'deny', rule: 'shipping-price' });
  });

  it('sends discounts to a human', () => {
    expect(evaluate('create_order', { ...goodOrder(), discount: 10 }, ctx())).toMatchObject({ verdict: 'review', rule: 'discount' });
  });

  it('sends large orders to a human', () => {
    const args = { ...goodOrder(), items: [{ name: 'Hand-knotted rug', itemCost: 180, quantity: 1, taxPercent: 0, itemTotal: 180 }] };
    expect(evaluate('create_order', args, ctx({ policy: makePolicy({ maxOrderTotalCents: 10_000 }) }))).toMatchObject({ verdict: 'review', rule: 'order-limit' });
  });
});

describe('create_refund', () => {
  it("allows a small refund on the customer's own recent order", () => {
    expect(evaluate('create_refund', { capture_id: '3C679366HH908993F', amount: { currency_code: 'USD', value: '20.00' } }, ctx())).toMatchObject({
      verdict: 'allow',
      rule: 'refund-in-policy',
    });
  });

  it("blocks refunding someone else's payment", () => {
    expect(evaluate('create_refund', { capture_id: '9XY87654ZW3210987' }, ctx())).toMatchObject({ verdict: 'deny', rule: 'not-your-order' });
  });

  it('blocks payments the shop does not know', () => {
    expect(evaluate('create_refund', { capture_id: 'AAAAAAAAAAAAAAAAA' }, ctx())).toMatchObject({ verdict: 'deny', rule: 'unknown-capture' });
  });

  it('blocks refunds in anonymous chats', () => {
    expect(evaluate('create_refund', { capture_id: '3C679366HH908993F' }, ctx({ session: makeSession(null) }))).toMatchObject({ verdict: 'deny', rule: 'unauthenticated' });
  });

  it('blocks refunding more than was paid', () => {
    const args = { capture_id: '3C679366HH908993F', amount: { currency_code: 'USD', value: '500.00' } };
    expect(evaluate('create_refund', args, ctx())).toMatchObject({ verdict: 'deny', rule: 'exceeds-refundable' });
  });

  it('blocks a second refund once the order is fully refunded', () => {
    const ledger = makeLedger();
    ledger.orders[0]!.refundedCents = ledger.orders[0]!.totalCents;
    expect(evaluate('create_refund', { capture_id: '3C679366HH908993F' }, ctx({ ledger }))).toMatchObject({ verdict: 'deny', rule: 'already-refunded' });
  });

  it('blocks zero, negative and non-numeric amounts', () => {
    for (const value of ['0', '-5', 'all of it']) {
      const args = { capture_id: '3C679366HH908993F', amount: { currency_code: 'USD', value } };
      expect(evaluate('create_refund', args, ctx())).toMatchObject({ verdict: 'deny', rule: 'refund-amount' });
    }
  });

  it('sends a full refund above the automatic limit to a human', () => {
    expect(evaluate('create_refund', { capture_id: '3C679366HH908993F' }, ctx())).toMatchObject({ verdict: 'review', rule: 'refund-limit' });
  });

  it('sends refunds outside the refund window to a human', () => {
    expect(evaluate('create_refund', { capture_id: '7TK53561YB803214S' }, ctx())).toMatchObject({ verdict: 'review', rule: 'refund-window' });
  });

  it('sends refunds past the conversation budget to a human', () => {
    const session = { ...makeSession(), refundedCents: 7_000 };
    const args = { capture_id: '3C679366HH908993F', amount: { currency_code: 'USD', value: '20.00' } };
    expect(evaluate('create_refund', args, ctx({ session }))).toMatchObject({ verdict: 'review', rule: 'session-budget' });
  });
});

describe('get_order', () => {
  it("allows reading the customer's own order", () => {
    expect(evaluate('get_order', { id: '5O190127TN364715T' }, ctx()).verdict).toBe('allow');
  });

  it("blocks reading another customer's order", () => {
    expect(evaluate('get_order', { id: '1AB23456CD7890123' }, ctx())).toMatchObject({ verdict: 'deny', rule: 'not-your-order' });
  });
});
