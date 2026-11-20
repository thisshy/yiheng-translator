import browser from "webextension-polyfill";
import {
  TRANSLATION_WORKSPACE_PATH,
  WORKSPACE_SELECTION_PREFIX,
} from "../shared/translation-workspace";

type SourceTab = Pick<browser.Tabs.Tab, "id" | "windowId" | "url">;
let opening = Promise.resolve();

export function openTranslationWorkspace(
  source: SourceTab | undefined,
  selection?: string,
): Promise<void> {
  const opened = opening.then(() => openWorkspace(source, selection));
  opening = opened.catch(() => undefined);
  return opened;
}

async function openWorkspace(
  source: SourceTab | undefined,
  selection: string | undefined,
): Promise<void> {
  const base = browser.runtime.getURL(TRANSLATION_WORKSPACE_PATH);
  const tabs = await browser.tabs.query(
    source?.windowId === undefined
      ? { currentWindow: true }
      : { windowId: source.windowId },
  );
  const workspace = tabs.find((tab) =>
    [
      tab.url,
      (tab as browser.Tabs.Tab & { pendingUrl?: string }).pendingUrl,
    ].some((url) => url?.split("#", 1)[0] === base),
  );
  const openerTabId = /^https?:/.test(source?.url ?? "")
    ? source?.id
    : undefined;
  const opener = openerTabId === undefined ? {} : { openerTabId };
  const token = selection ? crypto.randomUUID() : undefined;
  const key = token && WORKSPACE_SELECTION_PREFIX + token;
  const url = token ? `${base}#${token}` : base;

  if (key) await browser.storage.session.set({ [key]: selection });
  try {
    if (workspace?.id === undefined) {
      await browser.tabs.create({ url, windowId: source?.windowId, ...opener });
    } else {
      await browser.tabs.update(workspace.id, {
        active: true,
        ...opener,
        ...(token ? { url } : {}),
      });
    }
  } catch (error) {
    if (key) await browser.storage.session.remove(key);
    throw error;
  }
}
