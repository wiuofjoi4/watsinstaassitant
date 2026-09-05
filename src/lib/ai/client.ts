import OpenAI from "openai";

let __client: OpenAI | null = null;

export type Provider = "gemini" | "openai";

export function getProvider(): Provider | null {
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

export function getOpenAI(): OpenAI | null {
  const provider = getProvider();
  if (!provider) return null;
  if (!__client) {
    __client =
      provider === "gemini"
        ? new OpenAI({
            apiKey: process.env.GEMINI_API_KEY,
            baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
          })
        : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return __client;
}

export const AGENT_MODEL = process.env.AGENT_MODEL ?? "gpt-4o";
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
export const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL ?? "whisper-1";

export function getAgentModel(): string {
  return getProvider() === "gemini" ? GEMINI_MODEL : AGENT_MODEL;
}

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  audioSeconds: number
): number {
  const inPerM = 2.5;
  const outPerM = 10;
  const perSec = 0.006 / 60;
  return (
    (inputTokens / 1_000_000) * inPerM +
    (outputTokens / 1_000_000) * outPerM +
    audioSeconds * perSec
  );
}