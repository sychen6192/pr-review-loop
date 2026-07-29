// Finds a TLS configuration that works, by trying them all.
//
// In an intercepted-TLS environment the failure is always the same message but the remedy
// differs: sometimes the corporate root is in the system bundle, sometimes only an
// intermediate is missing, sometimes the bundle lives somewhere only Python was told about.
// Guessing one at a time is slow, so this connects once per candidate and reports which
// ones succeed — then prints the exact line to put in a shell profile.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";
import { parsePrUrl } from "../ado/client";
import { HTTPS_PROXY, HTTP_PROXY, USER_AGENT, bypassesProxy, dispatcherFor } from "../libs/proxy";
import { PRLOOP_ROOT } from "../config";

interface Candidate {
  name: string;
  /** undefined = Node's built-in list only. */
  caFile?: string;
  exportLine?: string;
}

function gatherCandidates(): Candidate[] {
  // Named for what it actually exercises: no extra `ca`, so the process inherits whatever
  // NODE_EXTRA_CA_CERTS is already set to. Calling it "built-in only" misleads when the
  // variable is set.
  const current = process.env["NODE_EXTRA_CA_CERTS"];
  const out: Candidate[] = [
    {
      name: current
        ? `目前的環境設定（NODE_EXTRA_CA_CERTS=${current}）`
        : "Node 內建清單（未設定任何額外憑證）",
    },
  ];
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
    const opts: tls.ConnectionOptions = { socket: sock, servername: host, timeout: 20_000 };
    if (c.caFile) {
      try {
        // NODE_EXTRA_CA_CERTS *appends* to the built-in roots, whereas the `ca` option
        // *replaces* them. Testing with the file alone would discard every public CA and
        // report a false failure for any bundle that is missing one — so reproduce the
        // append semantics explicitly.
        opts.ca = [...tls.rootCertificates, fs.readFileSync(c.caFile, "utf8")];
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

/**
 * Fetches the issuing certificate named by the leaf's Authority Information Access
 * extension, and writes a bundle that can complete the chain.
 *
 * An intercepting proxy commonly presents only the re-signed leaf, leaving the intermediate
 * that signed it absent from both the handshake and the system store. Browsers paper over
 * this by following the AIA "CA Issuers" URL; Node and OpenSSL do not, which is exactly why
 * the same connection succeeds in a browser and fails here. Doing the fetch ourselves turns
 * an IT request into a local fix.
 */
async function chaseAia(host: string, port: number): Promise<string | undefined> {
  const sock = await openSocket(host, port).catch(() => undefined);
  if (!sock) return undefined;

  const info = await new Promise<Record<string, string[]> | undefined>((resolve) => {
    const t = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
      const cert = t.getPeerCertificate(true) as tls.DetailedPeerCertificate & {
        infoAccess?: Record<string, string[]>;
      };
      t.destroy();
      resolve(cert?.infoAccess);
    });
    t.once("error", () => resolve(undefined));
  });

  const urls = info?.["CA Issuers - URI"] ?? [];
  if (urls.length === 0) {
    console.log("  憑證中沒有 AIA（CA Issuers）欄位，無法自動取得中繼憑證。");
    return undefined;
  }

  for (const url of urls) {
    console.log(`  嘗試下載中繼憑證：${url}`);
    try {
      const res = await fetch(url, { dispatcher: dispatcherFor(url) } as RequestInit);
      if (!res.ok) {
        console.log(`     HTTP ${res.status}，略過`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // AIA endpoints serve DER; some serve PEM. Normalise to PEM either way.
      const text = buf.toString("utf8");
      const pem = text.includes("BEGIN CERTIFICATE")
        ? text
        : `-----BEGIN CERTIFICATE-----\n${buf.toString("base64").match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END CERTIFICATE-----\n`;
      const target = path.join(PRLOOP_ROOT, "corporate-chain.pem");
      // Append the system bundle so the file alone can complete the whole chain.
      const systemBundle = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"].find(
        (p) => fs.existsSync(p),
      );
      fs.writeFileSync(target, pem + (systemBundle ? fs.readFileSync(systemBundle, "utf8") : ""));
      console.log(`     ✅ 已寫入 ${target}（中繼憑證 + 系統憑證包）`);
      return target;
    } catch (e) {
      console.log(`     下載失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return undefined;
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
    console.log("全部失敗 —— 缺的是「簽發站台憑證的那張中繼憑證」。");
    console.log("");
    console.log("瀏覽器能開是因為它會依憑證裡的 AIA 欄位自動下載該中繼憑證；");
    console.log("Node 與 OpenSSL 都不會做這件事。現在試著自動下載：");
    console.log("");
    const chain = await chaseAia(host, port);
    if (chain) {
      const result = await tryCandidate(host, port, { name: "AIA", caFile: chain });
      console.log("");
      if (result === "OK") {
        console.log("=".repeat(70));
        console.log("✅ 成功！用這個檔案即可：");
        console.log("");
        console.log(`     export NODE_EXTRA_CA_CERTS=${chain}`);
        console.log("");
        console.log("  加進 ~/.bashrc 就一勞永逸。");
        process.exit(0);
      }
      console.log(`  以下載到的憑證測試仍失敗：${result}`);
    }
    console.log("");
    console.log("請向 IT 索取「簽發代理憑證的中繼 CA」（本例為 proxy 那張），存成 .pem 後：");
    console.log("     export NODE_EXTRA_CA_CERTS=/path/to/那個檔案");
    console.log("");
    console.log("或從瀏覽器匯出：開啟該網站 → 點網址列的鎖頭 → 憑證 → 憑證路徑 →");
    console.log("選中間那張 → 匯出為 Base64/PEM。");
    process.exit(1);
  }

  // If the built-in list already verifies, adding a bundle is noise — recommend nothing.
  const builtinWorks = winners.some((w) => !w.caFile);
  console.log(`可用的設定有 ${winners.length} 種。`);
  console.log("");
  if (builtinWorks) {
    console.log(
      process.env["NODE_EXTRA_CA_CERTS"]
        ? `  ✅ 目前的設定就可以用（NODE_EXTRA_CA_CERTS=${process.env["NODE_EXTRA_CA_CERTS"]}）。\n     把它加進 ~/.bashrc 就一勞永逸。`
        : "  不需要任何憑證設定 —— Node 內建清單就能驗證通過。",
    );
    console.log("  憑證這一關已通過，若 prloop 仍失敗請看 probe 的第 5 節（HTTP 狀態）。");
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
