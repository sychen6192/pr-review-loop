// Language profiles. Adding a language is adding an entry here — the pipeline itself has
// no per-language branches.
import type { Profile } from "./types";

const python: Profile = {
  language: "python",
  extensions: [".py", ".pyi"],
  tools: [
    {
      // Ruff subsumes flake8/bugbear/pyupgrade and is fast enough to run on every PR.
      // Its own rules are style-adjacent, so they're triage, not fact.
      name: "ruff",
      bin: "ruff",
      args: (files) => ["check", "--output-format=json", "--force-exclude", ...files],
      format: "ruff-json",
      tier: "triage",
      allowNonZeroExit: true,
    },
    {
      // Type errors are facts: mypy doesn't guess.
      name: "mypy",
      bin: "mypy",
      args: (files) => ["--output=json", "--no-error-summary", "--hide-error-context", ...files],
      format: "mypy-json",
      tier: "fact",
      allowNonZeroExit: true,
    },
    {
      // Bandit is the high-recall/high-FP member of the set — exactly the profile that
      // benefits from LLM triage rather than direct posting.
      name: "bandit",
      bin: "bandit",
      args: (files) => ["-f", "sarif", "-q", ...files],
      format: "sarif",
      tier: "triage",
      allowNonZeroExit: true,
    },
  ],
  // Formatting and import order are the formatter's job, never a review comment.
  ignoreRules: ["E501", "W291", "W293", "E302", "E303", "I001", "COM812", "Q000"],
};

const java: Profile = {
  language: "java",
  extensions: [".java"],
  tools: [
    {
      name: "pmd",
      bin: "pmd",
      args: (files) => ["check", "-f", "xml", "-R", "rulesets/java/quickstart.xml", "-d", ...files],
      format: "checkstyle-xml",
      tier: "triage",
      allowNonZeroExit: true,
    },
    {
      // SpotBugs works on bytecode, so it only runs when the module has been built.
      // Skipping is correct here: running it on stale classes reports fixed bugs.
      name: "spotbugs",
      bin: "spotbugs",
      args: () => ["-textui", "-xml:withMessages", "-low", "target/classes"],
      format: "checkstyle-xml",
      tier: "triage",
      requires: "target/classes",
      allowNonZeroExit: true,
    },
    {
      name: "checkstyle",
      bin: "checkstyle",
      args: (files) => ["-f", "xml", "-c", "/google_checks.xml", ...files],
      format: "checkstyle-xml",
      tier: "suppress",
      allowNonZeroExit: true,
    },
  ],
};

const nextjs: Profile = {
  language: "typescript",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  tools: [
    {
      // Type errors are facts. tsc is project-wide, so its findings get diff-filtered
      // like everything else rather than being limited to the changed files up front.
      name: "tsc",
      bin: "npx",
      args: () => ["tsc", "--noEmit", "--pretty", "false"],
      format: "tsc-text",
      tier: "fact",
      allowNonZeroExit: true,
      requires: "tsconfig.json",
    },
    {
      name: "eslint",
      bin: "npx",
      args: (files) => ["eslint", "--format", "json", "--no-color", ...files],
      format: "eslint-json",
      tier: "triage",
      allowNonZeroExit: true,
    },
  ],
  // Formatting rules — Prettier/Biome own these.
  ignoreRules: [
    "prettier/prettier",
    "indent",
    "quotes",
    "semi",
    "comma-dangle",
    "max-len",
    "object-curly-spacing",
  ],
};

export const PROFILES: Profile[] = [python, java, nextjs];

/** Profiles whose extensions appear among the changed files. */
export function selectProfiles(changedPaths: string[]): Profile[] {
  const exts = new Set(
    changedPaths.map((p) => {
      const i = p.lastIndexOf(".");
      return i < 0 ? "" : p.slice(i).toLowerCase();
    }),
  );
  return PROFILES.filter((p) => p.extensions.some((e) => exts.has(e)));
}

export function filesForProfile(profile: Profile, changedPaths: string[]): string[] {
  return changedPaths.filter((p) => profile.extensions.some((e) => p.toLowerCase().endsWith(e)));
}
