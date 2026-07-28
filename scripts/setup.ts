// Installs the opencode agent definition. Only needed when PRR_RUNNER=opencode.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PRLOOP_ROOT } from "../config";

const GLOBAL_OPENCODE_DIR = path.join(
  process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"),
  "opencode",
);

function main() {
  const srcDir = path.join(PRLOOP_ROOT, "agents");
  const destDir = path.join(GLOBAL_OPENCODE_DIR, "agent");
  fs.mkdirSync(destDir, { recursive: true });

  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const dest = path.join(destDir, f);
    fs.copyFileSync(path.join(srcDir, f), dest);
    console.log(`  已安裝 ${f} → ${dest}`);
  }

  console.log(`\n完成，共 ${files.length} 個 agent。`);
  console.log("使用 opencode runner 時設 PRR_RUNNER=opencode。");
  console.log(
    "提醒：opencode 不會把 response_format 傳給後端，schema 只能靠 prompt 約束。\n" +
      "若後端支援 guided decoding（vLLM/xgrammar），用 PRR_RUNNER=openai 精度會更好。",
  );
}

main();
