// Model runner: one OpenAI-compatible adapter covering LiteLLM proxy, vLLM and Ollama.
// The core imports this interface only — swapping runtimes never touches pipeline code
// (design principle: runtime adapter).
import {
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_MAX_TOKENS,
  LLM_STRUCTURED_OUTPUT,
  LLM_TEMPERATURE,
  LLM_CONCURRENCY,
  LLM_RETRIES,
  LLM_TIMEOUT_MS,
  RUNNER_KIND,
} from "../config";
import { Semaphore } from "../libs/limit";
import { logVerbose } from "../libs/log";
import { USER_AGENT, dispatcherFor } from "../libs/proxy";
import type { ChatRequest, ChatResponse, ModelRunner } from "../libs/types";

interface OpenAIChoice {
  // `reasoning` is where thinking models put their chain of thought; the answer stays in
  // `content`. It is never used as output, only to explain where the token budget went.
  message?: { content?: string | null; reasoning?: string | null };
  finish_reason?: string;
}
/**
 * "TypeError: fetch failed" is undici hiding the real error in `cause` (often two levels
 * deep). Surfacing the code chain is the difference between a diagnosable log line and a
 * shrug — a production failure at exactly 301s only became explainable once the cause
 * (UND_ERR_HEADERS_TIMEOUT) was visible.
 */
export function describeFetchError(e: unknown, timeoutMs: number): string {
  if (e instanceof Error && e.name === "AbortError") {
    return `timeout (${Math.round(timeoutMs / 1000)}s)`;
  }
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    const code = (cur as NodeJS.ErrnoException).code;
    parts.push(code ? `${cur.message} [${code}]` : cur.message);
    cur = cur.cause;
  }
  return parts.length > 0 ? parts.join(" ← ") : String(e);
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAICompatRunner implements ModelRunner {
  constructor(
    private readonly baseUrl: string = LLM_BASE_URL,
    private readonly apiKey: string = LLM_API_KEY,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      temperature: req.temperature ?? LLM_TEMPERATURE,
      max_tokens: req.maxTokens ?? LLM_MAX_TOKENS,
      stream: false,
    };
    if (req.schema && LLM_STRUCTURED_OUTPUT) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: req.schemaName ?? "output", schema: req.schema, strict: true },
      };
    }

    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const ctrl = new AbortController();
    const timeoutMs = req.timeoutMs ?? LLM_TIMEOUT_MS;
    // Started here, after the concurrency slot was acquired: time spent queued behind other
    // calls must not count against this request's own deadline.
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        // An internal model endpoint usually must NOT go through the external proxy;
        // list its host in NO_PROXY and dispatcherFor returns undefined for it.
        dispatcher: dispatcherFor(url),
      } as RequestInit);
      const text = await res.text();
      if (!res.ok) {
        return { text: "", model: req.model, error: `HTTP ${res.status}: ${text.slice(0, 500)}` };
      }
      let parsed: OpenAIResponse;
      try {
        parsed = JSON.parse(text) as OpenAIResponse;
      } catch {
        return { text: "", model: req.model, error: `response is not JSON: ${text.slice(0, 500)}` };
      }
      if (parsed.error?.message) {
        return { text: "", model: req.model, error: parsed.error.message };
      }
      const choice = parsed.choices?.[0];
      const content = choice?.message?.content ?? "";
      const reasoned = (choice?.message?.reasoning ?? "").length;

      const bad = describeBadCompletion(choice, req.maxTokens ?? LLM_MAX_TOKENS);
      if (bad) return { text: content, model: req.model, error: bad };

      const secs = Math.round((Date.now() - started) / 1000);
      logVerbose(
        `${req.model} replied ${content.length} chars, ${secs}s` +
          (reasoned > 0 ? ` (+${reasoned} chars reasoning)` : "") +
          (parsed.usage ? ` (in ${parsed.usage.prompt_tokens ?? "?"} / out ${parsed.usage.completion_tokens ?? "?"} tokens)` : ""),
      );
      return {
        text: content,
        model: req.model,
        promptTokens: parsed.usage?.prompt_tokens,
        completionTokens: parsed.usage?.completion_tokens,
      };
    } catch (e) {
      return { text: "", model: req.model, error: describeFetchError(e, timeoutMs) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Reports a completion that arrived successfully but is unusable, or undefined if it's fine.
 *
 * Truncation is a different failure from bad output and needs a different fix. Left
 * unlabelled it surfaces downstream as "output unparseable", which sends people to inspect
 * the prompt or the schema when the real answer is "raise the token limit".
 *
 * Thinking models make this the common case rather than an edge case: chain of thought is
 * billed to the same budget as the answer. A measured run on a self-hosted 27B thinking
 * model spent 7842 of 8192 tokens, most of it in `reasoning` — 4% of headroom away from
 * silently returning zero findings.
 */
export function describeBadCompletion(
  choice: { message?: { content?: string | null; reasoning?: string | null }; finish_reason?: string } | undefined,
  maxTokens: number,
): string | undefined {
  const content = choice?.message?.content ?? "";
  const reasoned = (choice?.message?.reasoning ?? "").length;
  const reasoningNote =
    reasoned > 0 ? `. The model emitted ${reasoned} chars of reasoning, billed to the same budget` : "";

  if (choice?.finish_reason === "length") {
    return `response truncated at the token limit (${maxTokens}); raise PRR_LLM_MAX_TOKENS${reasoningNote}`;
  }
  if (!content.trim()) {
    return reasoned > 0
      ? `model returned only reasoning (${reasoned} chars) and no answer; raise PRR_LLM_MAX_TOKENS`
      : "model returned an empty response";
  }
  return undefined;
}

/**
 * True for failures where the same request may well succeed on a second attempt.
 *
 * Deliberately conservative in both directions: an HTTP 4xx is the backend saying the
 * request itself is wrong (408/429 excepted — those are about timing), and a completion
 * that arrived but was unusable (truncated at the token limit, empty, non-JSON body) is
 * DETERMINISTIC — the retry burns a second full-length call to reproduce the identical
 * failure. Only network/5xx/timeout classes are worth a second attempt.
 */
export function isTransientModelError(error: string): boolean {
  if (/^HTTP (4\d\d)/.test(error)) return /^HTTP (408|429)/.test(error);
  if (/truncated at the token limit|returned only reasoning|empty response|response is not JSON/.test(error)) {
    return false;
  }
  return true;
}

function withRetries(inner: ModelRunner, attempts: number): ModelRunner {
  if (attempts <= 0) return inner;
  return {
    async chat(req) {
      let last = await inner.chat(req);
      for (let i = 0; i < attempts && last.error && isTransientModelError(last.error); i++) {
        // Exponential backoff: an immediate retry against a 429 or a briefly-down endpoint
        // tends to collect the same answer.
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        logVerbose(`retrying ${req.model} after transient failure: ${last.error.slice(0, 160)}`);
        last = await inner.chat(req);
      }
      return last;
    },
  };
}

// ─── Token accounting ────────────────────────────────────────────────────────
// The adapter has always parsed usage out of the response; this is the one place every
// call passes through, so totals are collected here instead of threading counters
// through four gate modules. Read at the end of a run for the summary and artifacts.
export interface TokenTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}
const totals: TokenTotals = { calls: 0, promptTokens: 0, completionTokens: 0 };

export function tokenTotals(): TokenTotals {
  return { ...totals };
}

function counted(inner: ModelRunner): ModelRunner {
  return {
    async chat(req) {
      const res = await inner.chat(req);
      totals.calls += 1;
      totals.promptTokens += res.promptTokens ?? 0;
      totals.completionTokens += res.completionTokens ?? 0;
      return res;
    },
  };
}

/**
 * Caps concurrent calls across every stage at once.
 *
 * Applied here rather than at each call site so a single pool covers finders, the
 * requirement axis, the skeptic and triage — the stages overlap, and per-stage limits would
 * still let their sum swamp the endpoint.
 */
function throttled(inner: ModelRunner, limit: number): ModelRunner {
  if (limit <= 0) return inner;
  const sem = new Semaphore(limit);
  return {
    chat(req) {
      if (sem.inFlight >= limit) {
        logVerbose(`model calls at the ${limit} limit, queueing ${req.model} (${sem.waiting + 1} waiting)`);
      }
      return sem.run(() => inner.chat(req));
    },
  };
}

/**
 * Runner factory. The opencode path is imported lazily so a missing opencode install never
 * affects the default HTTP path (and vice versa).
 */
export async function createRunner(): Promise<ModelRunner> {
  const inner =
    RUNNER_KIND === "opencode"
      ? new (await import("./opencode")).OpencodeRunner()
      : new OpenAICompatRunner();
  // Throttle innermost: each retry attempt re-queues for a slot instead of one call holding
  // a slot for its whole retry sequence. Counting sits outermost: one record per logical
  // call, with the usage of whichever attempt finally answered (failed attempts carry no
  // usage data to count).
  return counted(withRetries(throttled(inner, LLM_CONCURRENCY), LLM_RETRIES));
}
