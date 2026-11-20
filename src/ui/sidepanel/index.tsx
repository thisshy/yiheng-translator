import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
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
import { LANGUAGE_CODES } from "../../shared/lang";
import { parseImageTranslation } from "../../shared/image-translation";
import type {
  Config,
  ConfigPatch,
  LangCode,
  ReasoningEffort,
  TranslationMode,
} from "../../shared/types";
import { Button, Field, Select, Toggle } from "../shared/components";
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
import { SpeechButton } from "./speech";
import { SpeechSettings } from "./speech-settings";
import { hasMath, MathText } from "./math-text";
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
}
interface PageState {
  title: string;
  url: string;
  translated: boolean;
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
  const [historyReady, setHistoryReady] = useState(false);
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
    void loadHistory()
      .then((items) => {
        if (mounted.current) {
          setHistory(items);
          setHistoryReady(true);
        }
      })
      .catch(() => {
        if (mounted.current) setHistoryReady(true);
      });
    void loadDraft().then((draft) => {
      if (!mounted.current) return;
      if (draft && !edited.current) {
        setSource(draft.source);
        setOutput(draft.output);
        setResultSource(draft.resultSource);
        setTool(draft.tool);
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
      window.removeEventListener("hashchange", importSelection);
      browser.tabs.onActivated?.removeListener(refreshPage);
      browser.tabs.onUpdated?.removeListener(refreshPage);
      browser.tabs.onRemoved?.removeListener(refreshPage);
    };
  }, []);
  useEffect(() => {
    if (historyReady && config)
      void saveHistory(history.slice(0, config.sidePanel.historyLimit)).catch(
        () => setFailure(t("common.saveFailed")),
      );
  }, [history, historyReady, config?.sidePanel.historyLimit]);
  useEffect(() => {
    if (draftReady)
      void saveDraft({
        source,
        output,
        resultSource,
        tool,
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
  useEffect(() => {
    if (sourceEditing) sourceRef.current?.focus();
  }, [sourceEditing]);

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
      : (config.sidePanel.service ?? config.service);
  const targetLanguage =
    config.sidePanel.targetLanguage ?? config.targetLanguage;
  const sourceText = attachment ? imageOriginal : source;
  const sourceHasMath = hasMath(sourceText);
  const sourcePreview = sourceHasMath && !sourceEditing;
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
    const task = new AbortController();
    controller.current = task;
    setWorking(true);
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
      const result = await runAssistant(
        client,
        request,
        (partial) => {
          if (!task.signal.aborted && mounted.current) {
            if (attachment) {
              const parsed = parseImageTranslation(partial);
              setImageOriginal(parsed.source);
              setResultSource(parsed.source.trim());
              setOutput(parsed.translation);
            } else setOutput(partial);
          }
        },
        task.signal,
      );
      if (task.signal.aborted || !mounted.current) return;
      if (attachment) {
        const parsed = parseImageTranslation(result, true);
        if (!parsed.source.trim()) throw new Error(t("side.imageNoOriginal"));
        setImageOriginal(parsed.source);
        setResultSource(parsed.source.trim());
        setOutput(parsed.translation);
      } else setOutput(result);
      if (nextTool === "translate" && !attachment)
        setHistory((items) =>
          [
            {
              source: text,
              translation: result,
              from: config.sourceLanguage,
              to: targetLanguage,
              service,
              createdAt: Date.now(),
            },
            ...items,
          ].slice(0, config.sidePanel.historyLimit),
        );
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
            <input
              id="side-model"
              type="text"
              value={model}
              list="side-models"
              disabled={working}
              placeholder={t("common.auto")}
              onChange={(event) => {
                const next = event.currentTarget.value.trim();
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
            <datalist id="side-models">
              {getModels(service, serviceConfig?.models).map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
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
            disabled={working || config.sourceLanguage === "auto"}
            onClick={() =>
              save((current) => ({
                sourceLanguage: targetLanguage,
                sidePanel: {
                  ...current.sidePanel,
                  targetLanguage: current.sourceLanguage,
                },
              }))
            }
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
                  { value: "auto", label: languageName("auto") },
                  ...languages,
                ]}
                onChange={(next) => save({ sourceLanguage: next as LangCode })}
              />
            </header>
            <div class="side-source-body">
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
              {sourcePreview && (
                <MathText
                  id="side-source-preview"
                  class="side-source-preview side-reading"
                  text={sourceText}
                  label={t("side.mathPreview")}
                  tabIndex={0}
                />
              )}
              <textarea
                id="side-source"
                ref={sourceRef}
                class="side-reading"
                hidden={sourcePreview}
                aria-label={t("side.sourceText")}
                placeholder={
                  attachment ? t("side.imageOriginalPending") : t("side.noText")
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
                  {sourceHasMath && (
                    <Button
                      variant="quiet"
                      disabled={working}
                      aria-controls="side-source side-source-preview"
                      onClick={() => setSourceEditing(!sourceEditing)}
                    >
                      {sourcePreview
                        ? t("side.editSource")
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
            <div class="side-result-body">
              {output ? (
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
              <div
                class="side-text-tools"
                role="group"
                aria-label={t("side.textTools")}
              >
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
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(output)
                        .then(() => setNotice(t("side.copied")))
                        .catch(() => setFailure(t("side.copyFailed")));
                    }}
                  >
                    {t("side.copyResult")}
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
              <ol class="side-history">
                {history.slice(0, config.sidePanel.historyLimit).map((item) => (
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
                  </li>
                ))}
              </ol>
              <Button variant="quiet" onClick={() => setHistory([])}>
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
