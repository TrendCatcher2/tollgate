// Proves the sandbox credentials work end to end: guarded create_order through the PayPal Agent Toolkit.
import { existsSync } from 'node:fs';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { Tollgate } from '../src/guard/tollgate.js';
import type { Policy } from '../src/guard/policy.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET. Copy .env.example to .env and fill in your sandbox app credentials.');
  process.exit(1);
}

const toolkit = new PayPalAgentToolkit({
  clientId: PAYPAL_CLIENT_ID,
  clientSecret: PAYPAL_CLIENT_SECRET,
  configuration: { actions: { orders: { create: true, get: true } }, context: { sandbox: true } },
});

const policy: Policy = {
  allowedTools: ['create_order'],
  reviewTools: [],
  currency: 'USD',
  shopOrigin: 'http://localhost:8787',
  taxPercent: 0,
  shippingCents: 0,
  maxOrderTotalCents: 10_000,
  autoRefundLimitCents: 0,
  refundWindowDays: 30,
  sessionRefundBudgetCents: 0,
  maxMoneyCallsPerSession: 5,
};
const ledger = { catalog: [{ sku: 'MUG', name: 'Clay chai mug', priceCents: 1_200, maxQty: 6 }], customers: [], orders: [] };
const gate = new Tollgate(toolkit.getTools(), policy, ledger, { customerId: null, refundedCents: 0, moneyCalls: 0 });

const blocked = await gate.call('create_order', {
  currencyCode: 'USD',
  items: [{ name: 'Clay chai mug', itemCost: 0.01, quantity: 1, taxPercent: 0, itemTotal: 0.01 }],
});
console.log('1. Tampered price  ->', JSON.stringify(blocked));

const order = (await gate.call('create_order', {
  currencyCode: 'USD',
  items: [{ name: 'Clay chai mug', itemCost: 12, quantity: 1, taxPercent: 0, itemTotal: 12 }],
})) as { id?: string; status?: string; links?: { rel: string; href: string }[]; error?: string };

if (!order.id) {
  console.error('2. Catalog price   -> PayPal call failed:', order.error ?? order);
  process.exit(1);
}
const approve = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
console.log(`2. Catalog price   -> sandbox order ${order.id} (${order.status})`);
console.log(`   Approve as a sandbox buyer: ${approve ?? 'no approve link returned'}`);
