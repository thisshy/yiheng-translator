import type { PageCommandId } from "../shared/j-types";
import type { TabMessage } from "../shared/messages";

export const CONTEXT_MENU_IDS = {
  translatePage: "imt-translate-page",
  translateSelection: "imt-translate-selection",
  translatePdf: "imt-translate-pdf",
  translateSubtitle: "imt-translate-subtitle",
  openTranslationWorkspace: "imt-open-translation-workspace",
} as const;

export interface ContextMenuCreateProperties {
  id: string;
  title: string;
  contexts: string[];
}

export interface ContextMenusApi {
  removeAll(): void | Promise<void>;
  create(properties: ContextMenuCreateProperties): string | number | void;
}

export interface ContextMenuClickInfo {
  menuItemId: string | number;
  selectionText?: string;
}

export interface ContextMenuTab {
  id?: number;
}

export interface ContextMenuDependencies {
  sendControllerCommand(tabId: number, command: PageCommandId): Promise<void>;
  sendTabMessage(tabId: number, message: TabMessage): Promise<void>;
  openExtensionPage(path: string): Promise<void>;
  openTranslationWorkspace(selection?: string): Promise<void>;
}

const MENU_DEFINITIONS: readonly ContextMenuCreateProperties[] = [
  {
    id: CONTEXT_MENU_IDS.translatePage,
    title: "翻译网页",
    contexts: ["page"],
  },
  {
    id: CONTEXT_MENU_IDS.translateSelection,
    title: "翻译选中文本",
    contexts: ["selection"],
  },
  {
    id: CONTEXT_MENU_IDS.translatePdf,
    title: "翻译本地 PDF",
    contexts: ["page"],
  },
  {
    id: CONTEXT_MENU_IDS.translateSubtitle,
    title: "翻译字幕文件",
    contexts: ["page"],
  },
  {
    id: CONTEXT_MENU_IDS.openTranslationWorkspace,
    title: "打开翻译工作台",
    contexts: ["page", "selection"],
  },
];

/** Recreate the complete menu set after extension install or update. */
export async function createContextMenus(api: ContextMenusApi): Promise<void> {
  await api.removeAll();
  for (const definition of MENU_DEFINITIONS) api.create({ ...definition });
}

/** Route a context-menu click without retaining the ContextMenus event object. */
export async function routeContextMenuClick(
  info: ContextMenuClickInfo,
  tab: ContextMenuTab | undefined,
  dependencies: ContextMenuDependencies,
): Promise<boolean> {
  const tabId = tab?.id;
  if (tabId === undefined) return false;
  const id = String(info.menuItemId);
  if (id === CONTEXT_MENU_IDS.translatePage) {
    await dependencies.sendControllerCommand(
      tabId,
      "toggleTranslateTheWholePage",
    );
    return true;
  }
  if (id === CONTEXT_MENU_IDS.translateSelection) {
    const text = info.selectionText?.trim();
    if (!text) return false;
    await dependencies.sendTabMessage(tabId, {
      type: "translateSelection",
      tabId,
      text,
    });
    return true;
  }
  if (id === CONTEXT_MENU_IDS.translatePdf) {
    await dependencies.openExtensionPage("src/pdf/index.html");
    return true;
  }
  if (id === CONTEXT_MENU_IDS.translateSubtitle) {
    await dependencies.openExtensionPage("src/subtitle-file/index.html");
    return true;
  }
  if (id === CONTEXT_MENU_IDS.openTranslationWorkspace) {
    await dependencies.openTranslationWorkspace(info.selectionText?.trim() || undefined);
    return true;
  }
  return false;
}
