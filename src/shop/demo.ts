import type { Policy, Session } from '../guard/policy.js';
import type { Ledger } from './types.js';

export const SHOP_NAME = 'Kech Crafts';

/** Which payment tools the shop's agent holds: Braintree, or the PayPal Agent Toolkit (Orders API). */
export type Flavor = 'braintree' | 'toolkit';

const TOOLS: Record<Flavor, Pick<Policy, 'allowedTools' | 'reviewTools'>> = {
  braintree: { allowedTools: ['charge_saved_card', 'refund_transaction', 'find_transaction'], reviewTools: ['accept_dispute'] },
  toolkit: { allowedTools: ['create_order', 'create_refund', 'get_order'], reviewTools: ['accept_dispute_claim'] },
};

export function demoPolicy(flavor: Flavor = 'braintree', shopOrigin = 'http://localhost:8787'): Policy {
  return {
    ...TOOLS[flavor],
    currency: 'USD',
    shopOrigin,
    taxPercent: 0,
    shippingCents: 500,
    maxOrderTotalCents: 20_000,
    autoRefundLimitCents: 5_000,
    refundWindowDays: 30,
    sessionRefundBudgetCents: 8_000,
    maxMoneyCallsPerSession: 5,
  };
}

/** Payment ids in each backend's format: Braintree transactions, or PayPal order and capture ids. */
export const DEMO_IDS = {
  braintree: {
    aminaRecent: { order: 'k8f3m2qa', capture: 'k8f3m2qa' },
    aminaOld: { order: 'p2x9d4tn', capture: 'p2x9d4tn' },
    bilal: { order: 'r7c5w1zb', capture: 'r7c5w1zb' },
  },
  toolkit: {
    aminaRecent: { order: '5O190127TN364715T', capture: '3C679366HH908993F' },
    aminaOld: { order: '8MC585209K746392H', capture: '7TK53561YB803214S' },
    bilal: { order: '1AB23456CD7890123', capture: '9XY87654ZW3210987' },
  },
} as const;

/** Sample shop records; a fresh copy per conversation so runs never leak state into each other. */
export function demoLedger(now = new Date(), flavor: Flavor = 'braintree'): Ledger {
  const ids = DEMO_IDS[flavor];
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  return {
    catalog: [
      { sku: 'SHAWL', name: 'Balochi embroidered shawl', priceCents: 4_500, maxQty: 3 },
      { sku: 'MUG', name: 'Clay chai mug', priceCents: 1_200, maxQty: 6 },
      { sku: 'RUG', name: 'Hand-knotted rug', priceCents: 18_000, maxQty: 1 },
    ],
    customers: [
      { id: 'cus_amina', name: 'Amina', email: 'amina@example.test', paymentMethodToken: 'tok_amina' },
      { id: 'cus_bilal', name: 'Bilal', email: 'bilal@example.test', paymentMethodToken: 'tok_bilal' },
    ],
    orders: [
      { orderId: ids.aminaRecent.order, captureId: ids.aminaRecent.capture, customerId: 'cus_amina', totalCents: 5_700, refundedCents: 0, capturedAt: daysAgo(7) },
      { orderId: ids.aminaOld.order, captureId: ids.aminaOld.capture, customerId: 'cus_amina', totalCents: 1_700, refundedCents: 0, capturedAt: daysAgo(90) },
      { orderId: ids.bilal.order, captureId: ids.bilal.capture, customerId: 'cus_bilal', totalCents: 18_500, refundedCents: 0, capturedAt: daysAgo(2) },
    ],
  };
}

export function demoSession(customerId: string | null = 'cus_amina'): Session {
  return { customerId, refundedCents: 0, moneyCalls: 0 };
}
