// Minimal command runner. Only used for optional external CLIs (az); the pipeline itself
// never shells out for anything it needs to be correct.
import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === "number"
        ? ((err as unknown as { code: number }).code)
        : err
          ? 1
          : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}

export async function commandExists(cmd: string): Promise<boolean> {
  const res = await run(process.platform === "win32" ? "where" : "which", [cmd], 10_000);
  return res.code === 0 && res.stdout.trim() !== "";
}
