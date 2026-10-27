import type { Tool } from 'ai';
import { braintreeTools, fakeBackend } from '../braintree/tools.js';
import type { Policy, Session } from '../guard/policy.js';
import { offlinePaypalTools } from '../paypal/tools.js';
import { demoLedger, demoPolicy, demoSession, type Flavor } from '../shop/demo.js';
import type { Ledger } from '../shop/types.js';
import { BRAINTREE_SCENARIOS } from './scenarios-braintree.js';
import { TOOLKIT_SCENARIOS, type Scenario } from './scenarios.js';

export interface Shop {
  ledger: Ledger;
  policy: Policy;
  session: Session;
}

/** A payment backend the support agent can be given, answered offline. */
export interface Adapter {
  flavor: Flavor;
  scenarios: Scenario[];
  capabilities: string;
  /** The unguarded tools; the shop is passed so Braintree charges use the signed-in customer's card. */
  tools(shop: Shop, now: Date): Record<string, Tool>;
}

export const ADAPTERS: Record<Flavor, Adapter> = {
  braintree: {
    flavor: 'braintree',
    scenarios: BRAINTREE_SCENARIOS,
    capabilities: "You can charge the customer's saved card, look up transactions, issue refunds and handle disputes with the Braintree tools provided.",
    tools: (shop, now) => braintreeTools(fakeBackend(), shop, () => now),
  },
  toolkit: {
    flavor: 'toolkit',
    scenarios: TOOLKIT_SCENARIOS,
    capabilities: 'You can create PayPal checkouts, look up orders, issue refunds and handle disputes with the PayPal tools provided.',
    tools: () => offlinePaypalTools(),
  },
};

export function demoShop(flavor: Flavor, now: Date): Shop {
  return { ledger: demoLedger(now, flavor), policy: demoPolicy(flavor), session: demoSession() };
}
