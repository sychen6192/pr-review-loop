// Azure Boards stores rich-text fields (AcceptanceCriteria, Description, ReproSteps) as
// HTML. Feeding raw HTML to a model wastes tokens and hurts weak models' comprehension,
// so we flatten it — preserving list structure, which is exactly how acceptance criteria
// are almost always written.
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

export function htmlToText(html: string | undefined | null): string {
  if (!html) return "";
  let s = html;

  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // List items become "- " lines so the model sees discrete criteria, not a wall of text.
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<\/li>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|h[1-6]|ul|ol|table)>/gi, "\n");
  s = s.replace(/<\/t[dh]>/gi, "\t");
  s = s.replace(/<[^>]+>/g, "");

  s = s.replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)));
  for (const [ent, ch] of Object.entries(ENTITIES)) s = s.split(ent).join(ch);

  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .trim();
}
