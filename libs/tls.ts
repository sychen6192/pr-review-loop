// Extra CA trust, applied in-process.
//
// Node ships its own compiled-in CA list and ignores the system trust store, which is why
// az, curl and git can all work on a TLS-intercepting corporate network while every Node
// tool on the same machine fails. The usual answer is NODE_EXTRA_CA_CERTS, but that is read
// once at process start, so it only ever works if something exported it before Node
// launched — which meant it applied to one entry point and silently did nothing for
// `npm run doctor`, `probe`, `tlsfix` and every other direct `tsx` invocation.
//
// Every request this tool makes goes through a undici dispatcher, and a dispatcher accepts
// TLS options at runtime. So the CA is loaded here and handed to the dispatcher instead.
// PRR_CA_CERTS then works from .env no matter how the process was started.
import * as fs from "node:fs";
import * as tls from "node:tls";
import { CA_CERTS } from "../config";

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

export interface CaSource {
  path: string;
  /** Where the path came from, for diagnostics. */
  from: "PRR_CA_CERTS" | "NODE_EXTRA_CA_CERTS";
  certs: number;
  error?: string;
}

/** Splits the configured value(s) into distinct paths, preserving order and dropping dupes. */
export function sourcePaths(
  caCerts: string = CA_CERTS,
  nodeExtra: string = process.env["NODE_EXTRA_CA_CERTS"] ?? "",
): Array<{ path: string; from: CaSource["from"] }> {
  const out: Array<{ path: string; from: CaSource["from"] }> = [];
  const push = (raw: string, from: CaSource["from"]) => {
    // A bundle is usually one file, but a root and its intermediate often arrive as two.
    for (const p of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!out.some((e) => e.path === p)) out.push({ path: p, from });
    }
  };
  push(caCerts, "PRR_CA_CERTS");
  push(nodeExtra, "NODE_EXTRA_CA_CERTS");
  return out;
}

export function load(
  paths: Array<{ path: string; from: CaSource["from"] }> = sourcePaths(),
): { sources: CaSource[]; pems: string[] } {
  const sources: CaSource[] = [];
  const pems: string[] = [];

  for (const { path, from } of paths) {
    let text: string;
    try {
      text = fs.readFileSync(path, "utf8");
    } catch (e) {
      sources.push({ path, from, certs: 0, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const blocks = text.match(PEM_BLOCK) ?? [];
    if (blocks.length === 0) {
      // Most often a DER/.cer export that was never converted:
      //   openssl x509 -inform der -in cert.cer -out cert.pem
      sources.push({ path, from, certs: 0, error: "no PEM certificate block found (is it DER?)" });
      continue;
    }
    sources.push({ path, from, certs: blocks.length });
    pems.push(...blocks);
  }
  return { sources, pems };
}

const loaded = load();

/** What was configured and whether it parsed. Used by doctor and probe. */
export const CA_SOURCES: CaSource[] = loaded.sources;

/**
 * Certificates to trust, or undefined to leave the defaults alone.
 *
 * Passing `ca` to a TLS connection *replaces* the trust store rather than adding to it —
 * unlike NODE_EXTRA_CA_CERTS, which appends. Concatenating the built-in roots is what keeps
 * ordinary public HTTPS (the model endpoint, npm, GitHub) working once a corporate CA is set.
 */
export function caBundle(): string[] | undefined {
  if (loaded.pems.length === 0) return undefined;
  return [...tls.rootCertificates, ...loaded.pems];
}

/** One-line status for diagnostics. */
export function caSummary(): string {
  if (CA_SOURCES.length === 0) return "(none configured, using Node's built-in CA list)";
  return CA_SOURCES.map((s) =>
    s.error ? `${s.path} [FAIL] ${s.error}` : `${s.path} (${s.certs} cert${s.certs === 1 ? "" : "s"})`,
  ).join(" | ");
}
