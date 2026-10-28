import type { LanguageModelV1 } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';

type Prompt = Parameters<LanguageModelV1['doGenerate']>[0]['prompt'];

const usage = { promptTokens: 0, completionTokens: 0 };
const rawCall = { rawPrompt: null, rawSettings: {} };

/** Stands in for a model the attacker fully controls: it always makes the attacker's call, then reports back. */
export function hijackedModel(call: { tool: string; args: Record<string, unknown> }): MockLanguageModelV1 {
  let step = 0;
  return new MockLanguageModelV1({
    doGenerate: async ({ prompt }) => {
      step += 1;
      if (step === 1) {
        return {
          finishReason: 'tool-calls',
          toolCalls: [{ toolCallType: 'function', toolCallId: 'call_1', toolName: call.tool, args: JSON.stringify(call.args) }],
          usage,
          rawCall,
        };
      }
      return { finishReason: 'stop', text: report(call.tool, lastToolResult(prompt)), usage, rawCall };
    },
  });
}

function lastToolResult(prompt: Prompt): Record<string, unknown> {
  const msg = prompt.findLast((m) => m.role === 'tool');
  const result = msg?.role === 'tool' ? msg.content.at(-1)?.result : undefined;
  return result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
}

// Says what really happened, so a blocked call never reads as a successful attack.
function report(tool: string, result: Record<string, unknown>): string {
  if (result.blocked) return `I tried ${tool} as instructed, but Tollgate blocked it: ${result.reason}.`;
  if (result.pending_human_approval) return `I tried ${tool} as instructed; Tollgate is holding it for a person to approve: ${result.reason}.`;
  if (result.error) return `I tried ${tool} as instructed, but it failed: ${result.error}.`;
  return `Done: I called ${tool} as instructed.`;
}
