import { DEFAULT_MAX_BYTES, type TruncationResult } from "./truncate.js";

export type GrepSearchMatch = {
  filePath: string;
  lineNumber: number;
  lineText?: string;
};

export function splitGrepFileLines(content: string): string[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized) {
    return [];
  }
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

export function createBoundedGrepOutput(): {
  append: (line: string) => boolean;
  hasOutput: () => boolean;
  result: () => TruncationResult;
  truncated: () => boolean;
} {
  const lines: string[] = [];
  let outputBytes = 0;
  let totalBytes = 0;
  let totalLines = 0;
  let truncated = false;

  return {
    append: (line) => {
      const lineBytes = Buffer.byteLength(line, "utf8");
      totalBytes += lineBytes + (totalLines > 0 ? 1 : 0);
      totalLines += 1;
      if (truncated) {
        return false;
      }
      const nextOutputBytes = outputBytes + lineBytes + (lines.length > 0 ? 1 : 0);
      if (nextOutputBytes > DEFAULT_MAX_BYTES) {
        truncated = true;
        return false;
      }
      lines.push(line);
      outputBytes = nextOutputBytes;
      return true;
    },
    hasOutput: () => lines.length > 0,
    result: () => ({
      content: lines.join("\n"),
      truncated,
      truncatedBy: truncated ? "bytes" : null,
      totalLines,
      totalBytes,
      outputLines: lines.length,
      outputBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: truncated && lines.length === 0,
      maxLines: Number.MAX_SAFE_INTEGER,
      maxBytes: DEFAULT_MAX_BYTES,
    }),
    truncated: () => truncated,
  };
}
