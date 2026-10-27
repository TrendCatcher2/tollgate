// Starts the demo: chat with the support agent, switch Tollgate on and off, approve or reject held payments.
import { existsSync } from 'node:fs';
import { geminiModel } from '../src/agent/model.js';
import { sandboxGateway } from '../src/braintree/gateway.js';
import { seedDemoOrders } from '../src/braintree/seed.js';
import { liveBackend } from '../src/braintree/tools.js';
import { Conversations } from '../src/server/conversations.js';
import { createDemoServer } from '../src/server/http.js';
import { LIVE_LEDGER_PATH, loadLiveLedger } from '../src/shop/live.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;
geminiModel(env); // fail fast without a key

const ledger = loadLiveLedger();
const hasBraintree = Boolean(env.BRAINTREE_MERCHANT_ID && env.BRAINTREE_PUBLIC_KEY && env.BRAINTREE_PRIVATE_KEY);
const gateway = hasBraintree ? sandboxGateway(env) : null;
const live = ledger && gateway ? { backend: liveBackend(gateway), ledger, seedOrders: () => seedDemoOrders(gateway, ledger.customers) } : null;
if (!live) console.log(`No ${hasBraintree ? LIVE_LEDGER_PATH : 'Braintree keys'}; using the offline stand-in. Run npm run seed:braintree for live sandbox payments.`);

const convos = new Conversations({ model: () => geminiModel(env), live });
const server = createDemoServer(
  convos,
  {
    perVisitor: Number(env.DEMO_TURNS_PER_VISITOR ?? 20),
    windowMs: 10 * 60_000,
    perDay: Number(env.DEMO_TURNS_PER_DAY ?? 300),
    disabled: env.DEMO_DISABLED === '1',
  },
  new URL('../public/index.html', import.meta.url).pathname,
);
const port = Number(env.PORT ?? 8787);
server.listen(port, () => console.log(`Tollgate demo on http://localhost:${port} (${convos.backendLabel})`));
