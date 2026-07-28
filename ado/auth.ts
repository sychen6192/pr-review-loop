// Authentication. Two modes, because plenty of orgs don't hand out PATs:
//   pat   — Basic auth with a personal access token (or a pipeline's $(System.AccessToken))
//   azcli — Bearer token minted by `az account get-access-token`, i.e. whoever ran `az login`
// "auto" prefers a PAT when one is configured and falls back to the az CLI.
import { ADO_AUTH_MODE, ADO_PAT, AZ_BIN } from "../config";
import { logVerbose } from "../libs/log";
import { commandExists, run } from "../libs/shell";

// Azure DevOps' first-party application ID. Tokens must be scoped to it, not to the ARM
// resource, or every request comes back 203 with a sign-in page.
const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

interface CachedToken {
  token: string;
  expiresAtMs: number;
}
let cached: CachedToken | undefined;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

interface AzTokenResponse {
  accessToken?: string;
  expiresOn?: string;
  expires_on?: number;
}

async function getAzToken(): Promise<string> {
  // Refresh a minute early so a long run never dies mid-flight on an expiring token.
  if (cached && cached.expiresAtMs > Date.now() + 60_000) return cached.token;

  const res = await run(AZ_BIN, [
    "account",
    "get-access-token",
    "--resource",
    ADO_RESOURCE_ID,
    "-o",
    "json",
  ]);
  if (res.code !== 0) {
    const hint = /az login|not logged in|AADSTS/i.test(res.stderr)
      ? "請先執行 az login"
      : `az 回傳非零結束碼：${res.stderr.trim().slice(0, 300)}`;
    throw new AuthError(`透過 az CLI 取得 token 失敗。${hint}`);
  }

  let parsed: AzTokenResponse;
  try {
    parsed = JSON.parse(res.stdout) as AzTokenResponse;
  } catch {
    throw new AuthError(`無法解析 az 輸出：${res.stdout.slice(0, 300)}`);
  }
  if (!parsed.accessToken) {
    throw new AuthError("az 輸出中沒有 accessToken");
  }

  // expires_on is epoch seconds; expiresOn is a local-time string whose format has varied
  // across az versions. Fall back to a conservative 30 minutes rather than trusting a parse.
  let expiresAtMs = Date.now() + 30 * 60_000;
  if (typeof parsed.expires_on === "number" && Number.isFinite(parsed.expires_on)) {
    expiresAtMs = parsed.expires_on * 1000;
  } else if (parsed.expiresOn) {
    const t = Date.parse(parsed.expiresOn);
    if (Number.isFinite(t)) expiresAtMs = t;
  }

  cached = { token: parsed.accessToken, expiresAtMs };
  logVerbose(`已透過 az CLI 取得 token，有效至 ${new Date(expiresAtMs).toISOString()}`);
  return parsed.accessToken;
}

export async function authHeader(): Promise<string> {
  const mode = ADO_AUTH_MODE;

  if (mode === "pat") {
    if (!ADO_PAT) {
      throw new AuthError("PRR_AUTH_MODE=pat 但未設定 PRR_ADO_PAT");
    }
    return `Basic ${Buffer.from(`:${ADO_PAT}`).toString("base64")}`;
  }

  if (mode === "azcli") {
    return `Bearer ${await getAzToken()}`;
  }

  // auto
  if (ADO_PAT) return `Basic ${Buffer.from(`:${ADO_PAT}`).toString("base64")}`;
  if (await commandExists(AZ_BIN)) return `Bearer ${await getAzToken()}`;
  throw new AuthError(
    "找不到可用的認證方式：未設定 PRR_ADO_PAT，且 PATH 中沒有 az CLI。" +
      "請設定 PAT，或安裝 az CLI 後執行 az login。",
  );
}

/** Which mode auto-detection would land on. Used by doctor to report the effective setup. */
export async function describeAuthMode(): Promise<string> {
  if (ADO_AUTH_MODE === "pat") return ADO_PAT ? "pat（已設定 PAT）" : "pat（但缺少 PAT）";
  if (ADO_AUTH_MODE === "azcli") {
    return (await commandExists(AZ_BIN)) ? "azcli（az 可用）" : "azcli（但找不到 az）";
  }
  if (ADO_PAT) return "auto → pat（偵測到 PRR_ADO_PAT）";
  if (await commandExists(AZ_BIN)) return "auto → azcli（未設 PAT，偵測到 az CLI）";
  return "auto → 無可用認證";
}
