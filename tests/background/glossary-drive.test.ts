import { createHash } from "node:crypto";
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
  glossaryIdentity,
  loadConfig,
  saveConfig,
} from "../../src/shared/config";
import { GLOSSARY_DRIVE_KEY } from "../../src/shared/glossary-drive";

interface FakeFile {
  name: string;
  body: string;
  parents?: string[];
  appProperties?: Record<string, string>;
}

describe("Google Drive glossary sync", () => {
  const laptopTerm = { k: "waveform", v: "波形" };
  const desktopTerm = { k: "residual", v: "残差", domain: "arxiv.org" };
  const draft = { k: "inspiral", v: "" };
  let profile: "laptop" | "desktop";
  let local: Record<typeof profile, Record<string, unknown>>;
  let files: Map<string, FakeFile>;
  let account: string;
  let failUpload: boolean;
  let addDuringUpload: boolean;
  let expireToken: boolean;
  const getAuthToken = vi.fn();
  const removeCachedAuthToken = vi.fn();
  const role = (file: FakeFile) => file.appProperties?.yihengGlossaryV1;
  const table = () =>
    [...files.values()].find((file) => role(file) === "table")!;
  const newId = () => `file-${files.size + 1}`;

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

        const space = url.searchParams.get("spaces");
        if (space) {
          if (expireToken) {
            expireToken = false;
            account = "another-account";
            return Response.json({}, { status: 401 });
          }
          return Response.json({
            files: [...files]
              .filter(
                ([, file]) =>
                  (space === "appDataFolder") ===
                  Boolean(file.parents?.includes("appDataFolder")),
              )
              .map(([id, { body, ...metadata }]) => ({
                id,
                ...metadata,
                sha256Checksum: createHash("sha256").update(body).digest("hex"),
              })),
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
          const id = newId();
          if (url.searchParams.get("uploadType") === "multipart") {
            const boundary = new Headers(request.headers)
              .get("Content-Type")!
              .split("boundary=")[1];
            const [, metadataPart, contentPart] = body.split(`--${boundary}`);
            const metadata = JSON.parse(
              metadataPart.split("\r\n\r\n")[1],
            ) as FakeFile;
            expect(role(files.get(metadata.parents![0])!)).toBe("folder");
            const content = contentPart.slice(
              contentPart.indexOf("\r\n\r\n") + 4,
              -2,
            );
            files.set(id, { ...metadata, body: content });
          } else {
            const metadata = JSON.parse(body) as FakeFile;
            expect(role(metadata)).toBe("folder");
            expect(metadata.parents).toBeUndefined();
            files.set(id, { ...metadata, body: "" });
          }
          return Response.json({ id });
        }
        expect(request.method).toBe("PATCH");
        if (addDuringUpload && role(files.get(id)!) === "ledger") {
          const before = (await loadConfig()).glossaries;
          await saveConfig({ glossaries: [...before, desktopTerm] });
        }
        files.set(id, { ...files.get(id)!, body });
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
    expect(
      [...files.values()].filter((file) => role(file) === "ledger"),
    ).toHaveLength(2);
    expect(table().name).toBe("译衡术语表.csv");
    expect(table().body).toBe(
      '\uFEFF原文,译文,适用域名\r\n"waveform","引力波波形",""\r\n',
    );
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
    expect(table().body).toContain(laptopTerm.v);
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
    expect(table().body).toContain(desktopTerm.v);
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
    expect(table().body).not.toContain(desktopTerm.v);
    expect((await loadConfig()).glossaries).toEqual([laptopTerm, desktopTerm]);
  });

  it("migrates the hidden glossary into a visible table without reviving deletions", async () => {
    const removed = { k: "removed", v: "旧术语" };
    const imported = {
      k: "deflection, angle",
      v: '偏转"角',
      domain: "example.org",
    };
    local.laptop.config = {
      ...DEFAULT_CONFIG,
      glossaries: [laptopTerm, removed, draft],
    };
    local.laptop[GLOSSARY_DRIVE_KEY] = {
      accountId: account,
      baseline: [laptopTerm, removed].map(glossaryIdentity),
    };
    const hidden: FakeFile = {
      name: "yiheng-glossary-v1-legacy-file",
      parents: ["appDataFolder"],
      body: JSON.stringify({
        version: 1,
        changes: [
          { entry: imported, revision: 4 },
          { entry: removed, revision: 5, deleted: true },
        ],
      }),
    };
    files.set("legacy-file", hidden);
    await expect(syncDriveGlossary()).resolves.toEqual({ connected: true });
    expect((await loadConfig()).glossaries).toEqual([
      laptopTerm,
      draft,
      imported,
    ]);
    expect(table().body).toContain(
      '"deflection, angle","偏转""角","example.org"',
    );
    expect(table().body).not.toContain(removed.k);
    expect(files.get("legacy-file")).toEqual(hidden);

    // A browser still on the previous version can make a change before it upgrades.
    hidden.body = JSON.stringify({
      version: 1,
      changes: [
        ...JSON.parse(hidden.body).changes,
        { entry: imported, revision: 9, deleted: true },
      ],
    });
    profile = "desktop";
    local.desktop[GLOSSARY_DRIVE_KEY] = { accountId: account, baseline: [] };
    await expect(syncDriveGlossary()).resolves.toEqual({ connected: true });
    profile = "laptop";
    await expect(syncDriveGlossary()).resolves.toEqual({ connected: true });
    expect((await loadConfig()).glossaries).toEqual([
      laptopTerm,
      draft,
      desktopTerm,
    ]);
    expect(table().body).not.toContain(imported.k);
    expect(
      [...files.values()].filter((file) => role(file) === "table"),
    ).toHaveLength(1);
  });
});
