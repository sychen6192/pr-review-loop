// Azure DevOps REST client. Deliberately not the MCP: we need iteration bookkeeping,
// raw blob bytes and validated thread anchors, none of which the MCP provides
// (azure-devops-mcp #793 / #868 — see PROPOSAL §2).
import { ADO_API_VERSION, ADO_BASE_URL, ADO_MAX_RETRIES, ADO_TIMEOUT_MS } from "../config";
import { logVerbose } from "../libs/log";
import type { PrRef } from "../libs/types";
import { authHeader } from "./auth";

export class AdoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "AdoError";
  }
}

// Parses the PR URL people copy out of the browser, e.g.
// https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}
// Also accepts the older {org}.visualstudio.com host.
export function parsePrUrl(raw: string): PrRef {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AdoError(`無法解析 PR URL：${raw}`);
  }
  const segs = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const gitIdx = segs.indexOf("_git");
  const prIdx = segs.findIndex((s) => s.toLowerCase() === "pullrequest");
  if (gitIdx < 0 || prIdx < 0 || prIdx !== gitIdx + 2) {
    throw new AdoError(
      `PR URL 格式不符，預期 .../{org}/{project}/_git/{repo}/pullrequest/{id}，收到：${raw}`,
    );
  }
  const prId = Number(segs[prIdx + 1]);
  if (!Number.isInteger(prId) || prId <= 0) {
    throw new AdoError(`PR URL 中的 PR id 無效：${segs[prIdx + 1]}`);
  }

  const repoId = segs[gitIdx + 1]!;
  // dev.azure.com/{org}/{project}/_git/... vs {org}.visualstudio.com/{project}/_git/...
  const isVsts = u.hostname.endsWith(".visualstudio.com");
  const org = isVsts ? u.hostname.split(".")[0]! : segs[0];
  const project = segs[gitIdx - 1];
  if (!org || !project || (!isVsts && gitIdx < 2)) {
    throw new AdoError(`PR URL 缺少 org 或 project 區段：${raw}`);
  }
  return { org, project, repoId, prId };
}

export function orgBase(ref: PrRef): string {
  return `${ADO_BASE_URL.replace(/\/+$/, "")}/${encodeURIComponent(ref.org)}`;
}

export function repoBase(ref: PrRef): string {
  return `${orgBase(ref)}/${encodeURIComponent(ref.project)}/_apis/git/repositories/${encodeURIComponent(ref.repoId)}`;
}

export function prBase(ref: PrRef): string {
  return `${repoBase(ref)}/pullRequests/${ref.prId}`;
}

interface RequestOpts {
  method?: "GET" | "POST" | "PATCH" | "PUT";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  // Blobs come back as bytes, not JSON.
  raw?: boolean;
  accept?: string;
  apiVersion?: string;
}

async function request(url: string, opts: RequestOpts = {}): Promise<Response> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) u.searchParams.set(k, String(v));
  }
  if (!u.searchParams.has("api-version")) {
    u.searchParams.set("api-version", opts.apiVersion ?? ADO_API_VERSION);
  }

  const headers: Record<string, string> = {
    Authorization: await authHeader(),
    Accept: opts.accept ?? "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= ADO_MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ADO_TIMEOUT_MS);
    try {
      const res = await fetch(u, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      // A PAT that lacks scope gets a 203 + sign-in HTML page rather than a 401.
      if (res.status === 203) {
        throw new AdoError(
          "Azure DevOps 回傳 203（登入頁）：PAT 無效或缺少 scope（需要 Code Read & Write）",
          203,
        );
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        if (attempt < ADO_MAX_RETRIES) {
          const waitMs = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
          logVerbose(`ADO ${res.status}，${waitMs}ms 後重試（第 ${attempt}/${ADO_MAX_RETRIES} 次）`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new AdoError(
          `ADO ${opts.method ?? "GET"} ${u.pathname} 失敗：${res.status} ${res.statusText}`,
          res.status,
          body.slice(0, 2000),
        );
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      // AdoError with a status is a real API rejection: don't retry it.
      if (e instanceof AdoError && e.status !== undefined && e.status < 500 && e.status !== 429) {
        throw e;
      }
      if (attempt >= ADO_MAX_RETRIES) break;
      const waitMs = 500 * 2 ** (attempt - 1);
      logVerbose(`ADO 請求例外（${String(e)}），${waitMs}ms 後重試`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new AdoError(`ADO 請求失敗：${String(lastErr)}`);
}

export async function adoGet<T>(url: string, opts: Omit<RequestOpts, "method" | "body"> = {}): Promise<T> {
  const res = await request(url, { ...opts, method: "GET" });
  return (await res.json()) as T;
}

// Blob content must be read as bytes: decoding through a local checkout or a
// text-mode read would normalize CRLF/BOM and shift every anchor after it.
export async function adoGetBytes(url: string, opts: Omit<RequestOpts, "method" | "body"> = {}): Promise<Buffer> {
  const res = await request(url, { ...opts, method: "GET" });
  return Buffer.from(await res.arrayBuffer());
}

export async function adoPost<T>(url: string, body: unknown, opts: Omit<RequestOpts, "method" | "body"> = {}): Promise<T> {
  const res = await request(url, { ...opts, method: "POST", body });
  return (await res.json()) as T;
}

export async function adoPatch<T>(url: string, body: unknown, opts: Omit<RequestOpts, "method" | "body"> = {}): Promise<T> {
  const res = await request(url, { ...opts, method: "PATCH", body });
  return (await res.json()) as T;
}

export interface AdoList<T> {
  count: number;
  value: T[];
}
