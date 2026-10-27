// Vaults the demo shop's customers in your Braintree sandbox, creates a first set of settled payments and saves them as the live ledger.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { sandboxGateway } from '../src/braintree/gateway.js';
import { seedDemoOrders, vaultDemoCustomers } from '../src/braintree/seed.js';
import { demoLedger } from '../src/shop/demo.js';
import { LIVE_LEDGER_PATH } from '../src/shop/live.js';
import type { Ledger } from '../src/shop/types.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const gateway = sandboxGateway();

const customers = await vaultDemoCustomers(gateway);
const ledger: Ledger = { catalog: demoLedger().catalog, customers, orders: await seedDemoOrders(gateway, customers) };
for (const o of ledger.orders) {
  console.log(`${ledger.customers.find((c) => c.id === o.customerId)!.name.padEnd(6)} $${(o.totalCents / 100).toFixed(2).padStart(6)} -> transaction ${o.orderId} (settled)`);
}

mkdirSync('data', { recursive: true });
writeFileSync(LIVE_LEDGER_PATH, JSON.stringify({ seededAt: new Date().toISOString(), ledger }, null, 2));
console.log(`\nSaved ${LIVE_LEDGER_PATH} (gitignored). The demo server creates fresh payments like these for every conversation.`);
