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
    console.log(`  Installed ${f} → ${dest}`);
  }

  console.log(`\nDone. ${files.length} agent(s).`);
  console.log("Set PRR_RUNNER=opencode to use the opencode runner.");
  console.log(
    "Note: opencode does not pass response_format to the backend, so the schema is only\n" +
      "enforced by the prompt. If the backend supports guided decoding (vLLM/xgrammar),\n" +
      "PRR_RUNNER=openai is more accurate.",
  );
}

main();
