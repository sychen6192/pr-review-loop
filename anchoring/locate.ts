// Quote-based re-anchoring.
//
// Models never emit line numbers (their schema has no such field). They quote the source
// line; we find that quote in the blob bytes of the iteration under review and compute the
// coordinates ourselves. When the quote can't be located unambiguously we fail closed and
// degrade the finding into the summary comment — we never guess a line.
//
// This is what makes comments land on the right line, and it doubles as a hallucination
// filter: a quote that doesn't exist in the file means the finding was invented.
import type { Anchor, AnchorFailure, FileDiff, RawFinding } from "../libs/types";

export interface AnchorResult {
  anchor?: Anchor;
  failure?: AnchorFailure;
  // Human-readable detail for the degraded-findings section of the summary.
  detail?: string;
  file?: FileDiff;
}

/** Strips a trailing CR so CRLF files compare equal to what the model echoed back. */
function stripCr(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

// Three tiers, tried in order. Earlier tiers are stricter; we stop at the first tier that
// finds any candidate, so loose matching never overrides an exact hit.
const NORMALIZERS: Array<(s: string) => string> = [
  (s) => stripCr(s).replace(/\s+$/, ""),
  (s) => stripCr(s).trim(),
  (s) => stripCr(s).replace(/\s+/g, " ").trim(),
];

function quoteLines(quote: string): string[] {
  return quote
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l, i, arr) => !(l.trim() === "" && (i === 0 || i === arr.length - 1)));
}

/** Resolves the model's file string against the diff's real paths. */
export function resolveFile(rawPath: string, files: FileDiff[]): FileDiff | undefined {
  const want = rawPath.replace(/^\/+/, "").replace(/\\/g, "/");
  const norm = (p: string) => p.replace(/^\/+/, "").replace(/\\/g, "/");

  const exact = files.find((f) => norm(f.path) === want);
  if (exact) return exact;

  const ci = files.filter((f) => norm(f.path).toLowerCase() === want.toLowerCase());
  if (ci.length === 1) return ci[0];

  // Models often shorten paths to the last segments; accept only if unambiguous.
  const suffix = files.filter((f) => norm(f.path).endsWith(`/${want}`) || norm(f.path) === want);
  if (suffix.length === 1) return suffix[0];

  const basename = want.split("/").pop() ?? want;
  const byName = files.filter((f) => (norm(f.path).split("/").pop() ?? "") === basename);
  if (byName.length === 1) return byName[0];

  return undefined;
}

interface Candidate {
  startLine: number; // 1-based
  endLine: number; // 1-based
}

function findWindows(haystack: string[], needle: string[], normalize: (s: string) => string): Candidate[] {
  const n = needle.map(normalize).filter((l) => l !== "");
  if (n.length === 0) return [];
  const hay = haystack.map(normalize);
  const out: Candidate[] = [];

  for (let i = 0; i + n.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < n.length; j++) {
      if (hay[i + j] !== n[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ startLine: i + 1, endLine: i + n.length });
  }
  return out;
}

/** Scores a candidate by how well the surrounding lines match the model's stated context. */
function contextScore(
  lines: string[],
  cand: Candidate,
  before: string[],
  after: string[],
  normalize: (s: string) => string,
): number {
  let score = 0;
  for (let k = 0; k < before.length; k++) {
    const want = normalize(before[before.length - 1 - k]!);
    if (want === "") continue;
    const idx = cand.startLine - 2 - k; // 0-based index of the line above
    if (idx >= 0 && normalize(lines[idx] ?? "") === want) score++;
  }
  for (let k = 0; k < after.length; k++) {
    const want = normalize(after[k]!);
    if (want === "") continue;
    const idx = cand.endLine + k; // 0-based index of the line below
    if (idx < lines.length && normalize(lines[idx] ?? "") === want) score++;
  }
  return score;
}

function inAnyHunk(file: FileDiff, cand: Candidate, side: "right" | "left"): boolean {
  return file.hunks.some((h) => {
    const start = side === "right" ? h.rightStart : h.leftStart;
    const count = side === "right" ? h.rightCount : h.leftCount;
    return cand.startLine >= start && cand.startLine <= start + Math.max(count, 1) - 1;
  });
}

function touchesChangedLine(file: FileDiff, cand: Candidate): boolean {
  for (let l = cand.startLine; l <= cand.endLine; l++) {
    if (file.changedRightLines.has(l)) return true;
  }
  return false;
}

export function anchorFinding(finding: RawFinding, files: FileDiff[]): AnchorResult {
  const file = resolveFile(finding.file, files);
  if (!file) {
    return {
      failure: "file-not-in-diff",
      detail: `檔案「${finding.file}」不在本次變更清單中`,
    };
  }

  const side: "right" | "left" = finding.side === "left" ? "left" : "right";
  const lines = side === "right" ? file.rightLines : file.leftLines;
  if (lines.length === 0) {
    return { file, failure: "file-not-in-diff", detail: `檔案「${file.path}」${side} 側無可比對內容` };
  }

  const needle = quoteLines(finding.quote ?? "");
  if (needle.length === 0) {
    return { file, failure: "quote-not-found", detail: "finding 未提供 quote" };
  }

  const before = quoteLines(finding.context_before ?? "");
  const after = quoteLines(finding.context_after ?? "");

  for (const normalize of NORMALIZERS) {
    const cands = findWindows(lines, needle, normalize);
    if (cands.length === 0) continue;

    let pool = cands;
    if (pool.length > 1) {
      // 1) the model's own context is the strongest disambiguator
      const scored = pool.map((c) => ({ c, s: contextScore(lines, c, before, after, normalize) }));
      const best = Math.max(...scored.map((x) => x.s));
      if (best > 0) pool = scored.filter((x) => x.s === best).map((x) => x.c);
    }
    if (pool.length > 1 && side === "right") {
      // 2) prefer a candidate that sits on a line this PR actually touched
      const onChanged = pool.filter((c) => touchesChangedLine(file, c));
      if (onChanged.length > 0) pool = onChanged;
    }
    if (pool.length > 1) {
      // 3) prefer a candidate inside a hunk (change + context window)
      const inHunk = pool.filter((c) => inAnyHunk(file, c, side));
      if (inHunk.length > 0) pool = inHunk;
    }

    if (pool.length !== 1) {
      return {
        file,
        failure: "quote-ambiguous",
        detail: `quote 在 ${file.path} 中出現 ${cands.length} 次，context 無法消歧`,
      };
    }

    const cand = pool[0]!;
    if (!inAnyHunk(file, cand, side)) {
      // reviewdog's diff_context filter, applied to LLM findings: an issue outside the
      // changed region is not this PR's business.
      return {
        file,
        failure: "outside-changed-lines",
        detail: `quote 定位到 ${file.path}:${cand.startLine}，不在本次變更範圍內`,
      };
    }

    const lastLine = stripCr(lines[cand.endLine - 1] ?? "");
    return {
      file,
      anchor: {
        side,
        startLine: cand.startLine,
        endLine: cand.endLine,
        // ADO's docs say offsets start at 0 but its own examples use 1, and 0/missing
        // offsets are implicated in the UI breakage of azure-devops-mcp #793.
        // Always send both ends, always 1-based.
        startOffset: 1,
        endOffset: Math.max(lastLine.length + 1, 1),
      },
    };
  }

  return {
    file,
    failure: "quote-not-found",
    detail: `在 ${file.path} 中找不到 quote：「${(finding.quote ?? "").slice(0, 80)}」`,
  };
}
