import { describe, expect, it, vi } from 'vitest';
import { braintreeTools, fakeBackend } from '../src/braintree/tools.js';
import { evaluate, type EvalContext } from '../src/guard/policy.js';
import { Tollgate } from '../src/guard/tollgate.js';
import { DEMO_IDS, demoLedger, demoPolicy, demoSession } from '../src/shop/demo.js';

const NOW = new Date('2026-11-01T12:00:00Z');
const ids = DEMO_IDS.braintree;
const ctx = (): EvalContext => ({ policy: demoPolicy('braintree'), ledger: demoLedger(NOW, 'braintree'), session: demoSession(), now: NOW });
const mugs = (itemCost = 12, shippingCost = 5) => ({ items: [{ name: 'Clay chai mug', quantity: 2, itemCost, itemTotal: itemCost * 2 }], shippingCost });

describe('Braintree calls under the shared rules', () => {
  it('allows a small refund on her own transaction (short lowercase ids)', () => {
    expect(evaluate('refund_transaction', { transaction_id: ids.aminaRecent.capture, amount: '12.00' }, ctx())).toMatchObject({ verdict: 'allow', rule: 'refund-in-policy' });
  });

  it("blocks refunding another customer's transaction", () => {
    expect(evaluate('refund_transaction', { transaction_id: ids.bilal.capture }, ctx())).toMatchObject({ verdict: 'deny', rule: 'not-your-order' });
  });

  it('blocks refunding more than was paid', () => {
    expect(evaluate('refund_transaction', { transaction_id: ids.aminaRecent.capture, amount: '285.00' }, ctx())).toMatchObject({ verdict: 'deny', rule: 'exceeds-refundable' });
  });

  it("blocks looking up another customer's transaction", () => {
    expect(evaluate('find_transaction', { transaction_id: ids.bilal.capture }, ctx())).toMatchObject({ verdict: 'deny', rule: 'not-your-order' });
    expect(evaluate('find_transaction', { transaction_id: ids.aminaRecent.capture }, ctx()).verdict).toBe('allow');
  });

  it('checks charges against the catalog and shipping', () => {
    expect(evaluate('charge_saved_card', mugs(), ctx())).toMatchObject({ verdict: 'allow', rule: 'catalog-match' });
    expect(evaluate('charge_saved_card', mugs(0.01), ctx())).toMatchObject({ verdict: 'deny', rule: 'price-mismatch' });
    expect(evaluate('charge_saved_card', mugs(12, 0), ctx())).toMatchObject({ verdict: 'deny', rule: 'shipping-price' });
  });

  it('always sends dispute acceptance to a person', () => {
    expect(evaluate('accept_dispute', { dispute_id: 'd9k2mx7q' }, ctx())).toMatchObject({ verdict: 'review', rule: 'always-human' });
  });

  it('counts Braintree payment actions toward the rate limit', () => {
    const c = ctx();
    c.session.moneyCalls = c.policy.maxMoneyCallsPerSession;
    expect(evaluate('refund_transaction', { transaction_id: ids.aminaRecent.capture, amount: '1.00' }, c)).toMatchObject({ verdict: 'deny', rule: 'rate-limit' });
  });
});

describe('Braintree tools', () => {
  it("charge the signed-in customer's own vaulted card and record the order", async () => {
    const backend = fakeBackend();
    const charge = vi.spyOn(backend, 'charge');
    const shop = { ledger: demoLedger(NOW, 'braintree'), session: demoSession('cus_amina') };
    const result = await braintreeTools(backend, shop, () => NOW).charge_saved_card!.execute!(mugs(), { toolCallId: 't', messages: [] });
    expect(charge).toHaveBeenCalledWith('29.00', 'tok_amina');
    expect(result).toMatchObject({ amount: '$29.00' });
    expect(shop.ledger.orders.at(-1)).toMatchObject({ customerId: 'cus_amina', totalCents: 2_900 });
  });

  it('refuse to charge anyone when nobody is signed in', async () => {
    const shop = { ledger: demoLedger(NOW, 'braintree'), session: demoSession(null) };
    await expect(braintreeTools(fakeBackend(), shop).charge_saved_card!.execute!(mugs(), { toolCallId: 't', messages: [] })).rejects.toThrow('no saved card');
  });

  it('record an allowed refund against the order through Tollgate', async () => {
    const ledger = demoLedger(NOW, 'braintree');
    const session = demoSession();
    const gate = new Tollgate(braintreeTools(fakeBackend(), { ledger, session }), demoPolicy('braintree'), ledger, session, () => NOW);
    await gate.call('refund_transaction', { transaction_id: ids.aminaRecent.capture, amount: '12.00' });
    expect(ledger.orders[0]!.refundedCents).toBe(1_200);
    expect(session.refundedCents).toBe(1_200);
  });
});
