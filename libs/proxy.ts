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
 * The default identifies this tool honestly. Some corporate proxies filter CONNECT by
 * User-Agent — allowing browsers and git while refusing anything unfamiliar with a 403 —
 * and on such a network PRR_USER_AGENT exists as an escape hatch (e.g. the exact string
 * your git sends). That is a policy workaround for the operator to choose deliberately,
 * not something an open tool should ship as its default.
 */
export const USER_AGENT = process.env.PRR_USER_AGENT ?? "prloop/0.1";

function envAny(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n] ?? process.env[n.toLowerCase()] ?? process.env[n.toUpperCase()];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

// PRR_-prefixed values win over the conventional ones.
//
// The .env loader never overwrites an existing environment variable, so on a machine that
// already exports HTTPS_PROXY — which is most corporate machines — writing it in .env has
// no effect and no error. Giving prloop its own names makes .env a reliable place to
// override the inherited setting, rather than a file whose contents silently do nothing.
export const HTTPS_PROXY = envAny("PRR_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy");
export const HTTP_PROXY = envAny("PRR_HTTP_PROXY", "HTTP_PROXY", "http_proxy");
export const NO_PROXY = envAny("PRR_NO_PROXY", "NO_PROXY", "no_proxy");

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
      logVerbose(`Using proxy: ${redactProxy(proxy)}`);
    } catch (e) {
      logVerbose(`Unparsable proxy config (${proxy}): ${e instanceof Error ? e.message : String(e)}`);
      cache.set(proxy, undefined);
    }
  }
  return cache.get(proxy);
}

/**
 * Hides credentials in a proxy URL while leaving everything else byte-for-byte intact.
 *
 * Round-tripping through `new URL()` would normalise the value — notably dropping a default
 * port, so `http://host:80` prints as `http://host/`. That reads as "my configured port
 * vanished" and sends people looking for a bug in their own settings, so the redaction is
 * done by string surgery on the credentials alone.
 */
export function redactProxy(p: string): string {
  return p.replace(/\/\/([^/@]+)@/, (_m, creds: string) => {
    const [user] = creds.split(":");
    return `//${user ? `${user}:***` : "***"}@`;
  });
}

export function proxySummary(): string {
  const parts: string[] = [];
  if (HTTPS_PROXY) parts.push(`HTTPS_PROXY=${redactProxy(HTTPS_PROXY)}`);
  if (HTTP_PROXY) parts.push(`HTTP_PROXY=${redactProxy(HTTP_PROXY)}`);
  if (NO_PROXY) parts.push(`NO_PROXY=${NO_PROXY}`);
  return parts.length ? parts.join(" | ") : "(not set, connecting directly)";
}
