import type { Tool, ToolExecutionOptions } from 'ai';

export interface RecordedCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Wraps tools so every call that actually reaches the payment backend is recorded. */
export function recordCalls(tools: Record<string, Tool>): { tools: Record<string, Tool>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    wrapped[name] = {
      ...t,
      execute: async (args: Record<string, unknown>, options: ToolExecutionOptions) => {
        calls.push({ tool: name, args });
        return t.execute!(args, options);
      },
    } as Tool;
  }
  return { tools: wrapped, calls };
}
