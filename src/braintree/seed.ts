import type braintree from 'braintree';
import type { Customer, PaidOrder } from '../shop/types.js';

// Braintree test nonces vault a fake card; no real money moves in the sandbox.
const DEMO_CUSTOMERS = [
  { id: 'cus_amina', name: 'Amina', email: 'amina@example.test', nonce: 'fake-valid-visa-nonce' },
  { id: 'cus_bilal', name: 'Bilal', email: 'bilal@example.test', nonce: 'fake-valid-mastercard-nonce' },
];

/** The demo shop's payments: Amina's shawl and mug orders, Bilal's rug. */
const DEMO_CHARGES: { customerId: string; dollars: number }[] = [
  { customerId: 'cus_amina', dollars: 57 },
  { customerId: 'cus_amina', dollars: 17 },
  { customerId: 'cus_bilal', dollars: 185 },
];

/** Vaults the demo customers under fixed IDs, reusing them if they already exist, so restarting a host never piles up copies. */
export async function vaultDemoCustomers(gateway: braintree.BraintreeGateway): Promise<Customer[]> {
  const customers: Customer[] = [];
  for (const c of DEMO_CUSTOMERS) {
    const existing = await findCustomer(gateway, c.id);
    let token = existing?.paymentMethods?.[0]?.token;
    if (!existing) {
      const created = await gateway.customer.create({ id: c.id, firstName: c.name, lastName: 'Demo', email: c.email, paymentMethodNonce: c.nonce });
      if (!created.success) throw new Error(`vaulting ${c.name}: ${created.message}`);
      token = created.customer.paymentMethods?.[0]?.token;
    } else if (!token) {
      // The customer exists but its card was removed, e.g. in the control panel.
      const card = await gateway.paymentMethod.create({ customerId: c.id, paymentMethodNonce: c.nonce });
      if (!card.success) throw new Error(`vaulting ${c.name}: ${card.message}`);
      token = card.paymentMethod.token;
    }
    if (!token) throw new Error(`vaulting ${c.name}: no payment method token`);
    customers.push({ id: c.id, name: c.name, email: c.email, paymentMethodToken: token });
  }
  return customers;
}

async function findCustomer(gateway: braintree.BraintreeGateway, id: string): Promise<braintree.Customer | null> {
  try {
    return await gateway.customer.find(id);
  } catch (err) {
    if ((err as { type?: string }).type === 'notFoundError') return null;
    throw err;
  }
}

/**
 * Fresh settled sandbox payments for one demo conversation, so refunds in one conversation never use up another's.
 * The cents vary because Braintree rejects an identical charge on the same card within minutes.
 */
export async function seedDemoOrders(gateway: braintree.BraintreeGateway, customers: Customer[]): Promise<PaidOrder[]> {
  return Promise.all(
    DEMO_CHARGES.map(async ({ customerId, dollars }) => {
      const customer = customers.find((c) => c.id === customerId);
      if (!customer?.paymentMethodToken) throw new Error(`${customerId} has no vaulted card; run npm run seed:braintree`);
      let amount = '';
      let sale;
      for (let attempt = 0; attempt < 4; attempt++) {
        amount = (dollars + Math.floor(Math.random() * 100) / 100).toFixed(2);
        sale = await gateway.transaction.sale({ amount, paymentMethodToken: customer.paymentMethodToken, options: { submitForSettlement: true } });
        if (sale.success || !/duplicate/i.test(sale.message)) break;
      }
      if (!sale?.success) throw new Error(`charging ${customer.name} $${amount}: ${sale?.message}`);
      // Refunds need a settled transaction; the sandbox settles on demand.
      await gateway.testing.settle(sale.transaction.id);
      return {
        orderId: sale.transaction.id,
        captureId: sale.transaction.id,
        customerId,
        totalCents: Math.round(Number(amount) * 100),
        refundedCents: 0,
        capturedAt: new Date(sale.transaction.createdAt).toISOString(),
      };
    }),
  );
}
