// Output parsers. Every tool gets normalized to ToolFinding so the rest of the pipeline
// never knows which linter a finding came from.
import { parseJsonObject } from "../libs/json";
import type { Severity } from "../config";
import type { OutputFormat, ToolFinding, ToolSpec } from "./types";

function rel(p: string, workdir: string): string {
  const norm = p.replace(/\\/g, "/");
  const w = workdir.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm.startsWith(`${w}/`) ? norm.slice(w.length + 1) : norm.replace(/^\.\//, "");
}

// SARIF level and most tools' severity words collapse to our four.
function mapSeverity(raw: string | undefined, fallback: Severity = "medium"): Severity {
  const s = (raw ?? "").toLowerCase();
  if (["critical", "blocker", "fatal"].includes(s)) return "critical";
  if (["error", "high", "major", "2"].includes(s)) return "high";
  if (["warning", "warn", "medium", "moderate", "1"].includes(s)) return "medium";
  if (["note", "info", "low", "minor", "convention", "0"].includes(s)) return "low";
  return fallback;
}

interface SarifLog {
  runs?: Array<{
    tool?: { driver?: { name?: string; rules?: Array<{ id?: string; helpUri?: string }> } };
    results?: Array<{
      ruleId?: string;
      level?: string;
      message?: { text?: string };
      locations?: Array<{
        physicalLocation?: {
          artifactLocation?: { uri?: string };
          region?: { startLine?: number; endLine?: number };
        };
      }>;
      properties?: { "security-severity"?: string | number };
    }>;
  }>;
}

function parseSarif(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const parsed = parseJsonObject<SarifLog>(raw);
  if (!parsed.ok) return [];
  const out: ToolFinding[] = [];

  for (const run of parsed.value.runs ?? []) {
    const helpByRule = new Map<string, string>();
    for (const r of run.tool?.driver?.rules ?? []) {
      if (r.id && r.helpUri) helpByRule.set(r.id, r.helpUri);
    }
    for (const res of run.results ?? []) {
      const loc = res.locations?.[0]?.physicalLocation;
      const uri = loc?.artifactLocation?.uri;
      const line = loc?.region?.startLine;
      if (!uri || !line) continue;

      // GitHub's convention: security-severity outranks level when present, because a
      // rule can be level:note while describing a critical vulnerability.
      const secSev = Number(res.properties?.["security-severity"]);
      let severity = mapSeverity(res.level);
      if (Number.isFinite(secSev)) {
        severity = secSev >= 9 ? "critical" : secSev >= 7 ? "high" : secSev >= 4 ? "medium" : "low";
      }

      const ruleId = res.ruleId ?? "";
      out.push({
        tool: spec.name,
        tier: spec.tier,
        ruleId,
        message: res.message?.text ?? "",
        file: rel(decodeURIComponent(uri.replace(/^file:\/\//, "")), workdir),
        line,
        endLine: loc?.region?.endLine,
        severity,
        rawSeverity: res.level,
        helpUri: helpByRule.get(ruleId),
      });
    }
  }
  return out;
}

interface RuffFinding {
  code?: string;
  message?: string;
  filename?: string;
  location?: { row?: number };
  end_location?: { row?: number };
  url?: string;
}

function parseRuffJson(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const parsed = parseJsonObject<RuffFinding[]>(raw);
  if (!parsed.ok || !Array.isArray(parsed.value)) return [];
  return parsed.value
    .filter((f) => f.filename && f.location?.row)
    .map((f) => ({
      tool: spec.name,
      tier: spec.tier,
      ruleId: f.code ?? "",
      message: f.message ?? "",
      file: rel(f.filename!, workdir),
      line: f.location!.row!,
      endLine: f.end_location?.row,
      // Ruff has no severity axis; the S-prefixed (bandit) rules are the security ones.
      severity: (f.code ?? "").startsWith("S") ? "high" : "medium",
      helpUri: f.url,
    }));
}

interface EslintFile {
  filePath?: string;
  messages?: Array<{
    ruleId?: string | null;
    severity?: number;
    message?: string;
    line?: number;
    endLine?: number;
  }>;
}

function parseEslintJson(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const parsed = parseJsonObject<EslintFile[]>(raw);
  if (!parsed.ok || !Array.isArray(parsed.value)) return [];
  const out: ToolFinding[] = [];
  for (const file of parsed.value) {
    if (!file.filePath) continue;
    for (const m of file.messages ?? []) {
      if (!m.line) continue;
      out.push({
        tool: spec.name,
        tier: spec.tier,
        ruleId: m.ruleId ?? "",
        message: m.message ?? "",
        file: rel(file.filePath, workdir),
        line: m.line,
        endLine: m.endLine,
        severity: m.severity === 2 ? "high" : "medium",
        rawSeverity: String(m.severity ?? ""),
      });
    }
  }
  return out;
}

// Checkstyle XML is the lingua franca of Java tooling (checkstyle, PMD, and SpotBugs via
// its xml:withMessages output all speak a compatible dialect).
function parseCheckstyleXml(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const out: ToolFinding[] = [];
  const fileRe = /<file[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/file>/g;
  const errRe = /<(?:error|violation)\b([^>]*)\/?>/g;
  const attr = (s: string, k: string) => new RegExp(`${k}="([^"]*)"`).exec(s)?.[1];

  for (const fm of raw.matchAll(fileRe)) {
    const filePath = fm[1]!;
    for (const em of (fm[2] ?? "").matchAll(errRe)) {
      const a = em[1] ?? "";
      const line = Number(attr(a, "line"));
      if (!Number.isFinite(line) || line <= 0) continue;
      const src = attr(a, "source") ?? attr(a, "rule") ?? "";
      out.push({
        tool: spec.name,
        tier: spec.tier,
        // Checkstyle emits fully-qualified class names; the last segment is the rule.
        ruleId: src.split(".").pop() ?? src,
        message: decodeXml(attr(a, "message") ?? ""),
        file: rel(filePath, workdir),
        line,
        severity: mapSeverity(attr(a, "severity") ?? attr(a, "priority")),
        rawSeverity: attr(a, "severity"),
      });
    }
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

interface MypyFinding {
  file?: string;
  line?: number;
  severity?: string;
  message?: string;
  code?: string;
}

// mypy emits JSON Lines, not a JSON array.
function parseMypyJson(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const out: ToolFinding[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    const parsed = parseJsonObject<MypyFinding>(line);
    if (!parsed.ok) continue;
    const f = parsed.value;
    if (!f.file || !f.line) continue;
    if (f.severity === "note") continue; // follow-up context for a previous error
    out.push({
      tool: spec.name,
      tier: spec.tier,
      ruleId: f.code ?? "",
      message: f.message ?? "",
      file: rel(f.file, workdir),
      line: f.line,
      severity: "high", // a type error is a fact
      rawSeverity: f.severity,
    });
  }
  return out;
}

// tsc has no machine-readable output; its text format is stable enough to parse.
// e.g. src/a.ts(12,5): error TS2345: Argument of type ...
function parseTscText(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/gm;
  const out: ToolFinding[] = [];
  for (const m of raw.matchAll(re)) {
    out.push({
      tool: spec.name,
      tier: spec.tier,
      ruleId: m[5]!,
      message: m[6]!.trim(),
      file: rel(m[1]!, workdir),
      line: Number(m[2]),
      severity: m[4] === "error" ? "high" : "medium",
      rawSeverity: m[4],
    });
  }
  return out;
}

const PARSERS: Record<OutputFormat, (raw: string, spec: ToolSpec, workdir: string) => ToolFinding[]> = {
  sarif: parseSarif,
  "ruff-json": parseRuffJson,
  "eslint-json": parseEslintJson,
  "checkstyle-xml": parseCheckstyleXml,
  "mypy-json": parseMypyJson,
  "tsc-text": parseTscText,
};

export function parseToolOutput(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  if (!raw.trim()) return [];
  try {
    return PARSERS[spec.format](raw, spec, workdir);
  } catch {
    // A parser blowing up must not take the review down with it.
    return [];
  }
}
