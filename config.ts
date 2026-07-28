// Central config (SSOT: every threshold, endpoint and param is defined only here).
// Loads the tool's own .env without overriding existing env vars.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// prloop's own dir (independent of cwd).
export const PRLOOP_ROOT = __dirname;

// --- Minimal .env loader (PRLOOP_ROOT/.env; never overrides existing env vars) ---
(function loadDotEnv() {
  const p = path.join(PRLOOP_ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();

// --- Azure DevOps ---
// PAT with vso.code_write (threads) + vso.work (work items). In a pipeline you can
// instead pass $(System.AccessToken); both go into the same Basic auth header.
export const ADO_PAT = process.env.PRR_ADO_PAT ?? process.env.SYSTEM_ACCESSTOKEN ?? "";
// auto = use a PAT if configured, otherwise mint a token via the az CLI.
export const ADO_AUTH_MODE = (process.env.PRR_AUTH_MODE ?? "auto") as "auto" | "pat" | "azcli";
export const AZ_BIN = process.env.PRR_AZ_BIN ?? "az";
// Override for on-prem Azure DevOps Server. Default is the cloud host.
export const ADO_BASE_URL = process.env.PRR_ADO_BASE_URL ?? "https://dev.azure.com";
export const ADO_API_VERSION = process.env.PRR_ADO_API_VERSION ?? "7.1";
export const ADO_TIMEOUT_MS = Number(process.env.PRR_ADO_TIMEOUT_MS ?? 60_000);
export const ADO_MAX_RETRIES = Number(process.env.PRR_ADO_MAX_RETRIES ?? 3);

// --- Runner ---
// openai   = direct HTTP to an OpenAI-compatible endpoint. Supports engine-level guided
//            decoding (vLLM/xgrammar), which is what makes weak models emit valid JSON.
// opencode = drive models through the opencode CLI, inheriting its provider config.
//            NOTE: response_format is not passed through, so schemas are prompt-level only.
export const RUNNER_KIND = (process.env.PRR_RUNNER ?? "openai") as "openai" | "opencode";
export const OPENCODE_BIN = process.env.PRR_OPENCODE_BIN ?? "opencode";
// The agent definition prloop drives. Installed by `npm run setup`; must have every tool
// disabled — the review context is fully injected, and there is no local checkout to read.
export const OPENCODE_AGENT = process.env.PRR_OPENCODE_AGENT ?? "prloop-reviewer";
// 0 = drop --format json (fallback for opencode builds without JSONL events; loses tracing).
export const OPENCODE_JSON_EVENTS = process.env.PRR_OPENCODE_JSON !== "0";
// Wall-clock timeout for one opencode session.
export const AGENT_TIMEOUT_MS = Number(process.env.PRR_AGENT_TIMEOUT_MS ?? 15 * 60 * 1000);

// --- Model access (OpenAI-compatible: LiteLLM proxy, vLLM, Ollama /v1) ---
export const LLM_BASE_URL = process.env.PRR_LLM_BASE_URL ?? "http://localhost:4000/v1";
export const LLM_API_KEY = process.env.PRR_LLM_API_KEY ?? "dummy";
export const LLM_TIMEOUT_MS = Number(process.env.PRR_LLM_TIMEOUT_MS ?? 900_000);
// M1 runs a single finder; M3 turns this into a comma-separated heterogeneous fleet.
export const FINDER_MODELS = (process.env.PRR_FINDER_MODELS ?? "qwen3-coder")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Requirement axis model. Defaults to the first finder model; set separately when you want
// a stronger model on requirements (long acceptance criteria stress weak models).
export const REQ_MODEL = process.env.PRR_REQ_MODEL ?? FINDER_MODELS[0] ?? "";
export const LLM_TEMPERATURE = Number(process.env.PRR_LLM_TEMPERATURE ?? 0.2);
export const LLM_MAX_TOKENS = Number(process.env.PRR_LLM_MAX_TOKENS ?? 8192);
// 0 = don't send response_format (for backends whose schema support is broken).
export const LLM_STRUCTURED_OUTPUT = process.env.PRR_LLM_STRUCTURED !== "0";

// --- Diff / token budget (PR-Agent style deterministic compression) ---
export const MAX_DIFF_CHARS = Number(process.env.PRR_MAX_DIFF_CHARS ?? 240_000);
// Extra context lines around each hunk. Asymmetric on purpose: preceding context
// carries more meaning for review than trailing context.
export const HUNK_CONTEXT_BEFORE = Number(process.env.PRR_HUNK_CONTEXT_BEFORE ?? 6);
export const HUNK_CONTEXT_AFTER = Number(process.env.PRR_HUNK_CONTEXT_AFTER ?? 3);
// Files bigger than this are diffed but never sent whole.
export const MAX_FILE_BYTES = Number(process.env.PRR_MAX_FILE_BYTES ?? 2_000_000);

// --- Adversarial verification (M3) ---
// Skeptics should be a DIFFERENT model family from the finders. Same-family verifiers share
// the finders' blind spots, so they confirm the errors that matter most.
export const SKEPTIC_MODELS = (process.env.PRR_SKEPTIC_MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Verifiers per finding. 1 is a single gate; 3 gives a majority vote worth the name.
export const SKEPTIC_ROUNDS = Number(process.env.PRR_SKEPTIC_ROUNDS ?? 1);
// Source lines shown around the finding. Small on purpose: models degrade with unlimited
// context, and a skeptic that needs the whole file is guessing.
export const SKEPTIC_CONTEXT_LINES = Number(process.env.PRR_SKEPTIC_CONTEXT_LINES ?? 25);
// Findings need corroboration to be published: either N finders found it independently, or
// a skeptic actively cleared it. A lone unverified finding stays in the summary instead.
export const MIN_CONSENSUS_SOURCES = Number(process.env.PRR_MIN_CONSENSUS_SOURCES ?? 2);
// 0 = publish single-source findings that no skeptic examined (looser, noisier).
export const REQUIRE_CORROBORATION = process.env.PRR_REQUIRE_CORROBORATION !== "0";

// --- Static analysis (M4) ---
// A checkout of the PR's source branch. Linters need files on disk; without this the
// static gate skips. In an Azure pipeline this is the agent's own checkout.
export const WORKDIR = process.env.PRR_WORKDIR ?? "";
export const SKIP_STATIC = process.env.PRR_SKIP_STATIC === "1";
export const STATIC_TIMEOUT_MS = Number(process.env.PRR_STATIC_TIMEOUT_MS ?? 5 * 60 * 1000);
// Model that judges high-false-positive tool findings. Unset = those findings are dropped
// rather than posted unjudged.
export const TRIAGE_MODEL = process.env.PRR_TRIAGE_MODEL ?? "";
export const TRIAGE_CONTEXT_LINES = Number(process.env.PRR_TRIAGE_CONTEXT_LINES ?? 12);
// Ceiling on one triage call. A PR that trips 200 lint rules has a lint config problem,
// not a review problem.
export const MAX_TRIAGE_ITEMS = Number(process.env.PRR_MAX_TRIAGE_ITEMS ?? 40);

// --- Review axes ---
// 1 = skip the requirement axis entirely.
export const SKIP_REQUIREMENT = process.env.PRR_SKIP_REQUIREMENT === "1";
// 1 = treat a PR with no linked work item as a failure rather than a warning.
export const REQUIRE_WORK_ITEM = process.env.PRR_REQUIRE_WORK_ITEM === "1";

// --- Publishing ---
// Hard cap on inline comments per run. Noise control beats coverage (see PROPOSAL §9.11).
// The two axes get separate budgets on purpose: a shared cap lets code findings crowd out
// "this requirement wasn't implemented", which is usually the more important message.
export const MAX_INLINE_COMMENTS = Number(process.env.PRR_MAX_INLINE_COMMENTS ?? 10);
export const MAX_INLINE_REQ_COMMENTS = Number(process.env.PRR_MAX_INLINE_REQ_COMMENTS ?? 3);
// Findings below this severity never become inline comments.
export const MIN_INLINE_SEVERITY = (process.env.PRR_MIN_INLINE_SEVERITY ?? "medium") as Severity;
// 1 = compute everything but post nothing (safe first run against a real PR).
// Read lazily, not captured at import time: the CLI sets this env var after config has
// already been loaded, so a const here would silently ignore --dry-run.
export const isDryRun = (): boolean => process.env.PRR_DRY_RUN === "1";
// 1 = also post a PR status (needs a branch policy to actually gate merges).
export const POST_STATUS = process.env.PRR_POST_STATUS === "1";
export const STATUS_GENRE = process.env.PRR_STATUS_GENRE ?? "prloop";
export const STATUS_NAME = process.env.PRR_STATUS_NAME ?? "ai-review";

export const QUIET = process.env.PRR_QUIET === "1";

// Marker embedded in every comment we author, so re-runs can find and update
// our own threads instead of duplicating them.
export const BOT_MARKER = "<!-- prloop -->";

// Artifacts root.
export const RUNS_DIR = process.env.PRR_RUNS_DIR ?? path.join(PRLOOP_ROOT, "runs");

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

// Finding categories. Aligned with the taxonomy commercial reviewers converged on
// (CodeRabbit's six content categories), plus three we keep separate on purpose:
//   concurrency    — folded into "reliability" elsewhere, but it's the dominant defect
//                    class in the Java codebases this tool targets, and it needs its own
//                    review lens rather than being diluted into general reliability
//   leftover-code  — debug prints, commented-out blocks, stray TODOs. Only Graphite names
//                    this, and it's consistently one of the highest-acceptance finding types
//   req-mismatch   — reserved for M2: the change doesn't satisfy the linked work item
export const FINDING_CATEGORIES = [
  "correctness",
  "concurrency",
  "security",
  "reliability",
  "data-integrity",
  "performance",
  "maintainability",
  "leftover-code",
  "req-mismatch",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];
