// Corporate proxy support.
//
// Node's built-in fetch ignores HTTP_PROXY / HTTPS_PROXY entirely — unlike curl, git and
// pip, which all read them. On a network whose only egress is a proxy, that shows up as a
// bare ECONNREFUSED with no hint that a proxy was ever involved, which is a genuinely hard
// failure to diagnose from the outside.
//
// So we read the standard variables ourselves and hand fetch an explicit dispatcher.
import { ProxyAgent, type Dispatcher } from "undici";
import { logVerbose } from "./log";

/**
 * User-Agent sent on both ordinary requests and the proxy CONNECT.
 *
 * Some corporate proxies filter by User-Agent, allowing browsers and git while refusing
 * requests that carry an unfamiliar one — or none at all — with a 403 on CONNECT. That
 * looks identical to "this host is blocked", but the host is fine and only the client is
 * being rejected. Presenting a recognised agent is the difference between 200 and 403.
 */
export const USER_AGENT = process.env.PRR_USER_AGENT ?? "git/2.34.1";

function envAny(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n] ?? process.env[n.toLowerCase()] ?? process.env[n.toUpperCase()];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

export const HTTPS_PROXY = envAny("HTTPS_PROXY", "https_proxy");
export const HTTP_PROXY = envAny("HTTP_PROXY", "http_proxy");
export const NO_PROXY = envAny("NO_PROXY", "no_proxy");

/**
 * Standard NO_PROXY semantics: comma-separated hosts, a leading dot or bare suffix matches
 * subdomains, and `*` disables proxying entirely. Internal endpoints (a self-hosted model
 * server, say) almost always need to bypass the proxy that fronts external traffic.
 */
export function bypassesProxy(host: string, noProxy: string = NO_PROXY): boolean {
  if (!noProxy) return false;
  const h = host.toLowerCase();
  for (const raw of noProxy.split(",")) {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    // A bare "*" disables proxying entirely. It has to be checked before the wildcard
    // prefix is stripped, or it reduces to an empty entry and is silently ignored.
    if (trimmed === "*") return true;
    const entry = trimmed.replace(/^\*/, "");
    if (!entry) continue;
    const suffix = entry.startsWith(".") ? entry : `.${entry}`;
    if (h === entry || h.endsWith(suffix)) return true;
  }
  return false;
}

const cache = new Map<string, Dispatcher | undefined>();

/** The dispatcher fetch should use for a URL, or undefined to connect directly. */
export function dispatcherFor(url: string): Dispatcher | undefined {
  let host: string;
  let isHttps: boolean;
  try {
    const u = new URL(url);
    host = u.hostname;
    isHttps = u.protocol === "https:";
  } catch {
    return undefined;
  }
  if (bypassesProxy(host)) return undefined;

  const proxy = isHttps ? HTTPS_PROXY || HTTP_PROXY : HTTP_PROXY || HTTPS_PROXY;
  if (!proxy) return undefined;

  if (!cache.has(proxy)) {
    try {
      // Headers here ride on the CONNECT request itself, which is where the filtering
      // happens — setting a User-Agent only on the tunnelled request would be too late.
      cache.set(proxy, new ProxyAgent({ uri: proxy, headers: { "user-agent": USER_AGENT } }));
      logVerbose(`使用 proxy：${redactProxy(proxy)}`);
    } catch (e) {
      logVerbose(`proxy 設定無法解析（${proxy}）：${e instanceof Error ? e.message : String(e)}`);
      cache.set(proxy, undefined);
    }
  }
  return cache.get(proxy);
}

/** Proxy URLs sometimes embed credentials; never print those. */
export function redactProxy(p: string): string {
  try {
    const u = new URL(p);
    if (u.username || u.password) {
      u.username = u.username ? "***" : "";
      u.password = u.password ? "***" : "";
    }
    return u.toString();
  } catch {
    return p;
  }
}

export function proxySummary(): string {
  const parts: string[] = [];
  if (HTTPS_PROXY) parts.push(`HTTPS_PROXY=${redactProxy(HTTPS_PROXY)}`);
  if (HTTP_PROXY) parts.push(`HTTP_PROXY=${redactProxy(HTTP_PROXY)}`);
  if (NO_PROXY) parts.push(`NO_PROXY=${NO_PROXY}`);
  return parts.length ? parts.join("｜") : "（未設定，直接連線）";
}
