// Azure DevOps REST client. Deliberately not the MCP: we need iteration bookkeeping,
// raw blob bytes and validated thread anchors, none of which the MCP provides
// (azure-devops-mcp #793 / #868 — see PROPOSAL §2).
import { ADO_API_VERSION, ADO_BASE_URL, ADO_MAX_RETRIES, ADO_TIMEOUT_MS } from "../config";
import { logVerbose } from "../libs/log";
import type { PrRef } from "../libs/types";
import { authHeader } from "./auth";
import { dispatcherFor } from "../libs/proxy";

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

/**
 * Parses the PR URL people copy out of the browser.
 *
 * The collection base is taken from the URL itself rather than rebuilt from a configured
 * host, because "everything before /{project}/_git/" is the one rule that holds across
 * every deployment shape:
 *
 *   https://dev.azure.com/{org}/{proj}/_git/{repo}/pullrequest/{id}
 *   https://{org}.visualstudio.com/{proj}/_git/{repo}/pullrequest/{id}
 *   https://tfs.corp.com/tfs/{collection}/{proj}/_git/{repo}/pullrequest/{id}   ← on-prem
 *   https://ado.corp.com/{collection}/{proj}/_git/{repo}/pullrequest/{id}       ← on-prem
 *
 * Rebuilding it from a host + the first path segment silently produced a wrong base on
 * on-prem servers (the virtual-directory prefix was dropped and the collection was mistaken
 * for the org), which surfaced far downstream as an unexplained connection error.
 */
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
      `PR URL 格式不符，預期 .../{project}/_git/{repo}/pullrequest/{id}，收到：${raw}`,
    );
  }
  const prId = Number(segs[prIdx + 1]);
  if (!Number.isInteger(prId) || prId <= 0) {
    throw new AdoError(`PR URL 中的 PR id 無效：${segs[prIdx + 1]}`);
  }

  const repoId = segs[gitIdx + 1]!;
  const project = segs[gitIdx - 1];
  if (!project) throw new AdoError(`PR URL 缺少 project 區段：${raw}`);

  // Path segments before the project: the collection, plus any virtual directory on-prem.
  // Empty on {org}.visualstudio.com, where the org lives in the hostname.
  const collectionSegs = segs.slice(0, gitIdx - 1);
  const derived =
    `${u.origin}${collectionSegs.length ? `/${collectionSegs.map(encodeURIComponent).join("/")}` : ""}`;

  // An explicit override wins, for the rare deployment whose API host differs from the
  // browser host (a reverse proxy in front of the web UI, typically).
  const baseUrl = (ADO_BASE_URL || derived).replace(/\/+$/, "");

  const org = collectionSegs[collectionSegs.length - 1] ?? u.hostname.split(".")[0] ?? "";
  return { baseUrl, org, project, repoId, prId };
}

/** The collection base — everything the REST paths hang off. */
export function orgBase(ref: PrRef): string {
  return ref.baseUrl;
}

export function repoBase(ref: PrRef): string {
  return `${ref.baseUrl}/${encodeURIComponent(ref.project)}/_apis/git/repositories/${encodeURIComponent(ref.repoId)}`;
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
        // Node's fetch ignores HTTP(S)_PROXY; the dispatcher is how a proxy gets used at all.
        dispatcher: dispatcherFor(u.toString()),
      } as RequestInit);
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
  if (lastErr instanceof AdoError) throw lastErr;
  throw new AdoError(`連線 ${u.origin} 失敗：${diagnose(lastErr)}`);
}

/**
 * Turns a fetch-level failure into something actionable. These are almost always
 * environmental rather than API problems, and on-prem hits every one of them.
 */
function diagnose(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code ?? "";
  const all = `${msg} ${code}`;

  if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|unable to verify|self-signed/i.test(all)) {
    return (
      `TLS 憑證無法驗證（${code || "cert"}）。內部 CA 簽發的憑證 Node 預設不信任。` +
      `解法：export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem 後重跑`
    );
  }
  if (/ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match/i.test(all)) {
    return "TLS 憑證的主機名稱與網址不符。確認 PR URL 用的主機名與憑證上的一致";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(all)) {
    return "DNS 查不到這個主機。確認網址正確，且這台機器連得到內網（VPN？）";
  }
  if (/ECONNREFUSED/i.test(all)) {
    return (
      "連線被拒。若這台機器只能透過公司 proxy 對外，請確認 HTTPS_PROXY 已設定" +
      "（prloop 會自動使用；Node 內建的 fetch 本身不會讀這個變數）"
    );
  }
  if (/ETIMEDOUT|ECONNRESET|UND_ERR_CONNECT_TIMEOUT/i.test(all)) {
    return "連線逾時。多半是防火牆或需要 proxy（設 HTTPS_PROXY 環境變數）";
  }
  if (/aborted|AbortError/i.test(all)) return `請求逾時（${ADO_TIMEOUT_MS}ms）。可調高 PRR_ADO_TIMEOUT_MS`;
  return msg;
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
