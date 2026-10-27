import type { Policy, Session } from '../src/guard/policy.js';
import type { Ledger } from '../src/shop/types.js';

export const NOW = new Date('2026-11-01T12:00:00Z');

export function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    allowedTools: ['create_order', 'create_refund', 'get_order'],
    reviewTools: ['accept_dispute_claim'],
    currency: 'USD',
    shopOrigin: 'https://shop.example.test',
    taxPercent: 0,
    shippingCents: 500,
    maxOrderTotalCents: 20_000,
    autoRefundLimitCents: 5_000,
    refundWindowDays: 30,
    sessionRefundBudgetCents: 8_000,
    maxMoneyCallsPerSession: 5,
    ...overrides,
  };
}

export function makeLedger(): Ledger {
  return {
    catalog: [
      { sku: 'SHAWL', name: 'Balochi embroidered shawl', priceCents: 4_500, maxQty: 3 },
      { sku: 'MUG', name: 'Clay chai mug', priceCents: 1_200, maxQty: 6 },
      { sku: 'RUG', name: 'Hand-knotted rug', priceCents: 18_000, maxQty: 1 },
    ],
    customers: [
      { id: 'cus_amina', name: 'Amina', email: 'amina@example.test' },
      { id: 'cus_bilal', name: 'Bilal', email: 'bilal@example.test' },
    ],
    orders: [
      { orderId: '5O190127TN364715T', captureId: '3C679366HH908993F', customerId: 'cus_amina', totalCents: 5_700, refundedCents: 0, capturedAt: '2026-10-25T10:00:00Z' },
      { orderId: '8MC585209K746392H', captureId: '7TK53561YB803214S', customerId: 'cus_amina', totalCents: 1_700, refundedCents: 0, capturedAt: '2026-08-01T10:00:00Z' },
      { orderId: '1AB23456CD7890123', captureId: '9XY87654ZW3210987', customerId: 'cus_bilal', totalCents: 18_500, refundedCents: 0, capturedAt: '2026-10-30T10:00:00Z' },
    ],
  };
}

export function makeSession(customerId: string | null = 'cus_amina'): Session {
  return { customerId, refundedCents: 0, moneyCalls: 0 };
}

export const goodOrder = () => ({
  currencyCode: 'USD',
  items: [{ name: 'Clay chai mug', itemCost: 12, quantity: 2, taxPercent: 0, itemTotal: 24 }],
  discount: 0,
  shippingCost: 5,
  returnUrl: 'https://example.com/returnUrl',
  cancelUrl: 'https://example.com/cancelUrl',
});
