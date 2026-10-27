// Proves the Braintree sandbox keys work end to end: vault a test card, charge it, settle it, refund part of it.
import { existsSync } from 'node:fs';
import { sandboxGateway } from '../src/braintree/gateway.js';

if (existsSync('.env')) process.loadEnvFile('.env');
let gateway;
try {
  gateway = sandboxGateway();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const fail = (step: string, message: string) => {
  console.error(`${step} failed: ${message}`);
  process.exit(1);
};

const customer = await gateway.customer.create({ firstName: 'Smoke', lastName: 'Test', paymentMethodNonce: 'fake-valid-visa-nonce' });
if (!customer.success) fail('1. Vault test card', customer.message);
const token = customer.customer.paymentMethods?.[0]?.token;
if (!token) fail('1. Vault test card', 'no payment method token returned');
console.log(`1. Vaulted test card  -> customer ${customer.customer.id}`);

// Braintree rejects an identical charge on the same card within minutes, so vary the cents per run.
const amount = (10 + Math.floor(Math.random() * 500) / 100).toFixed(2);
const sale = await gateway.transaction.sale({ amount, paymentMethodToken: token!, options: { submitForSettlement: true } });
if (!sale.success) fail(`2. Charge $${amount}`, sale.message);
console.log(`2. Charged $${amount}     -> transaction ${sale.transaction.id} (${sale.transaction.status})`);

// The testing gateway returns the raw transaction, not a validated response.
const settled = (await gateway.testing.settle(sale.transaction.id)) as unknown as { transaction?: { status: string } };
if (settled.transaction?.status !== 'settled') fail('3. Settle', `status ${settled.transaction?.status}`);
console.log(`3. Settled            -> ${settled.transaction!.status}`);

const refund = await gateway.transaction.refund(sale.transaction.id, '1.00');
if (!refund.success) fail('4. Refund $1.00', refund.message);
console.log(`4. Refunded $1.00     -> refund ${refund.transaction.id} (${refund.transaction.status})`);
