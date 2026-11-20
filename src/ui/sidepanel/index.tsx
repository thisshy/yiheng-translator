import { render } from "preact";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import browser from "webextension-polyfill";
import {
  clampEffort,
  supportedEfforts,
} from "../../background/services/chatgpt-oauth/reasoning";
import { getModels } from "../../background/services/service-fields";
import {
  DEFAULT_CHATGPT_MODEL,
  DEFAULT_CHATGPT_REASONING_EFFORT,
} from "../../shared/chatgpt-models";
import {
  createAssistantClient,
  runAssistant,
  type AssistantChatMessage,
  type AssistantClient,
  type AssistantRequest,
} from "../../shared/k-assistant";
import { WORKSPACE_SELECTION_PREFIX } from "../../shared/translation-workspace";
import { detectLang, normalizeLang, LANGUAGE_CODES } from "../../shared/lang";
import { parseImageTranslation } from "../../shared/image-translation";
import type {
  Config,
  ConfigPatch,
  LangCode,
  ReasoningEffort,
  TranslationMode,
} from "../../shared/types";
import { Button, Field, Select, Toggle } from "../shared/components";
import { ModelPicker } from "../shared/model-picker";
import {
  currentUiLocale,
  languageName,
  serviceName,
  setUiLocaleOverride,
  t,
} from "../shared/i18n";
import { useKConfig } from "../shared/k-config";
import { clearCache, getCacheCount } from "../shared/runtime";
import {
  captureTabImage,
  pastedImage,
  readClipboardImage,
  readImageFile,
  type ImageAttachment,
} from "./images";
import { paperPresets, readablePaperColor, useThemePaper } from "./paper";
import {
  bilingualText,
  cleanPdfText,
  isReadingResult,
  paragraphs,
  type ParagraphPair,
  type ReadingResult,
} from "./reading";
import { pickedTerm, TermEditor, type TermSelection } from "./term-editor";
import { SpeechButton } from "./speech";
import { SpeechSettings } from "./speech-settings";
import { hasMath, MathText } from "./math-text";
import { useSelectionAlignment } from "./selection-alignment";
import { loadDraft, saveDraft, type TextTool } from "./state";
import "../shared/styles.css";
import "./sidepanel.css";

const HISTORY_KEY = "kSidePanelHistory";
const FONTS = {
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  yahei: '"Microsoft YaHei", "微软雅黑", sans-serif',
  song: 'SimSun, "宋体", serif',
};
export interface TranslationHistoryItem {
  source: string;
  translation: string;
  from: LangCode;
  to: LangCode;
  service: string;
  createdAt: number;
  starred?: boolean;
  reading?: ReadingResult;
}
interface PageState {
  title: string;
  url: string;
  translated: boolean;
}

function preserveMouseSelection(event: MouseEvent): void {
  if (event.button === 0) event.preventDefault();
}

export function SidePanel({
  assistant,
}: {
  assistant?: AssistantClient;
}): preact.JSX.Element {
  const client = useMemo(
    () => assistant ?? createAssistantClient(),
    [assistant],
  );
  const { config, error, updateConfig } = useKConfig();
  const [activeTab, setActiveTab] = useState<"translate" | "chat" | "page">(
    "translate",
  );
  const [page, setPage] = useState<PageState>();
  const [source, setSource] = useState("");
  const [sourceEditing, setSourceEditing] = useState(false);
  const [attachment, setAttachment] = useState<ImageAttachment>();
  const [imageOriginal, setImageOriginal] = useState("");
  const [imageLoading, setImageLoading] = useState(false);
  const [output, setOutput] = useState("");
  const [resultSource, setResultSource] = useState("");
  const [tool, setTool] = useState<TextTool>("translate");
  const [working, setWorking] = useState(false);
  const [history, setHistory] = useState<TranslationHistoryItem[]>([]);
  const [reading, setReading] = useState<ReadingResult | null>(null);
  const [activeParagraph, setActiveParagraph] = useState<number>();
  const [selectedTerm, setSelectedTerm] = useState<TermSelection>();
  const [undoPdf, setUndoPdf] = useState<{ before: string; after: string }>();
  const [query, setQuery] = useState("");
  const [onlyStars, setOnlyStars] = useState(false);
  const [detected, setDetected] = useState<{
    text: string;
    language: LangCode;
  }>();
  const cleaned = useMemo(
    () =>
      !attachment && /[\r\n\u00ad]/.test(source)
        ? cleanPdfText(source)
        : source,
    [source, attachment],
  );
  const originalText = attachment ? imageOriginal : source;
  const fallbackLanguage = useMemo(
    () => detectLang(originalText.slice(0, 4096)),
    [originalText],
  );
  const detectedLanguage =
    detected?.text === originalText ? detected.language : fallbackLanguage;
  useEffect(() => {
    if (
      config?.sourceLanguage !== "auto" ||
      !originalText.trim() ||
      !browser.i18n?.detectLanguage
    )
      return;
    let active = true;
    const timer = window.setTimeout(() => {
      void browser.i18n
        .detectLanguage(originalText.slice(0, 4096))
        .then((info) => {
          const best = info.languages[0];
          const lang = normalizeLang(best?.language);
          if (
            active &&
            best &&
            (info.isReliable || best.percentage >= 85) &&
            lang !== "auto"
          )
            setDetected({ text: originalText, language: lang });
        })
        .catch(() => {});
    }, 240);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [originalText, config?.sourceLanguage]);
  const [draftReady, setDraftReady] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [failure, setFailureState] = useState<string>();
  const [retryTool, setRetryTool] = useState<TextTool>();
  const setFailure = (value: string | undefined): void => {
    setFailureState(value);
    setRetryTool(undefined);
  };
  const [notice, setNotice] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [previewColor, setPreviewColor] = useState<string>();
  const themePaper = useThemePaper(config?.sidePanel.theme);
  const paletteTrigger = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const sourceBodyRef = useRef<HTMLDivElement>(null);
  const resultBodyRef = useRef<HTMLDivElement>(null);
  const selectSourceOnEdit = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRevision = useRef(0);
  const controller = useRef<AbortController>();
  const edited = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let revision = 0;
    const refreshPage = async (): Promise<void> => {
      const current = ++revision;
      try {
        const tab = await sourceWebTab();
        const next =
          tab?.id === undefined
            ? undefined
            : await readPageState(tab.id, tab.title, tab.url);
        if (mounted.current && current === revision) setPage(next);
      } catch {
        if (mounted.current && current === revision) setPage(undefined);
      }
    };
    void refreshPage();
    let historyVersion = 0;
    const syncHistory = (
      changes: Record<string, browser.Storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && changes[HISTORY_KEY]) {
        ++historyVersion;
        const next = changes[HISTORY_KEY].newValue;
        setHistory(Array.isArray(next) ? next.filter(isHistoryItem) : []);
      }
    };
    browser.storage.onChanged.addListener(syncHistory);
    void loadHistory()
      .then((items) => {
        if (mounted.current && !historyVersion) setHistory(items);
      })
      .catch(() => {});
    void loadDraft().then((draft) => {
      if (!mounted.current) return;
      if (draft && !edited.current) {
        setSource(draft.source);
        setOutput(draft.output);
        setResultSource(draft.resultSource);
        setTool(draft.tool);
        setReading(draft.reading ?? null);
        if (
          draft.reading === undefined &&
          draft.tool === "translate" &&
          draft.output &&
          draft.resultSource === draft.source.trim()
        ) {
          void loadHistory()
            .then((items) => {
              const old = items.find(
                (e) =>
                  e.source === draft.resultSource &&
                  e.translation === draft.output,
              );
              if (old && mounted.current && !edited.current)
                setReading(
                  isReadingResult(old.reading)
                    ? old.reading
                    : {
                        from: old.from,
                        to: old.to,
                        pairs: [
                          { source: old.source, translation: old.translation },
                        ],
                      },
                );
            })
            .catch(() => {});
        }
        setAttachment(draft.image);
        setImageOriginal(draft.image ? (draft.imageOriginal ?? "") : "");
      }
      setDraftReady(true);
    });
    const readIncomingSelection = async (): Promise<void> => {
      const hash = window.location.hash;
      if (!/^#[a-f0-9-]{36}$/.test(hash)) return;
      const key = WORKSPACE_SELECTION_PREFIX + hash.slice(1);
      const text: unknown = (await browser.storage.session.get(key))[key];
      if (!mounted.current || hash !== window.location.hash) return;
      window.history.replaceState(null, "", window.location.pathname);
      if (typeof text !== "string" || !text.trim()) return;
      edited.current = true;
      controller.current?.abort();
      controller.current = undefined;
      setWorking(false);
      setReading(null);
      setSelectedTerm(undefined);
      setUndoPdf(undefined);
      setSource(text.trim());
      setSourceEditing(false);
      imageRevision.current += 1;
      setAttachment(undefined);
      setImageOriginal("");
      setImageLoading(false);
      setOutput("");
      setResultSource("");
      setTool("translate");
      setFailure(undefined);
      setNotice(undefined);
      setActiveTab("translate");
      sourceRef.current?.focus();
      await browser.storage.session.remove(key);
    };
    const importSelection = (): void => {
      void readIncomingSelection().catch((cause: unknown) =>
        setFailure(errorText(cause)),
      );
    };
    importSelection();
    window.addEventListener("hashchange", importSelection);
    browser.tabs.onActivated?.addListener(refreshPage);
    browser.tabs.onUpdated?.addListener(refreshPage);
    browser.tabs.onRemoved?.addListener(refreshPage);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      browser.storage.onChanged.removeListener(syncHistory);
      window.removeEventListener("hashchange", importSelection);
      browser.tabs.onActivated?.removeListener(refreshPage);
      browser.tabs.onUpdated?.removeListener(refreshPage);
      browser.tabs.onRemoved?.removeListener(refreshPage);
    };
  }, []);
  useEffect(() => {
    if (draftReady)
      void saveDraft({
        source,
        output,
        resultSource,
        tool,
        reading,
        image: attachment,
        imageOriginal,
      });
  }, [
    source,
    output,
    resultSource,
    tool,
    attachment,
    imageOriginal,
    draftReady,
    reading,
  ]);
  useEffect(() => {
    if (draftReady && !working && !attachment && !source.trim() && output) {
      setOutput("");
      setResultSource("");
    }
  }, [draftReady, working, attachment, source, output]);

  const configReady = Boolean(config);
  useEffect(() => {
    if (configReady && activeTab === "translate") sourceRef.current?.focus();
  }, [configReady, activeTab]);
  useLayoutEffect(() => {
    if (!sourceEditing) return;
    const editor = sourceRef.current;
    if (!editor) return;
    editor.focus();
    if (selectSourceOnEdit.current) {
      selectSourceOnEdit.current = false;
      editor.select();
    }
  }, [sourceEditing]);

  const sourceText = originalText;
  const sourceHasMath = hasMath(sourceText);
  const fresh =
    !working &&
    tool === "translate" &&
    !!output &&
    resultSource === sourceText.trim();
  const matched =
    fresh &&
    reading &&
    reading.pairs.map((p) => p.translation).join("\n\n") === output
      ? reading
      : null;
  const pairedView = !!matched && matched.pairs.length > 1 && !sourceEditing;
  const sourcePreview = sourceHasMath && !sourceEditing && !pairedView;
  const workspaceService = config?.sidePanel.service ?? config?.service;
  const alignment = useSelectionAlignment(
    sourceBodyRef,
    resultBodyRef,
    sourceRef,
    activeTab === "translate" ? matched : null,
    workspaceService,
    client,
    config?.glossaries,
  );

  if (!config)
    return (
      <main class="side-shell">
        <p class="ui-status">{error?.message ?? t("common.loading")}</p>
      </main>
    );
  setUiLocaleOverride(config.uiLanguage);
  const service =
    activeTab === "page"
      ? config.service
      : (workspaceService ?? config.service);
  const targetLanguage =
    config.sidePanel.targetLanguage ?? config.targetLanguage;
  const language =
    config.sourceLanguage === "auto" ? detectedLanguage : config.sourceLanguage;
  const undoAvailable = !!undoPdf && undoPdf.after === source;
  const currentEntry = matched
    ? {
        source: resultSource,
        translation: output,
        reading: matched,
        from: matched.from,
        to: matched.to,
        service,
        createdAt: Date.now(),
      }
    : undefined;
  const sameEntry = (a: TranslationHistoryItem, b: TranslationHistoryItem) =>
    a.source === b.source &&
    a.translation === b.translation &&
    a.to === b.to &&
    a.from === b.from;
  const currentStar =
    currentEntry &&
    history.some((item) => item.starred && sameEntry(item, currentEntry));
  const visibleHistory = history.filter(
    (item) =>
      (!onlyStars || item.starred) &&
      (item.source + "\n" + item.translation)
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const mutateHistory = (
    transform: (items: TranslationHistoryItem[]) => TranslationHistoryItem[],
  ): void => {
    const update = async () => {
      const items = transform(await loadHistory());
      let recent = 0;
      const kept = items.filter(
        (item) => item.starred || ++recent <= config.sidePanel.historyLimit,
      );
      await saveHistory(kept);
      if (mounted.current) setHistory(kept);
    };
    void (
      navigator.locks ? navigator.locks.request(HISTORY_KEY, update) : update()
    ).catch(() => setFailure(t("common.saveFailed")));
  };
  const toggleStar = (item: TranslationHistoryItem) => {
    mutateHistory((items) => {
      const existing = items.find((e) => sameEntry(e, item));
      return existing
        ? items.map((e) =>
            sameEntry(e, item) ? { ...e, starred: !existing.starred } : e,
          )
        : [{ ...item, starred: true }, ...items];
    });
  };
  const focusPair = (index: number, opposite: "source" | "result") => {
    setActiveParagraph(index);
    const el = document.getElementById("read-" + opposite + "-" + index);
    if (!el) return;
    const pane = el.closest<HTMLElement>(".side-source-body,.side-result-body");
    if (pane)
      pane.scrollTop +=
        el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12;
  };
  const canNavigateParagraphOnClick = (index: number) =>
    !alignment?.selection.picks.some(({ paragraph }) => paragraph === index) &&
    window.getSelection()?.isCollapsed !== false;
  const correspondingTranslation =
    alignment?.selection.side === "source" ? alignment.copyText : undefined;
  const correspondingSource =
    alignment?.selection.side === "translation"
      ? alignment.copyText
      : undefined;
  const copyText = async (text?: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t("side.copied"));
    } catch {
      setFailure(t("side.copyFailed"));
    }
  };
  const selectedColor =
    previewColor ?? config.sidePanel.backgroundColor ?? themePaper;
  const paper = readablePaperColor(selectedColor);
  const closePalette = (): void => {
    setPaletteOpen(false);
    setPreviewColor(undefined);
    paletteTrigger.current?.focus();
  };
  const serviceConfig = config.services[service];
  const model =
    serviceConfig?.model ??
    (service === "chatgpt" ? DEFAULT_CHATGPT_MODEL : "");
  const languages = LANGUAGE_CODES.filter((code) => code !== "auto").map(
    (code) => ({ value: code, label: languageName(code) }),
  );
  const save = (
    patch: ConfigPatch | ((current: Config) => ConfigPatch),
  ): void => {
    void updateConfig(patch).catch((cause: unknown) =>
      setFailure(errorText(cause)),
    );
  };
  const savePanel = (patch: Partial<Config["sidePanel"]>): void =>
    save((current) => ({ sidePanel: { ...current.sidePanel, ...patch } }));
  const saveService = (
    patch: Partial<NonNullable<typeof serviceConfig>>,
  ): void =>
    save((current) => ({
      services: {
        ...current.services,
        [service]: { ...current.services[service]!, ...patch },
      },
    }));

  const execute = async (
    nextTool: TextTool = "translate",
    rawText = source,
  ): Promise<void> => {
    const text = rawText.trim();
    if ((!text && !attachment) || controller.current || imageLoading) return;
    if (attachment && service !== "chatgpt") {
      setFailure(t("side.imageService"));
      return;
    }
    edited.current = true;
    const task = new AbortController();
    controller.current = task;
    setWorking(true);
    setReading(null);
    setSelectedTerm(undefined);
    setActiveParagraph(undefined);
    setSourceEditing(false);
    setFailure(undefined);
    setNotice(undefined);
    setTool(nextTool);
    setOutput("");
    if (attachment) setImageOriginal("");
    setResultSource(text);
    const instructions = {
      explain: `用${languageName(targetLanguage)}解释用户文本的含义和必要术语，忠于原文，不虚构背景，直接输出解释。`,
      polish:
        "润色用户文本，保留原文语言、事实、术语和格式，只输出润色后的文本。",
      summarize: `用${languageName(targetLanguage)}概括用户文本的主要内容，保留关键事实，不添加原文没有的信息，只输出摘要。`,
    };
    const request: AssistantRequest = {
      kind: nextTool === "translate" ? "translate" : "writing",
      text: text || t("side.imageDefaultPrompt"),
      ...(attachment ? { image: { dataUrl: attachment.dataUrl } } : {}),
      service,
      from: config.sourceLanguage,
      to: targetLanguage,
      instruction:
        nextTool === "translate" ? undefined : instructions[nextTool],
    };
    try {
      const parts =
        nextTool === "translate" && !attachment
          ? paragraphs(text)
          : [request.text];
      const pairs: ParagraphPair[] = [];
      let result = "";
      for (const part of parts) {
        task.signal.throwIfAborted();
        const terms =
          nextTool === "translate" && !attachment
            ? config.glossaries.filter((e) => e.k && part.includes(e.k))
            : [];
        const partRequest = { ...request, text: part };
        if (terms.length)
          partRequest.instruction =
            "Translate from " +
            request.from +
            " to " +
            request.to +
            ". Return only the translation, preserving formulas. Use these glossary entries where applicable: " +
            JSON.stringify(terms.map((e) => [e.k, e.v]));
        const prefix = result ? result + "\n\n" : "";
        const translated = await runAssistant(
          client,
          partRequest,
          (partial) => {
            if (task.signal.aborted || !mounted.current) return;
            if (attachment) {
              const parsed = parseImageTranslation(partial);
              setImageOriginal(parsed.source);
              setResultSource(parsed.source.trim());
              setOutput(parsed.translation);
            } else setOutput(prefix + partial);
          },
          task.signal,
        );
        if (task.signal.aborted || !mounted.current) return;
        if (!attachment && nextTool === "translate" && !translated.trim())
          throw new Error(t("read.emptyTranslation"));
        result = prefix + translated;
        pairs.push({ source: part, translation: translated });
        if (!attachment) setOutput(result);
      }
      if (task.signal.aborted || !mounted.current) return;
      if (attachment) {
        const parsed = parseImageTranslation(result, true);
        if (!parsed.source.trim()) throw new Error(t("side.imageNoOriginal"));
        setImageOriginal(parsed.source);
        setResultSource(parsed.source.trim());
        setOutput(parsed.translation);
        if (nextTool === "translate")
          setReading({
            from:
              config.sourceLanguage === "auto"
                ? detectLang(parsed.source)
                : config.sourceLanguage,
            to: targetLanguage,
            pairs: [{ source: parsed.source, translation: parsed.translation }],
          });
      } else if (nextTool === "translate") {
        const record = { from: language, to: targetLanguage, pairs };
        setReading(record);
        const item = {
          source: text,
          translation: result,
          from: language,
          to: targetLanguage,
          service,
          createdAt: Date.now(),
          reading: record,
        };
        mutateHistory((items) => [
          {
            ...item,
            starred: items.some((e) => sameEntry(e, item) && e.starred),
          },
          ...items.filter((e) => !sameEntry(e, item)),
        ]);
      }
    } catch (cause) {
      if (mounted.current && controller.current === task) {
        if (task.signal.aborted) setNotice(t("side.stopped"));
        else {
          setFailure(errorText(cause));
          setRetryTool(nextTool);
        }
      }
    } finally {
      if (controller.current === task) {
        controller.current = undefined;
        if (mounted.current) setWorking(false);
      }
    }
  };
  const sendChat = async (): Promise<void> => {
    const text = chatInput.trim();
    if (!text || controller.current) return;
    const task = new AbortController();
    controller.current = task;
    const prior = [...messages, { role: "user", content: text } as const];
    setMessages([...prior, { role: "assistant", content: "" }]);
    setChatInput("");
    setWorking(true);
    setFailure(undefined);
    setNotice(undefined);
    try {
      const response = await runAssistant(
        client,
        { kind: "chat", text, service, history: messages },
        (partial) => {
          if (!task.signal.aborted && mounted.current)
            setMessages([...prior, { role: "assistant", content: partial }]);
        },
        task.signal,
      );
      if (!task.signal.aborted && mounted.current)
        setMessages([...prior, { role: "assistant", content: response }]);
    } catch (cause) {
      if (mounted.current && controller.current === task) {
        if (task.signal.aborted) setNotice(t("side.stopped"));
        else {
          setMessages(prior);
          setFailure(errorText(cause));
        }
      }
    } finally {
      if (controller.current === task) {
        controller.current = undefined;
        if (mounted.current) setWorking(false);
      }
    }
  };
  const readSelection = async (): Promise<void> => {
    try {
      const tab = await sourceWebTab();
      if (tab?.id === undefined) throw new Error(t("side.noSelection"));
      const response: unknown = await browser.tabs.sendMessage(
        tab.id,
        { type: "getSelectionText" },
        { frameId: 0 },
      );
      if (
        !isRecord(response) ||
        typeof response.text !== "string" ||
        !response.text.trim()
      )
        throw new Error(t("side.noSelection"));
      edited.current = true;
      imageRevision.current += 1;
      setAttachment(undefined);
      setImageOriginal("");
      setImageLoading(false);
      setSelectedTerm(undefined);
      setUndoPdf(undefined);
      setSource(response.text.trim());
      setSourceEditing(false);
      setActiveTab("translate");
      setFailure(undefined);
      setNotice(undefined);
      sourceRef.current?.focus();
    } catch (cause) {
      setFailure(errorText(cause));
    }
  };
  const togglePage = async (): Promise<void> => {
    try {
      const tab = await sourceWebTab();
      if (tab?.id === undefined || !/^https?:/.test(tab.url ?? ""))
        throw new Error(t("side.pageUnavailable"));
      await browser.tabs.sendMessage(tab.id, {
        type: "toggleTranslate",
        tabId: tab.id,
      });
      setPage(await readPageState(tab.id, tab.title, tab.url));
      setFailure(undefined);
    } catch (cause) {
      setFailure(errorText(cause));
    }
  };
  const openPage = (path: string): void => {
    void browser.tabs
      .create({ url: browser.runtime.getURL(path) })
      .catch((cause: unknown) => setFailure(errorText(cause)));
  };
  const hostname = safeHostname(page?.url);
  const siteRule = (kind: "always" | "never", checked: boolean): void => {
    if (!hostname) return;
    save((current) => {
      const always = current.alwaysTranslateSites.filter(
          (host) => host !== hostname,
        ),
        never = current.neverTranslateSites.filter((host) => host !== hostname);
      return {
        alwaysTranslateSites:
          kind === "always" && checked ? [...always, hostname] : always,
        neverTranslateSites:
          kind === "never" && checked ? [...never, hostname] : never,
      };
    });
  };
  const clearTranslationCache = async (): Promise<void> => {
    try {
      const count = await getCacheCount();
      if (count === undefined) throw new Error(t("data.cacheClearFailed"));
      if (!window.confirm(t("popup.clearCacheConfirm", { count }))) return;
      const cleared = await clearCache();
      if (cleared === undefined) throw new Error(t("data.cacheClearFailed"));
      setNotice(t("popup.cacheCleared", { count: cleared }));
    } catch (cause) {
      setFailure(errorText(cause));
    }
  };
  const failureText = failure ?? error?.message;
  const loadImage = async (
    read: () => Promise<ImageAttachment>,
  ): Promise<void> => {
    if (controller.current) return;
    const revision = ++imageRevision.current;
    edited.current = true;
    setImageLoading(true);
    setFailure(undefined);
    setNotice(undefined);
    try {
      const image = await read();
      if (mounted.current && imageRevision.current === revision) {
        setAttachment(image);
        setSource("");
        setSourceEditing(false);
        setImageOriginal("");
        setTool("translate");
        setOutput("");
        setResultSource("");
        setActiveTab("translate");
        sourceRef.current?.focus();
      }
    } catch (cause) {
      if (mounted.current && imageRevision.current === revision)
        setFailure(errorText(cause));
    } finally {
      if (mounted.current && imageRevision.current === revision)
        setImageLoading(false);
    }
  };

  return (
    <main
      class="side-shell"
      data-theme={config.sidePanel.theme}
      style={{
        "--paper-color": paper,
        "--side-font-size": `${config.sidePanel.fontSize}px`,
        "--side-font-family": FONTS[config.sidePanel.fontFamily],
      }}
      onKeyDown={(event) => {
        if (paletteOpen && event.key === "Escape") {
          closePalette();
          return;
        }
        if (
          activeTab === "translate" &&
          !event.defaultPrevented &&
          event.key === "Enter" &&
          (event.ctrlKey || event.metaKey)
        ) {
          event.preventDefault();
          void execute();
        }
      }}
      onPaste={(event) => {
        if (activeTab !== "translate") return;
        const file = pastedImage(event.clipboardData?.items ?? []);
        if (!file) return;
        event.preventDefault();
        void loadImage(() => readImageFile(file));
      }}
    >
      <header class="side-header">
        <div class="side-brand">
          <span class="side-brand-mark" aria-hidden="true">
            文<span>A</span>
          </span>
          <h1>{t("app.name")}</h1>
        </div>
        <div class="side-header-actions">
          <div
            class="side-font-controls"
            role="group"
            aria-label={t("side.fontSize")}
          >
            <Button
              variant="quiet"
              aria-label={t("side.fontSmaller")}
              disabled={config.sidePanel.fontSize <= 14}
              onClick={() =>
                savePanel({
                  fontSize: Math.max(14, config.sidePanel.fontSize - 1),
                })
              }
            >
              A−
            </Button>
            <span aria-live="polite">{config.sidePanel.fontSize}</span>
            <Button
              variant="quiet"
              aria-label={t("side.fontLarger")}
              disabled={config.sidePanel.fontSize >= 24}
              onClick={() =>
                savePanel({
                  fontSize: Math.min(24, config.sidePanel.fontSize + 1),
                })
              }
            >
              A+
            </Button>
          </div>
          <button
            type="button"
            class="ui-button paper-trigger"
            ref={paletteTrigger}
            aria-expanded={paletteOpen}
            aria-controls="paper-palette"
            onClick={() =>
              paletteOpen ? closePalette() : setPaletteOpen(true)
            }
          >
            <span class="paper-chip" aria-hidden="true" />
            {t("paper.palette")}
          </button>
          <Button
            variant="quiet"
            aria-expanded={settingsOpen}
            aria-controls="side-settings"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            {t("side.settings")}
          </Button>
        </div>
      </header>
      {paletteOpen && (
        <section
          id="paper-palette"
          class="paper-palette"
          aria-label={t("paper.palette")}
        >
          {Object.entries(paperPresets).map(([name, color]) => (
            <button
              key={name}
              type="button"
              class="ui-button paper-preset"
              aria-pressed={selectedColor.toLowerCase() === color}
              onClick={() => {
                setPreviewColor(undefined);
                savePanel({ backgroundColor: color });
              }}
            >
              <span
                class="paper-chip"
                aria-hidden="true"
                style={{ backgroundColor: color }}
              />
              {t(`paper.${name as keyof typeof paperPresets}`)}
            </button>
          ))}
          <label class="paper-custom">
            <input
              type="color"
              value={selectedColor}
              aria-label={t("paper.custom")}
              onInput={(event) => setPreviewColor(event.currentTarget.value)}
              onChange={(event) => {
                savePanel({ backgroundColor: event.currentTarget.value });
                setPreviewColor(undefined);
              }}
            />
            {t("paper.custom")} <code>{paper.toUpperCase()}</code>
          </label>
          <Button
            variant="quiet"
            onClick={() => {
              setPreviewColor(undefined);
              savePanel({ backgroundColor: undefined });
            }}
          >
            {t("paper.reset")}
          </Button>
          {paper !== selectedColor && (
            <small role="status">{t("paper.adjusted")}</small>
          )}
        </section>
      )}
      {settingsOpen && (
        <section
          id="side-settings"
          class="side-settings"
          aria-label={t("side.settings")}
        >
          <SpeechSettings />
          <Field label={t("popup.service")} htmlFor="side-service">
            <Select
              id="side-service"
              value={service}
              disabled={working}
              options={Object.keys(config.services).map((id) => ({
                value: id,
                label: serviceName(id),
              }))}
              onChange={(next) =>
                activeTab === "page"
                  ? save({ service: next })
                  : savePanel({ service: next })
              }
            />
          </Field>
          <Field label={t("side.model")} htmlFor="side-model">
            <ModelPicker
              key={service}
              id="side-model"
              value={model}
              models={getModels(service, serviceConfig?.models)}
              disabled={working}
              placeholder={t("common.auto")}
              commitOnBlur
              onChange={(value) => {
                const next = value.trim();
                saveService({
                  model: next || undefined,
                  ...(service === "chatgpt"
                    ? {
                        reasoningEffort: clampEffort(
                          serviceConfig?.reasoningEffort ??
                            DEFAULT_CHATGPT_REASONING_EFFORT,
                          next,
                        ),
                        reasoningEffortAssistant: clampEffort(
                          serviceConfig?.reasoningEffortAssistant ??
                            DEFAULT_CHATGPT_REASONING_EFFORT,
                          next,
                        ),
                      }
                    : {}),
                });
              }}
            />
          </Field>
          {service === "chatgpt" && (
            <Field label={t("side.reasoning")} htmlFor="side-reasoning">
              <Select
                id="side-reasoning"
                value={clampEffort(
                  (tool === "translate"
                    ? serviceConfig?.reasoningEffort
                    : serviceConfig?.reasoningEffortAssistant) ??
                    DEFAULT_CHATGPT_REASONING_EFFORT,
                  model,
                )}
                disabled={working}
                options={supportedEfforts(model).map((value) => ({
                  value,
                  label: effortLabel(value),
                }))}
                onChange={(next) =>
                  saveService({
                    reasoningEffort: next as ReasoningEffort,
                    reasoningEffortAssistant: next as ReasoningEffort,
                  })
                }
              />
            </Field>
          )}
          <div class="side-two-columns">
            <Field label={t("side.fontFamily")} htmlFor="side-font">
              <Select
                id="side-font"
                value={config.sidePanel.fontFamily}
                options={[
                  { value: "system", label: t("side.fontSystem") },
                  { value: "yahei", label: t("side.fontYahei") },
                  { value: "song", label: t("side.fontSong") },
                ]}
                onChange={(next) =>
                  savePanel({
                    fontFamily: next as Config["sidePanel"]["fontFamily"],
                  })
                }
              />
            </Field>
            <Field label={t("side.appearance")} htmlFor="side-theme">
              <Select
                id="side-theme"
                value={
                  config.sidePanel.backgroundColor
                    ? "custom"
                    : config.sidePanel.theme
                }
                options={[
                  { value: "custom", label: t("paper.custom") },
                  { value: "system", label: t("side.themeSystem") },
                  { value: "light", label: t("side.themeLight") },
                  { value: "dark", label: t("side.themeDark") },
                ]}
                onChange={(next) => {
                  setPreviewColor(undefined);
                  if (next === "custom") {
                    setPaletteOpen(true);
                    savePanel({ backgroundColor: selectedColor });
                  } else {
                    savePanel({
                      theme: next as Config["sidePanel"]["theme"],
                      backgroundColor: undefined,
                    });
                  }
                }}
              />
            </Field>
          </div>
          <Button
            onClick={() => {
              void browser.runtime
                .openOptionsPage()
                .catch((cause: unknown) => setFailure(errorText(cause)));
            }}
          >
            {t("side.fullSettings")}
          </Button>
        </section>
      )}
      <nav class="side-navigation" aria-label={t("side.textTools")}>
        <div class="side-tabs" role="tablist">
          {(["translate", "page"] as const).map((panel) => (
            <button
              type="button"
              role="tab"
              disabled={working}
              key={panel}
              aria-selected={activeTab === panel}
              onClick={() => setActiveTab(panel)}
            >
              {t(`side.${panel}`)}
            </button>
          ))}
        </div>
        <div class="side-nav-actions">
          <button
            type="button"
            class="side-service-label"
            aria-expanded={settingsOpen}
            aria-controls="side-settings"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            {serviceName(service)}
            {model ? ` · ${model}` : ""}
          </button>
          <Button
            variant="quiet"
            aria-expanded={moreOpen}
            disabled={working}
            aria-controls="side-more-tools"
            onClick={() => setMoreOpen(!moreOpen)}
          >
            {t("side.moreTools")}
          </Button>
        </div>
      </nav>
      {moreOpen && (
        <section
          id="side-more-tools"
          class="side-more-tools"
          aria-label={t("side.moreTools")}
        >
          <Button
            disabled={working}
            onClick={() => {
              setActiveTab("chat");
              setMoreOpen(false);
            }}
          >
            {t("side.chat")}
          </Button>
          <Button onClick={() => openPage("src/pdf/index.html")}>
            {t("popup.translatePdf")}
          </Button>
          <Button onClick={() => openPage("src/subtitle-file/index.html")}>
            {t("popup.translateSubtitle")}
          </Button>
          <Button onClick={() => openPage("options.html#shortcuts")}>
            {t("popup.shortcuts")}
          </Button>
          <Button onClick={() => openPage("options.html#data")}>
            {t("popup.configTransfer")}
          </Button>
          <Button onClick={() => void clearTranslationCache()}>
            {t("popup.clearCache")}
          </Button>
        </section>
      )}
      {activeTab === "translate" && (
        <section class="side-workspace" aria-label={t("side.translate")}>
          <Button
            variant="quiet"
            class="side-swap"
            title={t("side.swap")}
            aria-label={t("side.swap")}
            disabled={
              working ||
              imageLoading ||
              (output
                ? !matched || (matched.from === "auto" && language === "auto")
                : language === "auto" || !!attachment)
            }
            onClick={() => {
              const from =
                matched && matched.from !== "auto" ? matched.from : language;
              const to = matched?.to ?? targetLanguage;
              if (matched) {
                edited.current = true;
                setAttachment(undefined);
                setImageOriginal("");
                setSource(output);
                setResultSource(output.trim());
                setSourceEditing(false);
                setSelectedTerm(undefined);
                setUndoPdf(undefined);
                setActiveParagraph(undefined);
                const reverse = matched.pairs.map((p) => ({
                  source: p.translation,
                  translation: p.source,
                }));
                setReading({ from: to, to: from, pairs: reverse });
                setOutput(reverse.map((p) => p.translation).join("\n\n"));
              }
              save((current) => ({
                sourceLanguage: to,
                sidePanel: { ...current.sidePanel, targetLanguage: from },
              }));
            }}
          >
            ⇄
          </Button>
          <section
            class={`side-text-card side-source-card${attachment ? " side-has-image" : ""}`}
            aria-labelledby="side-source-label"
          >
            <header class="side-card-header">
              <label id="side-source-label" htmlFor="side-source">
                {t("side.sourceLabel")}
              </label>
              <Select
                ariaLabel={t("side.sourceLanguage")}
                value={config.sourceLanguage}
                disabled={working}
                options={[
                  {
                    value: "auto",
                    label:
                      detectedLanguage === "auto"
                        ? languageName("auto")
                        : t("read.detected", {
                            language: languageName(detectedLanguage),
                          }),
                  },
                  ...languages,
                ]}
                onChange={(next) => save({ sourceLanguage: next as LangCode })}
              />
            </header>
            <div
              class="side-source-body"
              ref={sourceBodyRef}
              tabIndex={sourcePreview || pairedView ? 0 : undefined}
              onKeyDown={(event) => {
                if (
                  !(sourcePreview || pairedView) ||
                  event.defaultPrevented ||
                  !(event.ctrlKey || event.metaKey) ||
                  event.altKey ||
                  event.shiftKey ||
                  event.key.toLowerCase() !== "a"
                )
                  return;
                if (
                  event.target !== event.currentTarget &&
                  !(event.target as HTMLElement).closest("#side-source-preview")
                )
                  return;
                event.preventDefault();
                selectSourceOnEdit.current = true;
                setSourceEditing(true);
              }}
            >
              {attachment && (
                <figure class="side-image-preview">
                  <img src={attachment.dataUrl} alt={t("side.imageAlt")} />
                  <figcaption>
                    <span title={attachment.name}>{attachment.name}</span>
                    <Button
                      variant="quiet"
                      disabled={working}
                      onClick={() => {
                        edited.current = true;
                        imageRevision.current += 1;
                        setImageLoading(false);
                        setAttachment(undefined);
                        setSource(imageOriginal);
                        setSourceEditing(false);
                        setImageOriginal("");
                        setOutput("");
                        setResultSource("");
                        setFailure(undefined);
                      }}
                    >
                      {t("side.imageRemove")}
                    </Button>
                  </figcaption>
                </figure>
              )}
              {pairedView && (
                <div
                  id="side-source-preview"
                  class="side-source-preview side-reading"
                >
                  {matched!.pairs.map((p, i) => (
                    <div
                      key={i}
                      id={"read-source-" + i}
                      class="read-paragraph"
                      role="button"
                      tabIndex={0}
                      aria-pressed={activeParagraph === i}
                      onClick={() => {
                        if (canNavigateParagraphOnClick(i))
                          focusPair(i, "result");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          focusPair(i, "result");
                        }
                      }}
                    >
                      <MathText text={p.source} termOffsets />
                    </div>
                  ))}
                </div>
              )}
              {sourcePreview && (
                <MathText
                  id="side-source-preview"
                  class="side-source-preview side-reading"
                  text={sourceText.replace(/\r\n?/g, "\n")}
                  label={t("side.mathPreview")}
                  tabIndex={0}
                  termOffsets
                />
              )}
              <div
                class="side-source-editor"
                hidden={sourcePreview || pairedView}
              >
                <div
                  class="side-source-mirror side-reading"
                  aria-hidden="true"
                  hidden
                />
                <textarea
                  id="side-source"
                  ref={sourceRef}
                  class="side-reading"
                  hidden={sourcePreview || pairedView}
                  aria-label={t("side.sourceText")}
                  placeholder={
                    attachment
                      ? t("side.imageOriginalPending")
                      : t("side.noText")
                  }
                  value={attachment ? imageOriginal : source}
                  readOnly={working}
                  onInput={(event) => {
                    edited.current = true;
                    setSourceEditing(true);
                    if (attachment) setImageOriginal(event.currentTarget.value);
                    else setSource(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.ctrlKey || event.metaKey)
                    ) {
                      event.preventDefault();
                      void execute();
                    }
                  }}
                />
              </div>
              {attachment && (
                <details class="side-image-instructions">
                  <summary>{t("side.imageNoteLabel")}</summary>
                  <textarea
                    class="side-reading"
                    aria-label={t("side.imageNoteLabel")}
                    placeholder={t("side.imageNote")}
                    value={source}
                    readOnly={working}
                    onInput={(event) => {
                      edited.current = true;
                      setSource(event.currentTarget.value);
                    }}
                  />
                </details>
              )}
            </div>
            <footer class="side-card-footer">
              <div class="side-source-tools">
                {!attachment && (cleaned !== source || undoAvailable) && (
                  <Button
                    variant="quiet"
                    disabled={working}
                    onClick={() => {
                      edited.current = true;
                      if (undoAvailable) {
                        setSource(undoPdf!.before);
                        setUndoPdf(undefined);
                      } else {
                        setUndoPdf({ before: source, after: cleaned });
                        setSource(cleaned);
                      }
                      setSourceEditing(true);
                      setSelectedTerm(undefined);
                    }}
                  >
                    {undoAvailable ? t("read.undo") : t("read.clean")}
                  </Button>
                )}
                <Button
                  variant="quiet"
                  disabled={working || imageLoading || !page?.url}
                  aria-label={t("side.selection")}
                  title={t("side.selection")}
                  onClick={() => void readSelection()}
                >
                  {t("side.selectionShort")}
                </Button>
                <Button
                  variant="quiet"
                  disabled={working || imageLoading}
                  onClick={() => {
                    void navigator.clipboard
                      .readText()
                      .then((text) => {
                        edited.current = true;
                        setUndoPdf(undefined);
                        setSelectedTerm(undefined);
                        setSource(text);
                        setSourceEditing(false);
                        sourceRef.current?.focus();
                      })
                      .catch(() => setFailure(t("side.pasteFailed")));
                  }}
                >
                  {t("side.paste")}
                </Button>
                <Button
                  variant="quiet"
                  disabled={working || imageLoading}
                  onClick={() => void loadImage(readClipboardImage)}
                >
                  {t("side.imagePaste")}
                </Button>
                <Button
                  variant="quiet"
                  disabled={working || imageLoading || !page?.url}
                  onClick={() =>
                    void loadImage(async () =>
                      captureTabImage(await browser.tabs.getCurrent()),
                    )
                  }
                >
                  {t("side.imageCapture")}
                </Button>
                <Button
                  variant="quiet"
                  disabled={working || imageLoading}
                  onClick={() => fileRef.current?.click()}
                >
                  {t("side.imageChoose")}
                </Button>
                <input
                  ref={fileRef}
                  class="side-file-input"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  aria-label={t("side.imageChoose")}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void loadImage(() => readImageFile(file));
                  }}
                />
              </div>
              <div class="side-footer-actions">
                <div class="side-card-actions">
                  {(sourceHasMath || (matched && matched.pairs.length > 1)) && (
                    <Button
                      variant="quiet"
                      disabled={working}
                      aria-controls="side-source side-source-preview"
                      onClick={() => setSourceEditing(!sourceEditing)}
                    >
                      {sourcePreview || pairedView
                        ? t("side.editSource")
                        : matched && matched.pairs.length > 1
                          ? t("read.parallel")
                          : t("side.mathPreview")}
                    </Button>
                  )}
                  <SpeechButton
                    text={attachment ? imageOriginal : source}
                    language={config.sourceLanguage}
                    label={t("side.readSource")}
                    rate={config.sidePanel.sourceSpeechRate}
                    rateLabel={t("side.sourceSpeechRate")}
                    onRateChange={(rate) =>
                      savePanel({ sourceSpeechRate: rate })
                    }
                    disabled={!!attachment && working}
                  />
                  <Button
                    variant="quiet"
                    disabled={
                      working ||
                      (!source && !output && !attachment && !imageLoading)
                    }
                    onClick={() => {
                      edited.current = true;
                      imageRevision.current += 1;
                      setAttachment(undefined);
                      setImageOriginal("");
                      setImageLoading(false);
                      setUndoPdf(undefined);
                      setSelectedTerm(undefined);
                      setSource("");
                      setSourceEditing(false);
                      setOutput("");
                      setResultSource("");
                      setFailure(undefined);
                      setNotice(undefined);
                      sourceRef.current?.focus();
                    }}
                  >
                    {t("side.clear")}
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={!correspondingTranslation}
                    onMouseDown={preserveMouseSelection}
                    onClick={() => void copyText(correspondingTranslation)}
                  >
                    {t("read.copyAlignedTranslation")}
                  </Button>
                </div>
                <div class="side-run-row">
                  <Button
                    class="side-translate-button"
                    variant="primary"
                    disabled={
                      working || imageLoading || (!source.trim() && !attachment)
                    }
                    onClick={() => void execute()}
                  >
                    {working
                      ? t("side.working")
                      : attachment
                        ? t("side.imageAction")
                        : t("side.translateAction")}
                  </Button>
                  {working ? (
                    <Button
                      variant="danger"
                      onClick={() => controller.current?.abort()}
                    >
                      {t("side.stop")}
                    </Button>
                  ) : (
                    <kbd class="side-shortcut" title={t("side.shortcut")}>
                      {navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl"} +
                      Enter
                    </kbd>
                  )}
                </div>
              </div>
            </footer>
          </section>
          <section
            class="side-text-card side-result-card"
            aria-labelledby="side-result-label"
            aria-busy={working}
          >
            <header class="side-card-header">
              <h2 id="side-result-label">
                {tool === "translate"
                  ? t("side.resultLabel")
                  : t(`side.${tool}`)}
              </h2>
              <Select
                ariaLabel={t("popup.targetLanguage")}
                value={targetLanguage}
                disabled={working}
                options={languages}
                onChange={(next) =>
                  savePanel({ targetLanguage: next as LangCode })
                }
              />
            </header>
            <div class="side-result-body" ref={resultBodyRef}>
              {matched ? (
                <div class="side-output side-reading">
                  {matched.pairs.map((p, i) => (
                    <div
                      key={i}
                      id={"read-result-" + i}
                      class="read-paragraph"
                      data-active={activeParagraph === i}
                      tabIndex={0}
                      data-term-paragraph={i}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" || e.ctrlKey || e.metaKey) return;
                        e.preventDefault();
                        if (matched.pairs.length > 1) focusPair(i, "source");
                      }}
                      onClick={() => {
                        if (
                          matched.pairs.length > 1 &&
                          canNavigateParagraphOnClick(i)
                        )
                          focusPair(i, "source");
                      }}
                    >
                      <MathText text={p.translation} termOffsets />
                    </div>
                  ))}
                </div>
              ) : output ? (
                <MathText
                  class="side-output side-reading"
                  text={output}
                  live="polite"
                />
              ) : (
                <p class="side-output side-empty">
                  {working || imageLoading
                    ? t(imageLoading ? "side.imageLoading" : "side.working")
                    : t("side.resultEmpty")}
                </p>
              )}
              {output &&
                resultSource !==
                  (attachment ? imageOriginal.trim() : source.trim()) && (
                  <p class="side-stale">{t("side.originalChanged")}</p>
                )}
            </div>
            <footer class="side-card-footer">
              {matched &&
                selectedTerm &&
                matched.pairs[selectedTerm.paragraph]?.translation.slice(
                  selectedTerm.start,
                  selectedTerm.end,
                ) === selectedTerm.word && (
                  <TermEditor
                    key={[
                      selectedTerm.paragraph,
                      selectedTerm.start,
                      selectedTerm.end,
                      selectedTerm.word,
                      output,
                      service,
                    ].join("|")}
                    selection={selectedTerm}
                    pair={matched.pairs[selectedTerm.paragraph]}
                    client={client}
                    service={service}
                    from={matched.from}
                    to={matched.to}
                    entries={config.glossaries}
                    onClose={() => setSelectedTerm(undefined)}
                    onSave={async (k, v) => {
                      await updateConfig((current) => ({
                        glossaries: [
                          ...current.glossaries.filter(
                            (e) => e.k !== k || !!e.domain,
                          ),
                          { k, v },
                        ],
                      }));
                    }}
                    onReplace={(replacement) => {
                      const pairs = matched.pairs.map((p, i) =>
                        i !== selectedTerm.paragraph
                          ? p
                          : {
                              ...p,
                              translation:
                                p.translation.slice(0, selectedTerm.start) +
                                replacement +
                                p.translation.slice(selectedTerm.end),
                            },
                      );
                      const revised = { ...matched, pairs };
                      if (currentEntry && !attachment) {
                        const changed = {
                          ...currentEntry,
                          translation: pairs
                            .map((p) => p.translation)
                            .join("\n\n"),
                          reading: revised,
                        };
                        mutateHistory((items) => {
                          const prior = items.find((e) =>
                            sameEntry(e, currentEntry),
                          );
                          const duplicate = items.find((e) =>
                            sameEntry(e, changed),
                          );
                          return [
                            {
                              ...changed,
                              starred: !!(prior?.starred || duplicate?.starred),
                            },
                            ...items.filter(
                              (e) =>
                                !sameEntry(e, currentEntry) &&
                                !sameEntry(e, changed),
                            ),
                          ];
                        });
                      }
                      setReading(revised);
                      setOutput(pairs.map((p) => p.translation).join("\n\n"));
                      setSelectedTerm(undefined);
                    }}
                  />
                )}
              <div
                class="side-text-tools"
                role="group"
                aria-label={t("side.textTools")}
              >
                <button
                  type="button"
                  class="ui-button ui-button-quiet"
                  disabled={!matched}
                  title={t("read.pickHint")}
                  onMouseDown={preserveMouseSelection}
                  onClick={() => {
                    const pane = resultBodyRef.current;
                    const term = pane && pickedTerm(pane);
                    if (!term) {
                      setNotice(t("read.pickHint"));
                      return;
                    }
                    setNotice(undefined);
                    setSelectedTerm(term);
                  }}
                >
                  {t("read.terms")}
                </button>
                {(["explain", "polish", "summarize"] as const).map((kind) => (
                  <Button
                    key={kind}
                    variant="quiet"
                    disabled={
                      working || imageLoading || !!attachment || !source.trim()
                    }
                    onClick={() => void execute(kind)}
                  >
                    {t(`side.${kind}`)}
                  </Button>
                ))}
              </div>
              <div class="side-footer-actions">
                <div class="side-card-actions">
                  <SpeechButton
                    text={output}
                    language={
                      tool === "polish" ? config.sourceLanguage : targetLanguage
                    }
                    label={t("side.readResult")}
                    rate={config.sidePanel.translationSpeechRate}
                    rateLabel={t("side.translationSpeechRate")}
                    onRateChange={(rate) =>
                      savePanel({ translationSpeechRate: rate })
                    }
                    disabled={working}
                  />
                  <Button
                    variant="quiet"
                    disabled={!output}
                    onClick={() => void copyText(output)}
                  >
                    {t("side.copyResult")}
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={!correspondingSource}
                    onMouseDown={preserveMouseSelection}
                    onClick={() => void copyText(correspondingSource)}
                  >
                    {t("read.copyAlignedSource")}
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={!matched}
                    onClick={() =>
                      void copyText(
                        matched ? bilingualText(matched.pairs) : undefined,
                      )
                    }
                  >
                    {t("read.copyBoth")}
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={!currentEntry}
                    aria-pressed={!!currentStar}
                    onClick={() => {
                      if (currentEntry) toggleStar(currentEntry);
                    }}
                  >
                    {currentStar ? t("read.unstar") : t("read.star")}
                  </Button>
                </div>
              </div>
            </footer>
          </section>
        </section>
      )}
      {activeTab === "chat" && (
        <section class="side-panel side-chat" aria-label={t("side.chat")}>
          <h2>{t("side.chat")}</h2>
          <div class="side-messages side-reading" aria-live="polite">
            {messages.map((message, index) => (
              <p
                key={`${message.role}-${index}`}
                class={`message-${message.role}`}
              >
                {message.content ||
                  (working ? t("side.working") : t("side.stopped"))}
              </p>
            ))}
          </div>
          <textarea
            class="side-reading"
            aria-label={t("side.ask")}
            placeholder={t("side.ask")}
            value={chatInput}
            readOnly={working}
            onInput={(event) => setChatInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void sendChat();
              }
            }}
          />
          <Button
            variant="primary"
            disabled={working || !chatInput.trim()}
            onClick={() => void sendChat()}
          >
            {t("side.send")}
          </Button>
          {working && (
            <Button
              variant="danger"
              onClick={() => controller.current?.abort()}
            >
              {t("side.stop")}
            </Button>
          )}
        </section>
      )}
      {activeTab === "page" && (
        <section class="side-panel" aria-label={t("side.pageState")}>
          {page ? (
            <>
              <h2>{page.title || page.url}</h2>
              <p class="side-url">{page.url}</p>
              <p class="ui-status">
                {page.translated
                  ? t("side.pageTranslated")
                  : t("side.pageOriginal")}
              </p>
              <Field label={t("popup.service")} htmlFor="side-page-service">
                <Select
                  id="side-page-service"
                  value={config.service}
                  options={Object.keys(config.services).map((id) => ({
                    value: id,
                    label: serviceName(id),
                  }))}
                  onChange={(next) => save({ service: next })}
                />
              </Field>
              <Button variant="primary" onClick={() => void togglePage()}>
                {page.translated ? t("side.untranslate") : t("popup.translate")}
              </Button>
              <Field label={t("popup.mode")} htmlFor="side-mode">
                <Select
                  id="side-mode"
                  value={config.translationMode}
                  options={[
                    { value: "dual", label: t("mode.dual") },
                    { value: "translation", label: t("mode.translation") },
                  ]}
                  onChange={(mode) =>
                    save({ translationMode: mode as TranslationMode })
                  }
                />
              </Field>
              <Field
                label={t("popup.targetLanguage")}
                htmlFor="side-page-language"
              >
                <Select
                  id="side-page-language"
                  value={config.targetLanguage}
                  options={languages}
                  onChange={(next) =>
                    save({ targetLanguage: next as LangCode })
                  }
                />
              </Field>
              {hostname && (
                <>
                  <p class="side-url">{hostname}</p>
                  <Toggle
                    label={t("popup.alwaysTranslate")}
                    checked={config.alwaysTranslateSites.includes(hostname)}
                    onChange={(checked) => siteRule("always", checked)}
                  />
                  <Toggle
                    label={t("popup.neverTranslate")}
                    checked={config.neverTranslateSites.includes(hostname)}
                    onChange={(checked) => siteRule("never", checked)}
                  />
                </>
              )}
              <Button onClick={() => openPage("options.html#rules")}>
                {t("tab.rules")}
              </Button>
            </>
          ) : (
            <p class="ui-status">{t("side.loadFailed")}</p>
          )}
        </section>
      )}
      {failureText && (
        <div class="side-feedback side-error" role="alert">
          <strong>{t("side.errorTitle")}</strong>
          <p>{failureText}</p>
          {activeTab === "translate" &&
            retryTool &&
            (source.trim() || attachment) && (
              <Button
                disabled={working}
                onClick={() => void execute(retryTool)}
              >
                {t("side.retry")}
              </Button>
            )}
        </div>
      )}
      {notice && (
        <p class="side-feedback" role="status">
          {notice}
        </p>
      )}
      {activeTab === "translate" && (
        <details class="side-history-disclosure">
          <summary>
            {t("side.history")} <span>{history.length}</span>
          </summary>
          {history.length ? (
            <>
              <div class="read-library-tools">
                <input
                  type="search"
                  aria-label={t("read.search")}
                  placeholder={t("read.search")}
                  value={query}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                />
                <Button
                  aria-pressed={onlyStars}
                  onClick={() => setOnlyStars(!onlyStars)}
                >
                  {t("read.stars")}
                </Button>
              </div>
              {!visibleHistory.length && <p>{t("read.noMatch")}</p>}
              <ol class="side-history">
                {visibleHistory.map((item) => (
                  <li key={`${item.createdAt}-${item.source}`}>
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => {
                        edited.current = true;
                        imageRevision.current += 1;
                        setImageLoading(false);
                        setAttachment(undefined);
                        setImageOriginal("");
                        setSelectedTerm(undefined);
                        setUndoPdf(undefined);
                        setActiveParagraph(undefined);
                        setReading(
                          isReadingResult(item.reading)
                            ? item.reading
                            : {
                                from: item.from,
                                to: item.to,
                                pairs: [
                                  {
                                    source: item.source,
                                    translation: item.translation,
                                  },
                                ],
                              },
                        );
                        setSource(item.source);
                        setSourceEditing(false);
                        setOutput(item.translation);
                        setResultSource(item.source);
                        setTool("translate");
                        setFailure(undefined);
                        setNotice(undefined);
                        save((current) => ({
                          sourceLanguage: item.from,
                          sidePanel: {
                            ...current.sidePanel,
                            targetLanguage: item.to,
                          },
                        }));
                      }}
                    >
                      <strong>{item.source}</strong>
                      <span>{item.translation}</span>
                    </button>
                    <Button
                      variant="quiet"
                      aria-pressed={!!item.starred}
                      onClick={() => toggleStar(item)}
                    >
                      {item.starred ? t("read.unstar") : t("read.star")}
                    </Button>
                  </li>
                ))}
              </ol>
              <Button
                variant="quiet"
                onClick={() =>
                  mutateHistory((items) => items.filter((e) => e.starred))
                }
              >
                {t("side.clearHistory")}
              </Button>
            </>
          ) : (
            <p class="ui-status">{t("side.noHistory")}</p>
          )}
        </details>
      )}
    </main>
  );
}

async function sourceWebTab(): Promise<browser.Tabs.Tab | undefined> {
  const workspace = await browser.tabs.getCurrent();
  if (workspace) {
    if (workspace.openerTabId === undefined) return;
    const source = await browser.tabs
      .get(workspace.openerTabId)
      .catch(() => undefined);
    return /^https?:/.test(source?.url ?? "") ? source : undefined;
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function readPageState(
  tabId: number,
  title = "",
  url = "",
): Promise<PageState> {
  try {
    const response: unknown = await browser.tabs.sendMessage(
      tabId,
      { type: "getPageState" },
      { frameId: 0 },
    );
    if (isRecord(response))
      return {
        title: typeof response.title === "string" ? response.title : title,
        url: typeof response.url === "string" ? response.url : url,
        translated: response.translated === true,
      };
  } catch {
    /* Restricted pages still have useful tab metadata. */
  }
  return { title, url, translated: false };
}
export async function loadHistory(): Promise<TranslationHistoryItem[]> {
  const value = (await browser.storage.local.get(HISTORY_KEY))[HISTORY_KEY];
  return Array.isArray(value) ? value.filter(isHistoryItem) : [];
}
export async function saveHistory(
  history: readonly TranslationHistoryItem[],
): Promise<void> {
  await browser.storage.local.set({ [HISTORY_KEY]: [...history] });
}
function isHistoryItem(value: unknown): value is TranslationHistoryItem {
  return (
    isRecord(value) &&
    typeof value.source === "string" &&
    typeof value.translation === "string" &&
    typeof value.from === "string" &&
    typeof value.to === "string" &&
    typeof value.service === "string" &&
    typeof value.createdAt === "number"
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorText(cause: unknown): string {
  return (
    (cause instanceof Error ? cause.message : String(cause)).slice(0, 600) ||
    t("common.failed")
  );
}
function safeHostname(url?: string): string | undefined {
  try {
    return url && /^https?:/.test(url) ? new URL(url).hostname : undefined;
  } catch {
    return;
  }
}
function effortLabel(value: ReasoningEffort): string {
  const labels = currentUiLocale().startsWith("zh")
    ? {
        none: "无",
        low: "低",
        medium: "中",
        high: "高",
        xhigh: "极高",
        max: "最大",
      }
    : {
        none: "None",
        low: "Low",
        medium: "Medium",
        high: "High",
        xhigh: "Extra high",
        max: "Maximum",
      };
  return labels[value];
}
const root = document.getElementById("app");
if (root) render(<SidePanel />, root);
