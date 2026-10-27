import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '../src/eval/adapters.js';
import { hijackedModel } from '../src/eval/hijacked-model.js';
import { runScenario } from '../src/eval/run.js';

for (const adapter of Object.values(ADAPTERS)) {
  describe(`${adapter.flavor} support agent with a hijacked model`, () => {
    for (const scenario of adapter.scenarios) {
      it(`${scenario.id}: ${scenario.attack ? 'harm reaches the backend only without Tollgate' : 'still completes with Tollgate'}`, async () => {
        const naive = await runScenario(adapter, scenario, 'naive', hijackedModel(scenario.hijackedCall));
        const guarded = await runScenario(adapter, scenario, 'guarded', hijackedModel(scenario.hijackedCall));
        expect(naive.reachedBackend).toBe(true);
        expect(guarded.reachedBackend).toBe(!scenario.attack);
      });
    }
  });
}
