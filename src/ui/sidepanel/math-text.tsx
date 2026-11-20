import { literalSpans } from "./reading";
import renderMathInElement, {
  type DelimiterSpec,
} from "katex/contrib/auto-render";
import { useLayoutEffect, useRef } from "preact/hooks";
import "katex/dist/katex.min.css";

const DELIMITERS: DelimiterSpec[] = [
  { left: "$$", right: "$$", display: true },
  { left: "\\[", right: "\\]", display: true },
  { left: "\\(", right: "\\)", display: false },
  ...["equation", "align", "alignat", "gather", "CD"].flatMap((name) =>
    [name, ...(name === "CD" ? [] : [`${name}*`])].map((environment) => ({
      left: `\\begin{${environment}}`,
      right: `\\end{${environment}}`,
      display: true,
    })),
  ),
  { left: "$", right: "$", display: false },
];

// Keep code examples literal and never interpret model output as HTML.
const CODE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g;

export function hasMath(text: string): boolean {
  const prose = text.replace(CODE, "");
  return DELIMITERS.some(({ left, right }) => {
    const start = prose.indexOf(left);
    return start !== -1 && prose.indexOf(right, start + left.length) !== -1;
  });
}

export function renderMathText(element: HTMLElement, text: string): void {
  const document = element.ownerDocument;
  const fragment = document.createDocumentFragment();
  let end = 0;
  for (const match of text.matchAll(CODE)) {
    fragment.append(document.createTextNode(text.slice(end, match.index)));
    const code = document.createElement(
      match[0].startsWith("```") || match[0].startsWith("~~~") ? "pre" : "code",
    );
    code.textContent = match[0];
    fragment.append(code);
    end = match.index + match[0].length;
  }
  fragment.append(document.createTextNode(text.slice(end)));
  element.replaceChildren(fragment);
  renderMathInElement(element, {
    delimiters: DELIMITERS,
    throwOnError: false,
    trust: false,
    strict: "ignore",
    maxExpand: 1000,
    maxSize: 20,
    // Incomplete streaming formulas stay as text until their closing delimiter.
    errorCallback: () => {},
  });
}

export function MathText({
  text,
  class: className = "",
  id,
  label,
  live,
  tabIndex,
  termOffsets = false,
}: {
  text: string;
  class?: string;
  id?: string;
  label?: string;
  live?: "polite";
  tabIndex?: number;
  termOffsets?: boolean;
}): preact.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (!termOffsets) {
      renderMathText(root, text);
      return;
    }
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    const plain = (end: number) => {
      if (end <= cursor) return;
      const span = document.createElement("span");
      span.dataset.termOffset = String(cursor);
      span.textContent = text.slice(cursor, end);
      fragment.append(span);
    };
    for (const part of literalSpans(text)) {
      plain(part.start);
      const span = document.createElement("span");
      span.dataset.literalOffset = String(part.start);
      span.dataset.literalLength = String(part.value.length);
      renderMathText(span, part.value);
      fragment.append(span);
      cursor = part.start + part.value.length;
    }
    plain(text.length);
    root.replaceChildren(fragment);
  }, [text, termOffsets]);
  // This subtree belongs to KaTeX; Preact must not reconcile its text children.
  return (
    <div
      ref={ref}
      id={id}
      class={`side-math-text ${className}`}
      aria-label={label}
      aria-live={live}
      tabIndex={tabIndex}
    />
  );
}
