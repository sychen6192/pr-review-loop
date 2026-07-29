// Deterministic diff budgeting, after PR-Agent's compression strategy: sort by language
// prevalence, prefer files with real additions, fit to a char budget, and name-list the
// overflow rather than truncating mid-hunk.
import { log } from "./log";
import { MAX_DIFF_CHARS } from "../config";
import { renderUnifiedDiff } from "./diff";
import type { FileDiff } from "./types";

export interface DiffPayload {
  text: string;
  includedFiles: string[];
  omittedFiles: string[];
}

function addedLineCount(f: FileDiff): number {
  return f.changedRightLines.size;
}

export function buildDiffPayload(files: FileDiff[], budget = MAX_DIFF_CHARS): DiffPayload {
  // Language prevalence: the repo's dominant language goes first, so if anything gets
  // dropped it's the outlier file types.
  const prevalence = new Map<string, number>();
  for (const f of files) prevalence.set(f.language, (prevalence.get(f.language) ?? 0) + 1);

  const ordered = [...files].sort((a, b) => {
    const pa = prevalence.get(a.language) ?? 0;
    const pb = prevalence.get(b.language) ?? 0;
    if (pa !== pb) return pb - pa;
    if (a.language !== b.language) return a.language.localeCompare(b.language);
    // Within a language, the file with the most added lines carries the most new risk.
    const aa = addedLineCount(a);
    const ab = addedLineCount(b);
    if (aa !== ab) return ab - aa;
    return a.path.localeCompare(b.path);
  });

  const chunks: string[] = [];
  const includedFiles: string[] = [];
  const omittedFiles: string[] = [];
  let used = 0;

  for (const f of ordered) {
    const rendered = `### ${f.path}${f.originalPath && f.originalPath !== f.path ? ` (renamed from ${f.originalPath})` : ""} [${f.changeType}, ${f.language}]\n\`\`\`diff\n${renderUnifiedDiff(f.path, f.hunks)}\n\`\`\``;
    if (used + rendered.length > budget && includedFiles.length > 0) {
      omittedFiles.push(f.path);
      continue;
    }
    // The first file is always included so the payload is never empty — but a single
    // giant file can then blow far past the budget, and a backend that truncates the
    // prompt corrupts the very quotes anchoring depends on. Say so out loud.
    if (includedFiles.length === 0 && rendered.length > budget) {
      log(
        `[WARN] ${f.path} alone renders ${rendered.length} chars against a ${budget} budget; ` +
          `sent anyway — if the backend truncates, anchoring will degrade`,
      );
    }
    chunks.push(rendered);
    includedFiles.push(f.path);
    used += rendered.length;
  }

  let text = chunks.join("\n\n");
  if (omittedFiles.length > 0) {
    text += `\n\n### Changed files omitted for size (${omittedFiles.length})\n${omittedFiles.map((p) => `- ${p}`).join("\n")}`;
  }
  return { text, includedFiles, omittedFiles };
}
