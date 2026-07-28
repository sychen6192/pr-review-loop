// Model runner: one OpenAI-compatible adapter covering LiteLLM proxy, vLLM and Ollama.
// The core imports this interface only — swapping runtimes never touches pipeline code
// (design principle: runtime adapter).
import {
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_MAX_TOKENS,
  LLM_STRUCTURED_OUTPUT,
  LLM_TEMPERATURE,
  LLM_TIMEOUT_MS,
  RUNNER_KIND,
} from "../config";
import { logVerbose } from "../libs/log";
import type { ChatRequest, ChatResponse, ModelRunner } from "../libs/types";

interface OpenAIChoice {
  message?: { content?: string | null };
  finish_reason?: string;
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
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        return { text: "", model: req.model, error: `HTTP ${res.status}: ${text.slice(0, 500)}` };
      }
      let parsed: OpenAIResponse;
      try {
        parsed = JSON.parse(text) as OpenAIResponse;
      } catch {
        return { text: "", model: req.model, error: `回應非 JSON：${text.slice(0, 500)}` };
      }
      if (parsed.error?.message) {
        return { text: "", model: req.model, error: parsed.error.message };
      }
      const content = parsed.choices?.[0]?.message?.content ?? "";
      const secs = Math.round((Date.now() - started) / 1000);
      logVerbose(
        `${req.model} 回應 ${content.length} 字元、${secs}s` +
          (parsed.usage ? `（in ${parsed.usage.prompt_tokens ?? "?"} / out ${parsed.usage.completion_tokens ?? "?"} tokens）` : ""),
      );
      return {
        text: content,
        model: req.model,
        promptTokens: parsed.usage?.prompt_tokens,
        completionTokens: parsed.usage?.completion_tokens,
      };
    } catch (e) {
      const msg = e instanceof Error && e.name === "AbortError"
        ? `逾時（${Math.round(LLM_TIMEOUT_MS / 1000)}s）`
        : String(e);
      return { text: "", model: req.model, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Runner factory. The opencode path is imported lazily so a missing opencode install never
 * affects the default HTTP path (and vice versa).
 */
export async function createRunner(): Promise<ModelRunner> {
  if (RUNNER_KIND === "opencode") {
    const { OpencodeRunner } = await import("./opencode");
    return new OpencodeRunner();
  }
  return new OpenAICompatRunner();
}
