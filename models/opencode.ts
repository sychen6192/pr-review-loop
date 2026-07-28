// OpencodeRunner: drive models through the opencode CLI instead of raw HTTP.
//
// Why this exists: the team already runs opencode, so provider credentials, model aliases
// and proxy setup live there. Going through it means prloop inherits that configuration
// instead of duplicating it.
//
// One consequence is load-bearing and must not be forgotten: **opencode does not pass
// `response_format` through to the engine**, so guided decoding (vLLM/xgrammar) is not
// available on this path. Schema conformity drops from "enforced at the token layer" to
// "asked for in the prompt". We compensate by injecting the schema as text and retrying
// once on a parse failure — but a weak model will still comply less reliably here than on
// the openai path. Prefer the openai runner when the endpoint supports guided decoding.
import { spawn } from "node:child_process";
import {
  AGENT_TIMEOUT_MS,
  OPENCODE_AGENT,
  OPENCODE_BIN,
  OPENCODE_JSON_EVENTS,
  PRLOOP_ROOT,
} from "../config";
import { log, logVerbose, startHeartbeat } from "../libs/log";
import type { ChatRequest, ChatResponse, ModelRunner } from "../libs/types";

interface Acc {
  text: string;
  lastText: string;
}

// Parses one JSONL event. The real event kind lives in part.type (hyphenated); the outer
// ev.type is an unreliable envelope label. Accepts both hyphen and underscore forms.
export function traceEvent(line: string, prefix: string, acc: Acc): void {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // non-JSON diagnostic noise
  }
  const part = (ev["part"] ?? {}) as Record<string, unknown>;
  const kind = String(part["type"] ?? ev["type"] ?? "").replace(/_/g, "-");

  if (kind === "text") {
    const t = String(part["text"] ?? "");
    if (!t) return;
    acc.text += t;
    // Models often emit the final JSON as the last complete text part; keep it as a fallback
    // in case the accumulated stream is polluted by preamble.
    acc.lastText = t;
    const oneLine = t.replace(/\s+/g, " ").trim();
    if (oneLine) logVerbose(`${prefix} ${oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine}`);
  } else if (kind === "step-finish") {
    const tokens = (part["tokens"] ?? {}) as Record<string, unknown>;
    if (tokens["output"] !== undefined) {
      logVerbose(`${prefix} -- step 結束（output tokens=${String(tokens["output"])}）`);
    }
  } else if (kind === "error") {
    logVerbose(`${prefix} [WARN] ${JSON.stringify(ev).slice(0, 300)}`);
  }
}

/** opencode can't enforce a schema, so it goes into the prompt instead. */
export function inlineSchema(req: ChatRequest): string {
  if (!req.schema) return req.user;
  return `${req.user}

## 輸出格式（務必嚴格遵守）

只輸出一個 JSON 物件，符合以下 JSON Schema。不要輸出任何說明文字、不要用 markdown
程式碼區塊包起來、不要在 JSON 前後加任何內容。

\`\`\`json
${JSON.stringify(req.schema, null, 2)}
\`\`\``;
}

function runOnce(label: string, model: string, prompt: string): Promise<ChatResponse> {
  return new Promise((resolve) => {
    log(`[${label}] opencode session 啟動（model=${model || "（agent 預設）"}）`);
    const stopHeartbeat = startHeartbeat(`[${label}]`);
    const started = Date.now();

    const args = ["run", "--agent", OPENCODE_AGENT];
    if (model) args.push("--model", model);
    if (OPENCODE_JSON_EVENTS) args.push("--format", "json");
    args.push(prompt); // positional, last

    const child = spawn(OPENCODE_BIN, args, {
      cwd: PRLOOP_ROOT,
      env: process.env,
      // opencode >= 1.17 waits for stdin EOF when stdin is piped.
      stdio: ["ignore", "pipe", "pipe"],
    });

    const acc: Acc = { text: "", lastText: "" };
    let rawStdout = "";
    let stdoutBuf = "";
    let spawnError: string | undefined;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      rawStdout += chunk;
      stdoutBuf += chunk;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? ""; // keep the partial line for the next chunk
      for (const line of lines) if (line.trim()) traceEvent(line, `[${label}]`, acc);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.trim().split("\n")) if (line.trim()) logVerbose(`[${label}] ${line}`);
    });

    let killEscalation: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      logVerbose(`[${label}] 逾時 ${AGENT_TIMEOUT_MS}ms，送出 SIGTERM`);
      child.kill("SIGTERM");
      killEscalation = setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, AGENT_TIMEOUT_MS);

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killEscalation) clearTimeout(killEscalation);
      stopHeartbeat();
      if (stdoutBuf.trim()) traceEvent(stdoutBuf, `[${label}]`, acc); // flush partial line

      const secs = Math.round((Date.now() - started) / 1000);
      const text = OPENCODE_JSON_EVENTS ? (acc.text.trim() ? acc.text : acc.lastText) : rawStdout;
      if (spawnError) {
        resolve({ text: "", model, error: spawnError });
        return;
      }
      log(`[${label}] 完成（耗時 ${secs} 秒、${text.length} 字元）`);
      resolve({ text, model });
    };

    child.on("close", finish);
    child.on("error", (err) => {
      spawnError = `opencode 啟動失敗：${err.message}（確認 opencode CLI 已安裝，或設 PRR_OPENCODE_BIN）`;
      logVerbose(`[${label}] ${spawnError}`);
      finish();
    });
  });
}

export class OpencodeRunner implements ModelRunner {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    // opencode has no separate system-message channel here; the role contract lives in the
    // agent .md and everything task-specific is injected into the prompt (the
    // \"injection over discovery\" principle: a loop cannot depend on probabilistic skill loading).
    const prompt = `${req.system}\n\n---\n\n${inlineSchema(req)}`;
    const label = req.schemaName ?? "opencode";
    return runOnce(label, req.model, prompt);
  }
}
