import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  local: { get: vi.fn(), set: vi.fn() },
  sync: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));
vi.mock("webextension-polyfill", () => ({ default: { storage } }));

import { syncDriveGlossary } from "../../src/background/glossary-drive";
import { syncGlossary } from "../../src/background/glossary-sync";
import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
} from "../../src/shared/config";
import { GLOSSARY_DRIVE_KEY } from "../../src/shared/glossary-drive";

describe("Google Drive glossary sync", () => {
  const laptopTerm = { k: "waveform", v: "波形" };
  const desktopTerm = { k: "residual", v: "残差", domain: "arxiv.org" };
  const draft = { k: "inspiral", v: "" };
  let profile: "laptop" | "desktop";
  let local: Record<typeof profile, Record<string, unknown>>;
  let files: Map<string, { name: string; body: string }>;
  let account: string;
  let failUpload: boolean;
  let addDuringUpload: boolean;
  let expireToken: boolean;
  const getAuthToken = vi.fn();
  const removeCachedAuthToken = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    account = "drive-owner";
    profile = "laptop";
    files = new Map();
    failUpload = false;
    addDuringUpload = false;
    expireToken = false;
    local = {
      laptop: {
        config: { ...DEFAULT_CONFIG, glossaries: [laptopTerm, draft] },
      },
      desktop: {
        config: {
          ...DEFAULT_CONFIG,
          targetLanguage: "ja",
          glossaries: [desktopTerm],
        },
      },
    };
    storage.local.get.mockImplementation(async () =>
      structuredClone(local[profile]),
    );
    storage.local.set.mockImplementation(async (value) =>
      Object.assign(local[profile], structuredClone(value)),
    );
    getAuthToken.mockResolvedValue({ token: "drive-test-token" });
    vi.stubGlobal("chrome", {
      identity: { getAuthToken, removeCachedAuthToken },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, request: RequestInit) => {
        const url = new URL(input);
        expect(new Headers(request.headers).get("Authorization")).toBe(
          "Bearer drive-test-token",
        );
        if (url.pathname.endsWith("/about")) {
          return Response.json({ user: { permissionId: account } });
        }

        if (url.searchParams.get("spaces") === "appDataFolder") {
          if (expireToken) {
            expireToken = false;
            account = "another-account";
            return Response.json({}, { status: 401 });
          }
          return Response.json({
            files: [...files].map(([id, { name }]) => ({ id, name })),
          });
        }

        const id = url.pathname.split("/").at(-1)!;
        if (url.searchParams.get("alt") === "media") {
          return new Response(files.get(id)?.body);
        }

        if (failUpload) {
          return Response.json(
            {
              error: { errors: [{ reason: "storageQuotaExceeded" }] },
            },
            { status: 403 },
          );
        }
        const body = String(request.body);
        if (request.method === "POST") {
          const matches = body
            .split("\r\n")
            .filter((line) => line.startsWith("{"));
          expect(JSON.parse(matches[0]).parents).toEqual(["appDataFolder"]);
          const newId = String(files.size + 1);
          files.set(newId, {
            name: JSON.parse(matches[0]).name,
            body: matches[1],
          });
          return Response.json({ id: newId });
        }
        expect(request.method).toBe("PATCH");
        if (addDuringUpload) {
          const before = (await loadConfig()).glossaries;
          await saveConfig({ glossaries: [...before, desktopTerm] });
        }
        files.set(id, { name: files.get(id)!.name, body });
        return Response.json({ id });
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("merges both old lists and transfers edits, additions and deletions", async () => {
    await expect(syncDriveGlossary()).resolves.toEqual({ connected: false });
    expect(fetch).not.toHaveBeenCalled();
    await expect(syncDriveGlossary(true)).resolves.toEqual({ connected: true });
    expect((await loadConfig()).glossaries).toEqual([laptopTerm, draft]);

    profile = "desktop";
    await expect(syncDriveGlossary(true)).resolves.toEqual({ connected: true });
    expect((await loadConfig()).glossaries).toEqual([desktopTerm, laptopTerm]);
    expect((await loadConfig()).targetLanguage).toBe("ja");
    expect(
      [...files.values()].every(
        ({ body }) => !body.includes('"targetLanguage"'),
      ),
    ).toBe(true);

    const edited = { ...laptopTerm, v: "引力波波形" };
    await saveConfig({ glossaries: [desktopTerm, edited] });
    await syncDriveGlossary();
    profile = "laptop";
    await syncDriveGlossary();
    expect((await loadConfig()).glossaries).toEqual([
      draft,
      desktopTerm,
      edited,
    ]);

    await saveConfig({ glossaries: [edited, draft] });
    await syncDriveGlossary();
    profile = "desktop";
    await syncDriveGlossary();
    expect((await loadConfig()).glossaries).toEqual([edited]);
    expect(files.size).toBe(2);
    await syncGlossary();
    expect(storage.sync.set).not.toHaveBeenCalled();
  });

  it("keeps local terms after a failed upload and sends them when retrying", async () => {
    failUpload = true;
    await expect(syncDriveGlossary(true)).resolves.toEqual({
      connected: false,
      problem: "storage",
    });
    expect(local.laptop[GLOSSARY_DRIVE_KEY]).toBeUndefined();
    expect((await loadConfig()).glossaries).toEqual([laptopTerm, draft]);
    failUpload = false;
    await expect(syncDriveGlossary(true)).resolves.toEqual({ connected: true });
    expect(files.size).toBe(1);
  });

  it("preserves edits made locally during the Drive upload", async () => {
    await syncDriveGlossary(true);
    const statement = { k: "binary", v: "双星" };
    await saveConfig({ glossaries: [laptopTerm, draft, statement] });
    addDuringUpload = true;
    await syncDriveGlossary();
    expect((await loadConfig()).glossaries).toEqual([
      laptopTerm,
      draft,
      statement,
      desktopTerm,
    ]);
    addDuringUpload = false;
    await syncDriveGlossary();
    expect([...files.values()][0].body).toContain(desktopTerm.v);
  });

  it("checks the account again if the token expires before an upload", async () => {
    await syncDriveGlossary(true);
    await saveConfig({ glossaries: [laptopTerm, desktopTerm] });
    expireToken = true;
    await expect(syncDriveGlossary()).resolves.toEqual({
      connected: true,
      problem: "account",
    });
    expect(removeCachedAuthToken).toHaveBeenCalledOnce();
    expect([...files.values()][0].body).not.toContain(desktopTerm.v);
    expect((await loadConfig()).glossaries).toEqual([laptopTerm, desktopTerm]);
  });
});
