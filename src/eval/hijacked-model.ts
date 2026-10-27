import { MockLanguageModelV1 } from 'ai/test';

const usage = { promptTokens: 0, completionTokens: 0 };
const rawCall = { rawPrompt: null, rawSettings: {} };

/** Stands in for a model the attacker fully controls: it always makes the attacker's call, then reports back. */
export function hijackedModel(call: { tool: string; args: Record<string, unknown> }): MockLanguageModelV1 {
  let step = 0;
  return new MockLanguageModelV1({
    doGenerate: async () => {
      step += 1;
      if (step === 1) {
        return {
          finishReason: 'tool-calls',
          toolCalls: [{ toolCallType: 'function', toolCallId: 'call_1', toolName: call.tool, args: JSON.stringify(call.args) }],
          usage,
          rawCall,
        };
      }
      return { finishReason: 'stop', text: `Done: I called ${call.tool} as instructed.`, usage, rawCall };
    },
  });
}
