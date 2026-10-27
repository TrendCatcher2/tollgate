import { existsSync, readFileSync } from 'node:fs';
import type { Ledger } from './types.js';

/** Real sandbox payments created by `npm run seed:braintree`; gitignored because the tokens belong to one sandbox. */
export const LIVE_LEDGER_PATH = 'data/ledger.local.json';

export function loadLiveLedger(): Ledger | null {
  if (!existsSync(LIVE_LEDGER_PATH)) return null;
  return (JSON.parse(readFileSync(LIVE_LEDGER_PATH, 'utf8')) as { ledger: Ledger }).ledger;
}
