// Fail-closed JSON extraction from model output.
// Weak models wrap JSON in prose or fences even under a schema constraint; we recover what
// we safely can and reject the rest rather than letting malformed findings through.

export interface ParseOk<T> {
  ok: true;
  value: T;
}
export interface ParseFail {
  ok: false;
  error: string;
}
export type ParseResult<T> = ParseOk<T> | ParseFail;

/** Finds the first balanced JSON object/array in a string, ignoring braces inside strings. */
function extractBalanced(raw: string): string | undefined {
  const startIdx = (() => {
    const o = raw.indexOf("{");
    const a = raw.indexOf("[");
    if (o < 0) return a;
    if (a < 0) return o;
    return Math.min(o, a);
  })();
  if (startIdx < 0) return undefined;

  const open = raw[startIdx]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;

  for (let i = startIdx; i < raw.length; i++) {
    const c = raw[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return raw.slice(startIdx, i + 1);
    }
  }
  return undefined;
}

export function parseJsonObject<T = unknown>(raw: string): ParseResult<T> {
  if (!raw || raw.trim() === "") return { ok: false, error: "模型回傳空字串" };

  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    // Reasoning models sometimes emit a think block before the answer.
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();

  const direct = tryParse<T>(cleaned);
  if (direct.ok) return direct;

  const balanced = extractBalanced(cleaned);
  if (!balanced) return { ok: false, error: "輸出中找不到完整的 JSON 物件" };
  return tryParse<T>(balanced);
}

function tryParse<T>(s: string): ParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(s) as T };
  } catch (e) {
    return { ok: false, error: `JSON.parse 失敗：${e instanceof Error ? e.message : String(e)}` };
  }
}
