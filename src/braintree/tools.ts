import { tool, type Tool } from 'ai';
import type braintree from 'braintree';
import { z } from 'zod';
import { formatCents, toCents } from '../guard/money.js';
import type { Session } from '../guard/policy.js';
import type { Ledger } from '../shop/types.js';

/** The Braintree operations the support agent's tools need. */
export interface BraintreeBackend {
  charge(amount: string, paymentMethodToken: string): Promise<{ id: string; status: string; amount: string }>;
  refund(transactionId: string, amount?: string): Promise<{ id: string; status: string; amount: string }>;
  find(transactionId: string): Promise<Record<string, unknown>>;
  acceptDispute(disputeId: string): Promise<{ status: string }>;
}

/** Braintree sandbox; new charges are settled immediately so refunds can follow. */
export function liveBackend(gateway: braintree.BraintreeGateway): BraintreeBackend {
  return {
    async charge(amount, paymentMethodToken) {
      const r = await gateway.transaction.sale({ amount, paymentMethodToken, options: { submitForSettlement: true } });
      if (!r.success) throw new Error(r.message);
      // Sandbox only: settle now so the customer can ask for a refund in the same conversation.
      const settled = (await gateway.testing.settle(r.transaction.id)) as unknown as { transaction?: { status: string } };
      return { id: r.transaction.id, status: settled.transaction?.status ?? r.transaction.status, amount: r.transaction.amount };
    },
    async refund(transactionId, amount) {
      const r = await gateway.transaction.refund(transactionId, amount);
      if (!r.success) throw new Error(r.message);
      return { id: r.transaction.id, status: r.transaction.status, amount: r.transaction.amount };
    },
    async find(transactionId) {
      const t = await gateway.transaction.find(transactionId);
      return {
        id: t.id,
        status: t.status,
        amount: t.amount,
        createdAt: t.createdAt,
        customer: { firstName: t.customer?.firstName, lastName: t.customer?.lastName, email: t.customer?.email },
        card: { last4: t.creditCard?.last4, cardType: t.creditCard?.cardType },
      };
    },
    async acceptDispute(disputeId) {
      const r = await gateway.dispute.accept(disputeId);
      if (!r.success) throw new Error(r.message);
      return { status: 'ACCEPTED' };
    },
  };
}

const item = z.object({
  name: z.string().describe('Catalog item name'),
  quantity: z.number().int().describe('Whole number of units'),
  itemCost: z.number().describe('Price of one unit in USD'),
  itemTotal: z.number().describe('itemCost x quantity in USD'),
});

/**
 * Support-agent tools over Braintree. The card charged is always the signed-in customer's own vaulted card,
 * looked up from the shop's records, so no tool argument can pick whose money moves.
 */
export function braintreeTools(backend: BraintreeBackend, shop: { ledger: Ledger; session: Session }, clock: () => Date = () => new Date()): Record<string, Tool> {
  return {
    charge_saved_card: tool({
      description: "Charge the signed-in customer's saved card for catalog items plus shipping. Returns the Braintree transaction.",
      parameters: z.object({
        items: z.array(item),
        shippingCost: z.number().describe('Shipping in USD'),
        discount: z.number().optional().describe('Discount in USD, if any'),
      }),
      execute: async ({ items, shippingCost, discount }) => {
        const customer = shop.ledger.customers.find((c) => c.id === shop.session.customerId);
        if (!customer?.paymentMethodToken) throw new Error('the customer has no saved card');
        const cents = items.reduce((sum, i) => sum + (toCents(i.itemTotal) ?? 0), 0) + (toCents(shippingCost) ?? 0) - (toCents(discount ?? 0) ?? 0);
        if (cents <= 0) throw new Error('charge amount must be positive');
        const tx = await backend.charge((cents / 100).toFixed(2), customer.paymentMethodToken);
        shop.ledger.orders.push({ orderId: tx.id, captureId: tx.id, customerId: customer.id, totalCents: cents, refundedCents: 0, capturedAt: clock().toISOString() });
        return { transaction_id: tx.id, status: tx.status, amount: formatCents(cents) };
      },
    }),
    refund_transaction: tool({
      description: 'Refund a settled Braintree transaction, fully or partially.',
      parameters: z.object({
        transaction_id: z.string().describe('Braintree transaction id'),
        amount: z.string().optional().describe('Amount to refund in USD, e.g. "12.00". Omit for a full refund.'),
      }),
      execute: async ({ transaction_id, amount }) => {
        const r = await backend.refund(transaction_id, amount);
        return { refund_id: r.id, status: r.status, amount: r.amount };
      },
    }),
    find_transaction: tool({
      description: 'Look up a Braintree transaction: status, amount, date, customer and card.',
      parameters: z.object({ transaction_id: z.string().describe('Braintree transaction id') }),
      execute: async ({ transaction_id }) => backend.find(transaction_id),
    }),
    accept_dispute: tool({
      description: 'Accept a Braintree dispute (chargeback), giving the money back to the cardholder.',
      parameters: z.object({ dispute_id: z.string().describe('Braintree dispute id') }),
      execute: async ({ dispute_id }) => backend.acceptDispute(dispute_id),
    }),
  };
}

/** An in-memory Braintree for tests and offline evals. */
export function fakeBackend(): BraintreeBackend {
  let n = 0;
  const id = () => `fake${String(++n).padStart(4, '0')}`;
  return {
    charge: async (amount) => ({ id: id(), status: 'submitted_for_settlement', amount }),
    refund: async (_transactionId, amount) => ({ id: id(), status: 'submitted_for_settlement', amount: amount ?? 'full' }),
    find: async (transactionId) => ({ id: transactionId, status: 'settled', customer: { firstName: 'Bilal', email: 'bilal@example.test' } }),
    acceptDispute: async () => ({ status: 'ACCEPTED' }),
  };
}
