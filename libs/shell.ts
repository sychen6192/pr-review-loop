// Minimal command runner. Only used for optional external CLIs (az); the pipeline itself
// never shells out for anything it needs to be correct.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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
  // On Windows resolve exactly the way planSpawn will. `where` alone reports the
  // extensionless bash shim as a hit, so doctor would pass while the real spawn fails —
  // the worst possible split, because the preflight vouches for a broken setup.
  if (process.platform === "win32") return resolveWindowsCommand(cmd) !== undefined;
  const res = await run("which", [cmd], 10_000);
  return res.code === 0 && res.stdout.trim() !== "";
}

// ─── Windows process spawning ────────────────────────────────────────────────
//
// Three distinct failures hide behind "spawn <tool> failed" on Windows, and each needs a
// different fix. All three are invisible on Linux/macOS.
//
// 1. ENOENT — an npm-installed CLI is `foo.cmd` (plus `foo.ps1`, and often an
//    extensionless bash shim). Node's spawn does NOT apply PATHEXT, so bare `foo` is not
//    found; and if the extensionless bash shim IS on PATH, Windows cannot execute it.
// 2. EINVAL — the obvious fix, spawning `foo.cmd` directly, has been an error since Node
//    18.20.2 / 20.12.2 / 21.7.3 (the CVE-2024-27980 batch-file-injection fix). A .cmd must
//    go through a shell.
// 3. E2BIG / ENAMETOOLONG / silent truncation — the command line is capped at 32767 chars
//    for CreateProcess and 8191 through cmd.exe. Linux allows ~2MB, so passing a prompt as
//    an argument works everywhere except the platform the user is on.

const WINDOWS_ARGV_LIMIT = 32_767;
const CMD_EXE_ARGV_LIMIT = 8_191;

/** Resolves a bare command name to a real file on Windows, honouring PATHEXT. */
export function resolveWindowsCommand(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (env["PATH"] ?? "").split(";").filter(Boolean);

  const candidates = path.isAbsolute(cmd) || cmd.includes("\\") || cmd.includes("/") ? [cmd] : dirs.map((d) => path.join(d, cmd));
  for (const base of candidates) {
    // An explicit extension wins; otherwise try each PATHEXT entry, in order.
    if (path.extname(base) && fs.existsSync(base)) return base;
    for (const ext of exts) {
      const withExt = base + ext.toLowerCase();
      if (fs.existsSync(withExt)) return withExt;
    }
  }
  return undefined;
}

/**
 * Quotes one argument for cmd.exe, which needs two layers: CommandLineToArgvW quoting so the
 * child parses it as one argument, then `^`-escaping so cmd.exe does not interpret the
 * metacharacters itself.
 */
function quoteForCmd(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(/[()%!^"<>&|]/g, "^$&");
}

export interface SpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  /** Set when the command line is too long for this platform to carry. */
  error?: string;
}

/**
 * Turns (command, args) into something spawn() can actually run on this platform.
 *
 * Returns an `error` rather than throwing when the command line cannot fit: that failure
 * needs to reach the user as "this argument is too long for Windows", not as a spawn errno.
 */
export function planSpawn(cmd: string, args: string[], platform: string = process.platform): SpawnPlan {
  if (platform !== "win32") return { file: cmd, args };

  const resolved = resolveWindowsCommand(cmd) ?? cmd;
  const isShim = /\.(cmd|bat)$/i.test(resolved);
  const limit = isShim ? CMD_EXE_ARGV_LIMIT : WINDOWS_ARGV_LIMIT;
  const length = [resolved, ...args].reduce((n, a) => n + a.length + 3, 0);
  if (length > limit) {
    return {
      file: resolved,
      args,
      error:
        `command line is ${length} chars but ${isShim ? "cmd.exe" : "Windows"} allows ${limit}. ` +
        (isShim
          ? "This is a .cmd shim, so it must go through cmd.exe and gets the lower 8191 limit. "
          : "") +
        "Pass large input over stdin or via a file instead of as an argument",
    };
  }
  if (!isShim) return { file: resolved, args };

  // A .cmd/.bat cannot be spawned directly on current Node; route it through cmd.exe.
  const line = [resolved, ...args].map(quoteForCmd).join(" ");
  return {
    file: process.env["ComSpec"] ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/** Turns a spawn errno into the cause, rather than guessing one cause for all of them. */
export function explainSpawnError(err: NodeJS.ErrnoException, cmd: string): string {
  switch (err.code) {
    case "ENOENT":
      return `${cmd} not found on PATH${process.platform === "win32" ? " (looked for .cmd/.exe via PATHEXT too)" : ""}`;
    case "EINVAL":
      return `${cmd} could not be started: Node refuses to spawn a .bat/.cmd directly (CVE-2024-27980 fix); it must go through cmd.exe`;
    case "E2BIG":
    case "ENAMETOOLONG":
      return `${cmd} could not be started: the command line is too long for this platform. Pass large input over stdin or a file`;
    case "EACCES":
      return `${cmd} is not executable (permissions)`;
    default:
      return `${cmd} failed to start: ${err.message}`;
  }
}
