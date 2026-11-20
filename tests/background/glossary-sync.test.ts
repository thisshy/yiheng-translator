import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  local: { get: vi.fn(), set: vi.fn() },
  sync: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));
vi.mock("webextension-polyfill", () => ({ default: { storage } }));

import { syncGlossary } from "../../src/background/glossary-sync";
import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
} from "../../src/shared/config";

describe("Chrome glossary sync", () => {
  let profile: "laptop" | "desktop";
  let local: Record<typeof profile, Record<string, unknown>>;
  let shared: Record<string, unknown>;
  const sharedTerm = { k: "waveform", v: "波形" };
  const laptopTerm = { k: "residual", v: "残差" };
  const desktopTerm = { k: "residual", v: "残量" };
  const draft = { k: "", v: "" };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("crypto", webcrypto);
    profile = "laptop";
    local = {
      laptop: {
        config: {
          ...DEFAULT_CONFIG,
          glossaries: [sharedTerm, laptopTerm, draft],
        },
      },
      desktop: {
        config: {
          ...DEFAULT_CONFIG,
          targetLanguage: "ja",
          glossaries: [{ ...sharedTerm, domain: "" }, desktopTerm],
        },
      },
    };
    shared = {};
    storage.local.get.mockImplementation(async () =>
      structuredClone(local[profile]),
    );
    storage.local.set.mockImplementation(async (changes) =>
      Object.assign(local[profile], structuredClone(changes)),
    );
    storage.sync.get.mockImplementation(async () => structuredClone(shared));
    storage.sync.set.mockImplementation(async (changes) =>
      Object.assign(shared, structuredClone(changes)),
    );
    storage.sync.remove.mockImplementation(async (keys: string[]) => {
      for (const key of keys) delete shared[key];
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("merges existing lists, then transfers edits and deletions in both directions", async () => {
    await syncGlossary();
    profile = "desktop";
    await syncGlossary();
    expect(Object.values(shared)).toEqual([
      sharedTerm,
      laptopTerm,
      desktopTerm,
    ]);
    expect((await loadConfig()).targetLanguage).toBe("ja");
    profile = "laptop";
    await syncGlossary();
    expect((await loadConfig()).glossaries).toEqual([
      sharedTerm,
      laptopTerm,
      draft,
      desktopTerm,
    ]);

    const edited = { ...laptopTerm, v: "模型残差" };
    await saveConfig({ glossaries: [sharedTerm, edited, draft, desktopTerm] });
    await syncGlossary();
    profile = "desktop";
    await syncGlossary();
    expect((await loadConfig()).glossaries).toEqual([
      { ...sharedTerm, domain: "" },
      desktopTerm,
      edited,
    ]);
    await saveConfig({ glossaries: [desktopTerm, edited] });
    await syncGlossary();
    profile = "laptop";
    await syncGlossary();
    expect((await loadConfig()).glossaries).toEqual([
      edited,
      draft,
      desktopTerm,
    ]);
    expect(Object.values(shared)).toEqual([desktopTerm, edited]);
  });

  it("keeps concurrently received terms when saving an edit from an older view", async () => {
    await syncGlossary();
    const before = (await loadConfig()).glossaries;
    profile = "desktop";
    await syncGlossary();
    profile = "laptop";
    await syncGlossary();

    const addition = { k: "inspiral", v: "旋近" };
    await saveConfig({ glossaries: [...before, addition] }, before);
    await syncGlossary();
    expect(Object.values(shared)).toEqual([
      sharedTerm,
      laptopTerm,
      desktopTerm,
      addition,
    ]);
  });

  it("preserves local terms if writing to Chrome fails and sends them on retry", async () => {
    storage.sync.set.mockRejectedValueOnce(new Error("temporary failure"));
    await expect(syncGlossary()).rejects.toThrow("temporary failure");
    expect((await loadConfig()).glossaries).toEqual([
      sharedTerm,
      laptopTerm,
      draft,
    ]);
    await syncGlossary();
    expect(Object.values(shared)).toEqual([sharedTerm, laptopTerm]);
  });
});
