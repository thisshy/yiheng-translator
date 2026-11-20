import type { LangCode } from "../../shared/types";

export interface ParagraphPair {
  source: string;
  translation: string;
}
export interface ReadingResult {
  pairs: ParagraphPair[];
  from: LangCode;
  to: LangCode;
}

// Keep math and code opaque to paragraph splitting, cleanup and term selection.
const literal =
  /\x60{3}[\s\S]*?(?:\x60{3}|$)|~~~[\s\S]*?(?:~~~|$)|\x60[^\x60\n]*\x60|\\begin\{([\w*]+)\}[\s\S]*?\\end\{\1\}|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\s)(?:\\.|[^$])*?(?<!\\)\$/g;

export function literalSpans(text: string) {
  return Array.from(text.matchAll(literal), (match) => ({
    start: match.index!,
    value: match[0],
  }));
}

function masked(text: string) {
  const chunks: string[] = [];
  let prefix = "\uE000";
  while (text.includes(prefix)) prefix += "\uE000";
  const value = text.replace(
    literal,
    (part) => prefix + (chunks.push(part) - 1) + "\uE001",
  );
  const pattern = new RegExp(prefix + "(\\d+)\\uE001", "g");
  return {
    value,
    restore: (s: string) => s.replace(pattern, (_, n) => chunks[Number(n)]),
  };
}

export function paragraphs(text: string): string[] {
  const { value, restore } = masked(text.replace(/\r\n?/g, "\n"));
  return value
    .split(/\n(?:[ \t]*\n)+/)
    .map((s) => restore(s.trim()))
    .filter(Boolean);
}

export function cleanPdfText(text: string): string {
  const { value, restore } = masked(text.replace(/\r\n?/g, "\n"));
  const lines = value.split("\n");
  const block = (line: string) =>
    /^(?:\s*$| {4}|\t|\s*\|)/.test(line) ||
    /^(?:\$\$|\\\[|\\begin\{|\x60{3}|~~~)/.test(restore(line.trimStart()));
  let cleaned = lines[0] ?? "";
  for (let i = 1; i < lines.length; i++) {
    const previous = lines[i - 1],
      next = lines[i];
    if (
      block(previous) ||
      block(next) ||
      /^\s*(?:[-•*]\s|\d+[.)]\s|#{1,6}\s)/.test(next) ||
      /^\s*#{1,6}\s/.test(previous)
    ) {
      cleaned += "\n" + next;
      continue;
    }
    cleaned = cleaned.trimEnd();
    const right = next.trimStart();
    if (cleaned.endsWith("\u00ad")) cleaned = cleaned.slice(0, -1);
    else if (/[a-z]{2}-$/i.test(cleaned) && /^[a-z]/.test(right)) {
      // Ambiguous compounds keep the visible hyphen.
      if (
        /^(?:tion(?:al|s)?|ation(?:al|s)?|ment(?:s)?|ically|tational|lation|lated|lates|ness|ously|ing|ity|ities|ence|ance|ers?)\b/.test(
          right,
        )
      )
        cleaned = cleaned.slice(0, -1);
    } else if (!(
      /[\p{Script=Han}，。；、]$/u.test(cleaned) &&
      /^\p{Script=Han}/u.test(right)
    ))
      cleaned += " ";
    cleaned += right;
  }
  return restore(cleaned.replace(/\u00ad/g, ""));
}

export function bilingualText(pairs: ParagraphPair[]): string {
  return pairs.map((p) => p.source + "\n" + p.translation).join("\n\n");
}

export function isReadingResult(value: unknown): value is ReadingResult {
  if (!value || typeof value !== "object") return false;
  const v = value as ReadingResult;
  return (
    typeof v.from === "string" &&
    typeof v.to === "string" &&
    Array.isArray(v.pairs) &&
    v.pairs.length > 0 &&
    v.pairs.every(
      (p) =>
        p && typeof p.source === "string" && typeof p.translation === "string",
    )
  );
}
