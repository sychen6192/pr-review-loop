// Language detection by extension. Drives per-language profiles (M4) and diff ordering.
const EXT_LANG: Record<string, string> = {
  ".py": "python",
  ".pyi": "python",
  ".java": "java",
  ".kt": "kotlin",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sql": "sql",
  ".sh": "shell",
  ".md": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".xml": "xml",
};

// Files that are changed but never worth an LLM's attention.
const NOISE = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)go\.sum$/,
  /\.min\.(js|css)$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)node_modules\//,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  /(^|\/)\.next\//,
  /(^|\/)target\/(classes|generated-sources)\//,
];

export function detectLanguage(filePath: string): string {
  const i = filePath.lastIndexOf(".");
  if (i < 0) return "other";
  return EXT_LANG[filePath.slice(i).toLowerCase()] ?? "other";
}

export function isNoiseFile(filePath: string): boolean {
  return NOISE.some((re) => re.test(filePath));
}

// Code we actually want reviewed. Everything else can still appear in the file list.
const REVIEWABLE = new Set([
  "python",
  "java",
  "kotlin",
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "sql",
  "shell",
]);

export function isReviewable(filePath: string): boolean {
  return !isNoiseFile(filePath) && REVIEWABLE.has(detectLanguage(filePath));
}
