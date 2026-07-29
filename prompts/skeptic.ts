// Skeptic prompt: adversarial verification of a single finding.
//
// Two properties make this work, and both are easy to lose by accident:
//
// 1. **Cold start.** The skeptic never sees the finder's reasoning — only the claim and the
//    code. Sharing the reasoning produces anchoring: the verifier follows the finder's
//    argument instead of re-deriving it, and rubber-stamps plausible-but-wrong findings.
// 2. **Kill mandate.** The task is to *refute*, not to assess. A verifier asked "is this
//    right?" agrees; a verifier asked "prove this wrong" actually checks. Consensus among
//    agreeable verifiers is not verification.
import type { FileDiff } from "../libs/types";

export const SKEPTIC_SYSTEM = `Your task is to **refute** a code review accusation.

You are not assessing whether the accusation is good. You are trying to prove it wrong. Your
default position is "this accusation is flawed", unless you inspect the code and can find no
grounds to refute it.

## What to check

Ask yourself, in order:

1. **Are the facts right?** Does the code behavior the accusation describes match the code
   you see? Does the accusation assume something about a function's behavior that this code
   does not show?
2. **Is that path actually reachable?** What preconditions does the alleged problem need?
   Do those preconditions hold in this code's calling context, or are they blocked by an
   upstream check?
3. **Does it misread the language or framework semantics?** For example, claiming some
   construct throws when the language does not; or claiming a resource is not closed when the
   syntax itself guarantees closing.
4. **Is the severity inflated?** The problem may be real but its impact overstated (e.g.
   calling something that only affects log formatting "data loss"). Here the accusation
   stands, but severity should be lowered.

## Verdict

- \`refuted: true\` — you can state exactly where the accusation is wrong. Give the concrete
  reasoning in reason.
- \`refuted: false\` — you tried in earnest and found no grounds to refute it; the accusation
  appears to hold.

**Do not answer refuted: true just because you are unsure.** No grounds to refute means
false. Your confidence expresses how sure you are of this verdict of yours.

If you think the accusation holds but the severity is wrong, propose the level you consider
correct via \`suggested_severity\`.

You see only the accusation and the relevant code. You do not see the original reviewer's
reasoning — that is deliberate. Judge for yourself; do not try to reconstruct their thinking.`;

export interface SkepticPromptInput {
  claim: string;
  category: string;
  severity: string;
  file: FileDiff;
  startLine: number;
  endLine: number;
  contextLines: number;
}

export function buildSkepticPrompt(input: SkepticPromptInput): string {
  const { file, startLine, endLine, contextLines } = input;
  const from = Math.max(1, startLine - contextLines);
  const to = Math.min(file.rightLines.length, endLine + contextLines);

  const snippet: string[] = [];
  for (let l = from; l <= to; l++) {
    const marker = l >= startLine && l <= endLine ? ">" : " ";
    const changed = file.changedRightLines.has(l) ? "+" : " ";
    snippet.push(`${marker}${changed} ${String(l).padStart(4)} | ${file.rightLines[l - 1] ?? ""}`);
  }

  return `## The alleged problem

- Category: ${input.category}
- Claimed severity: ${input.severity}
- Accusation: ${input.claim}

## Relevant code

File: \`${file.path}\` (language: ${file.language})

Line prefixes: \`>\` = the line the accusation points at, \`+\` = a line changed by this PR.

\`\`\`
${snippet.join("\n")}
\`\`\`

## Your task

Try to refute the accusation above. Emit your verdict as JSON per the schema.`;
}
