// Artifacts: every stage's input and output lands on disk. State lives in files, not in
// model context — that's what makes a run reproducible and auditable after the fact
// (design principle: state in artifacts, not context).
import * as fs from "node:fs";
import * as path from "node:path";
import { RUNS_DIR } from "../config";
import type { PrRef } from "./types";

export interface RunDir {
  dir: string;
  save(name: string, content: string): void;
  saveJson(name: string, value: unknown): void;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

export function createRunDir(ref: PrRef, iterationId: number): RunDir {
  const dir = path.join(
    RUNS_DIR,
    safe(ref.org),
    safe(ref.project),
    safe(ref.repoId),
    `pr-${ref.prId}`,
    `iter-${iterationId}-${timestamp()}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    save(name, content) {
      fs.writeFileSync(path.join(dir, name), content);
    },
    saveJson(name, value) {
      fs.writeFileSync(
        path.join(dir, name),
        JSON.stringify(value, (_k, v) => (v instanceof Set ? [...v] : v), 2),
      );
    },
  };
}
