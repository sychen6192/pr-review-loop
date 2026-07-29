// Finds a TLS configuration that works, by trying them all.
//
// In an intercepted-TLS environment the failure is always the same message but the remedy
// differs: sometimes the corporate root is in the system bundle, sometimes only an
// intermediate is missing, sometimes the bundle lives somewhere only Python was told about.
// Guessing one at a time is slow, so this connects once per candidate and reports which
// ones succeed — then prints the exact line to put in a shell profile.
import * as fs from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";
import { parsePrUrl } from "../ado/client";
import { HTTPS_PROXY, HTTP_PROXY, USER_AGENT, bypassesProxy } from "../libs/proxy";

interface Candidate {
  name: string;
  /** undefined = Node's built-in list only. */
  caFile?: string;
  exportLine?: string;
}

function gatherCandidates(): Candidate[] {
  const out: Candidate[] = [{ name: "Node 內建清單（不加任何設定）" }];
  const seen = new Set<string>();

  const add = (file: string, label: string) => {
    if (!file || seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    out.push({
      name: `${label}：${file}`,
      caFile: file,
      exportLine: `export NODE_EXTRA_CA_CERTS=${file}`,
    });
  };

  for (const [env, label] of [
    ["REQUESTS_CA_BUNDLE", "Python/az 使用的憑證包"],
    ["SSL_CERT_FILE", "SSL_CERT_FILE"],
    ["CURL_CA_BUNDLE", "curl 使用的憑證包"],
    ["NODE_EXTRA_CA_CERTS", "目前已設定的"],
  ] as const) {
    add(process.env[env] ?? "", label);
  }
  for (const p of [
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
  ]) {
    add(p, "系統憑證包");
  }
  return out;
}

/** Opens a raw socket to the host, tunnelling through the proxy when one is configured. */
function openSocket(host: string, port: number): Promise<net.Socket> {
  const proxy = bypassesProxy(host) ? "" : HTTPS_PROXY || HTTP_PROXY;
  return new Promise((resolve, reject) => {
    if (!proxy) {
      const s = net.connect({ host, port, timeout: 15_000 });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
      s.once("timeout", () => {
        s.destroy();
        reject(new Error("TCP 逾時"));
      });
      return;
    }
    const pu = new URL(proxy);
    const s = net.connect({ host: pu.hostname, port: Number(pu.port || 80), timeout: 15_000 });
    s.once("error", reject);
    s.once("timeout", () => {
      s.destroy();
      reject(new Error("proxy 逾時"));
    });
    s.once("connect", () => {
      const auth = pu.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password)}`).toString("base64")}\r\n`
        : "";
      s.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
          `User-Agent: ${USER_AGENT}\r\nProxy-Connection: Keep-Alive\r\n${auth}\r\n`,
      );
      s.once("data", (buf: Buffer) => {
        const head = (buf.toString("utf8").split("\r\n")[0] ?? "").trim();
        if (/ 200 /.test(head)) resolve(s);
        else {
          s.destroy();
          reject(new Error(`proxy 拒絕 CONNECT：${head}`));
        }
      });
    });
  });
}

async function tryCandidate(host: string, port: number, c: Candidate): Promise<string> {
  let sock: net.Socket;
  try {
    sock = await openSocket(host, port);
  } catch (e) {
    return `連線失敗：${e instanceof Error ? e.message : String(e)}`;
  }
  return new Promise<string>((resolve) => {
    // Passing `ca` in-process avoids respawning Node once per candidate; the effect on
    // verification is the same as NODE_EXTRA_CA_CERTS.
    const opts: tls.ConnectionOptions = { socket: sock, servername: host, timeout: 20_000 };
    if (c.caFile) {
      try {
        opts.ca = fs.readFileSync(c.caFile);
      } catch (e) {
        resolve(`讀不到憑證檔：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    const t = tls.connect(opts, () => {
      const ok = t.authorized;
      const err = t.authorizationError;
      t.destroy();
      resolve(ok ? "OK" : `驗證失敗：${String(err)}`);
    });
    t.once("error", (e: NodeJS.ErrnoException) => resolve(`驗證失敗：${e.message}`));
    t.once("timeout", () => {
      t.destroy();
      resolve("TLS 逾時");
    });
  });
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("用法：tsx scripts/tlsfix.ts '<PR URL>'");
    process.exit(1);
  }
  const ref = parsePrUrl(url);
  const u = new URL(ref.baseUrl);
  const host = u.hostname;
  const port = Number(u.port || 443);

  console.log(`\n目標：${host}:${port}`);
  const proxy = bypassesProxy(host) ? "" : HTTPS_PROXY || HTTP_PROXY;
  console.log(`連線方式：${proxy ? `經由 proxy ${proxy}` : "直接連線"}`);
  console.log(`\n逐一測試各種憑證設定：\n`);

  const candidates = gatherCandidates();
  const winners: Candidate[] = [];

  for (const c of candidates) {
    const result = await tryCandidate(host, port, c);
    const ok = result === "OK";
    if (ok) winners.push(c);
    console.log(`  ${ok ? "✅" : "❌"} ${c.name}`);
    if (!ok) console.log(`       ${result}`);
  }

  console.log("\n" + "=".repeat(70));
  if (winners.length === 0) {
    console.log("全部失敗。");
    console.log("");
    console.log("這代表可用的 CA 不在上述任何一個檔案裡。攔截憑證的簽發者可能是一張");
    console.log("中繼憑證，而它沒有隨連線送出、也不在系統憑證包中。");
    console.log("請向 IT 索取「簽發代理憑證的那張 CA」（含中繼），存成 .pem 後：");
    console.log("     export NODE_EXTRA_CA_CERTS=/path/to/那個檔案");
    process.exit(1);
  }

  // If the built-in list already verifies, adding a bundle is noise — recommend nothing.
  const builtinWorks = winners.some((w) => !w.caFile);
  console.log(`可用的設定有 ${winners.length} 種。`);
  console.log("");
  if (builtinWorks) {
    console.log("  不需要任何憑證設定 —— Node 內建清單就能驗證通過。");
    console.log("  若 prloop 仍失敗，問題不在憑證，請看 probe 的第 5 節（HTTP 狀態）。");
    console.log("");
    console.log(`     npx tsx scripts/probe.ts '${url}'`);
  } else {
    const best = winners.find((w) => w.exportLine)!;
    console.log("  建議使用：");
    console.log("");
    console.log(`     ${best.exportLine}`);
    console.log("");
    console.log("  把這行加進 ~/.bashrc 或 ~/.zshrc 就一勞永逸。");
    console.log("  或直接用 ./bin/prloop 執行——它會自動沿用其他工具的憑證包。");
    console.log("");
    console.log("  接著執行：");
    console.log(`     ${best.exportLine}`);
    console.log(`     npx tsx scripts/probe.ts '${url}'`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
