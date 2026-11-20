import { useEffect, useState } from "preact/hooks";
import type { AssistantClient } from "../../shared/k-assistant";
import { runAssistant } from "../../shared/k-assistant";
import type { GlossaryEntry, LangCode } from "../../shared/types";
import { Button } from "../shared/components";
import { t } from "../shared/i18n";
import type { ParagraphPair } from "./reading";

export interface TermSelection {
  paragraph: number;
  start: number;
  end: number;
  word: string;
}

export function pickedTerm(resultPane: HTMLElement): TermSelection | undefined {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (range.startContainer !== range.endContainer) return;
  const span =
    range.startContainer.parentElement?.closest<HTMLElement>(
      "[data-term-offset]",
    );
  if (
    !span ||
    !resultPane.contains(span) ||
    span.firstChild !== range.startContainer
  )
    return;
  const paragraph = span.closest<HTMLElement>("[data-term-paragraph]");
  if (!paragraph) return;

  const raw = range.toString();
  const word = raw.trim();
  if (!word || word.length > 160) return;
  const start =
    Number(span.dataset.termOffset) + range.startOffset + raw.indexOf(word);
  return {
    paragraph: Number(paragraph.dataset.termParagraph),
    start,
    end: start + word.length,
    word,
  };
}

export function TermEditor({
  selection,
  pair,
  client,
  service,
  from,
  to,
  entries,
  onReplace,
  onSave,
  onClose,
}: {
  selection: TermSelection;
  pair: ParagraphPair;
  client: AssistantClient;
  service: string;
  from: LangCode;
  to: LangCode;
  entries: GlossaryEntry[];
  onReplace: (text: string) => void;
  onSave: (source: string, target: string) => Promise<void>;
  onClose: () => void;
}) {
  const [original, setOriginal] = useState("");
  const [target, setTarget] = useState(selection.word);
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const task = new AbortController();
    const existing = entries.find(
      (e) => e.v === selection.word && pair.source.includes(e.k),
    );
    if (existing) setOriginal(existing.k);
    void runAssistant(
      client,
      {
        kind: "writing",
        service,
        from,
        to,
        text: JSON.stringify({
          source: pair.source,
          translation: pair.translation,
          selected: selection.word,
          offset: selection.start,
        }),
        instruction:
          "根据给定原文和译文定位选中词语在原文中的连续片段。给出最多三个可以原位替换该词语的目标语言译法。只输出 JSON 对象，字段 source 为原文逐字摘录（无法定位时为空），alternatives 为字符串数组。",
      },
      () => {},
      task.signal,
    )
      .then((text) => {
        if (task.signal.aborted) return;
        const data = JSON.parse(
          text.trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, ""),
        );
        if (
          typeof data.source === "string" &&
          data.source &&
          pair.source.includes(data.source)
        )
          setOriginal((previous) => previous || data.source);
        if (!Array.isArray(data.alternatives)) throw new Error();
        const choices = data.alternatives.filter(
          (x: unknown): x is string =>
            typeof x === "string" &&
            !!x.trim() &&
            x.length <= 160 &&
            x !== selection.word,
        );
        setAlternatives([...new Set<string>(choices)].slice(0, 3));
      })
      .catch(() => {
        if (!task.signal.aborted) setStatus(t("read.manual"));
      })
      .finally(() => {
        if (!task.signal.aborted) setBusy(false);
      });
    return () => task.abort();
  }, []);

  return (
    <section class="term-editor" aria-label={t("read.terms")}>
      <header>
        <strong>
          {t("read.terms")} · {selection.word}
        </strong>
        <Button variant="quiet" onClick={onClose}>
          {t("read.close")}
        </Button>
      </header>
      <div class="read-actions">
        {alternatives.map((a) => (
          <Button
            key={a}
            aria-pressed={target === a}
            onClick={() => setTarget(a)}
          >
            {a}
          </Button>
        ))}
      </div>
      <label>
        {t("glossary.source")}
        <input
          value={original}
          onInput={(e) => setOriginal(e.currentTarget.value)}
        />
      </label>
      <label>
        {t("glossary.target")}
        <input
          value={target}
          onInput={(e) => setTarget(e.currentTarget.value)}
        />
      </label>
      <div class="read-actions">
        <Button
          disabled={!target.trim() || target.trim() === selection.word}
          onClick={() => onReplace(target.trim())}
        >
          {t("read.replace")}
        </Button>
        <Button
          disabled={
            !original.trim() ||
            !target.trim() ||
            !pair.source.includes(original.trim())
          }
          onClick={() =>
            void onSave(original.trim(), target.trim())
              .then(() => setStatus(t("read.savedTerm")))
              .catch(() => setStatus(t("common.saveFailed")))
          }
        >
          {t("read.saveTerm")}
        </Button>
      </div>
      <small role="status">{busy ? t("common.loading") : status}</small>
    </section>
  );
}
