import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModelV1 } from 'ai';

// Gemma on the Gemini API: multi-step tool calls work with this SDK version, which does not send the thought signatures Gemini 3.x requires.
export const DEFAULT_GEMINI_MODEL = 'gemma-4-31b-it';

export function geminiModel(env: NodeJS.ProcessEnv = process.env): LanguageModelV1 {
  if (!env.GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY. Get a free key at https://aistudio.google.com/apikey and add it to .env.');
  return createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY })(env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);
}
