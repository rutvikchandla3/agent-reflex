// Minimal, dependency-free client for TypeSafe's System One API (Jev).
// Docs: https://docs.typesafe.ai/api

export type Structured = string | Record<string, unknown> | unknown[];

export type NoulQuestion = {
  type: "noul";
  instructions: Structured;
  criteria?: { true?: Structured; false?: Structured };
};
export type ChoiceQuestion = {
  type: "choice";
  instructions: Structured;
  criteria: Record<string, Structured | null>;
};
export type ScoreQuestion = {
  type: "score";
  instructions: Structured;
  criteria: Structured[];
};
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type SystemOneResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
};

export type JevOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export class JevError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "JevError";
  }
}

export function resolveApiKey(explicit?: string): string | undefined {
  return explicit ?? process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

export async function systemOne(
  state: Structured,
  questions: Record<string, Question>,
  opts: JevOptions = {},
): Promise<SystemOneResponse> {
  const apiKey = resolveApiKey(opts.apiKey);
  if (!apiKey) throw new JevError("No API key: set TYPESAFE_API_KEY (or JEV_API_KEY).");

  const url = `${opts.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai"}/v1/systemone`;
  const body = JSON.stringify({ state, questions, model: opts.model ?? "jev-latest" });
  const maxRetries = opts.maxRetries ?? 2;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
      });
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw new JevError(`Request to Jev failed: ${(err as Error).message}`);
    }

    if (res.ok) return (await res.json()) as SystemOneResponse;

    if (RETRYABLE.has(res.status) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      continue;
    }
    const detail = await res.text().catch(() => "");
    throw new JevError(`Jev returned ${res.status}: ${detail.slice(0, 300)}`, res.status);
  }
}

const backoff = (attempt: number) => 250 * 2 ** attempt + Math.random() * 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
