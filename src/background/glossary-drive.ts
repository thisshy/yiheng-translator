import browser from "webextension-polyfill";
import { z } from "zod";

import {
  CONFIG_STORAGE_KEY,
  glossaryIdentity,
  glossarySchema,
  isCompleteGlossaryEntry,
  mergeGlossaryEdit,
  migrateConfig,
  withConfigWrite,
} from "../shared/config";
import {
  forgetGlossaryDriveToken,
  getGlossaryDriveToken,
  GLOSSARY_DRIVE_KEY,
  GlossaryDriveError,
  type GlossaryDriveConnection,
  type GlossaryDriveProblem,
} from "../shared/glossary-drive";
import type { GlossaryEntry } from "../shared/types";
import { sha256Hex } from "./services/crypto";

const DEVICE_KEY = "glossaryDriveDevice";
const FILE_PREFIX = "yiheng-glossary-v1-";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FILE_ROLE = "yihengGlossaryV1";
const FOLDER_NAME = "译衡术语同步";
const TABLE_NAME = "译衡术语表.csv";
const CSV_TYPE = "text/csv";

const driveChangeSchema = z.object({
  entry: glossarySchema.refine(isCompleteGlossaryEntry),
  revision: z.int().positive(),
  deleted: z.literal(true).optional(),
});
const driveFileSchema = z.object({
  version: z.literal(1),
  changes: z.array(driveChangeSchema),
});
const metadataSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  parents: z.array(z.string()).optional(),
  createdTime: z.string().optional(),
  sha256Checksum: z.string().optional(),
  appProperties: z.record(z.string(), z.string()).optional(),
});
const fileListSchema = z.object({
  nextPageToken: z.string().optional(),
  files: z.array(metadataSchema).default([]),
});
const createdFileSchema = metadataSchema.pick({ id: true });
const accountSchema = z.object({
  user: z.object({
    permissionId: z.string().min(1),
    emailAddress: z.string().optional(),
  }),
});

type DriveChange = z.infer<typeof driveChangeSchema>;
type DriveMetadata = z.infer<typeof metadataSchema>;
type DriveRequest = (url: string, options?: RequestInit) => Promise<unknown>;

async function driveRequest(
  token: string,
  url: string,
  options: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new GlossaryDriveError("authorization");
  if (!response.ok) {
    const result = await response.json().catch(() => undefined);
    const reasons = [
      ...(result?.error?.errors ?? []),
      ...(result?.error?.details ?? []),
    ].map(({ reason }: { reason?: string }) => reason);
    if (
      reasons.includes("insufficientPermissions") ||
      reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
    )
      throw new GlossaryDriveError("authorization");
    if (reasons.includes("storageQuotaExceeded"))
      throw new GlossaryDriveError("storage");
    throw new GlossaryDriveError("sync");
  }
  return response.json();
}

async function listDriveFiles(
  request: DriveRequest,
  spaces: "drive" | "appDataFolder",
  filter: string,
): Promise<DriveMetadata[]> {
  const files: DriveMetadata[] = [];
  const query = new URLSearchParams({
    spaces,
    q: `trashed = false and (${filter})`,
    fields:
      "nextPageToken,files(id,name,parents,createdTime,sha256Checksum,appProperties)",
    pageSize: "100",
  });
  let nextPageToken: string | undefined;
  do {
    const page = fileListSchema.parse(
      await request(`${DRIVE_API}/files?${query}`),
    );
    files.push(...page.files);
    nextPageToken = page.nextPageToken;
    if (nextPageToken) query.set("pageToken", nextPageToken);
  } while (nextPageToken);

  // Prefer the earliest folder and table if two devices provision them together.
  return files.sort((a, b) => {
    const left = (a.createdTime ?? "") + a.id;
    const right = (b.createdTime ?? "") + b.id;
    return left < right ? -1 : Number(left > right);
  });
}

async function readDriveChanges(request: DriveRequest, files: DriveMetadata[]) {
  return Promise.all(
    files.map(async (metadata) => {
      const file = driveFileSchema.parse(
        await request(
          `${DRIVE_API}/files/${encodeURIComponent(metadata.id)}?alt=media`,
        ),
      );
      return { ...metadata, changes: file.changes };
    }),
  );
}

async function writeDriveFile(
  request: DriveRequest,
  metadata: Omit<DriveMetadata, "id"> & { mimeType: string },
  body: string,
  id?: string,
): Promise<string> {
  const mimeType = metadata.mimeType;
  if (id) {
    await request(
      `${UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=media&fields=id`,
      {
        method: "PATCH",
        headers: { "Content-Type": mimeType },
        body,
      },
    );
    return id;
  }

  const boundary = `yiheng_${crypto.randomUUID()}`;
  const created = await request(
    `${UPLOAD_API}/files?uploadType=multipart&fields=id`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify(metadata),
        `--${boundary}`,
        `Content-Type: ${mimeType}`,
        "",
        body,
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    },
  );
  return createdFileSchema.parse(created).id;
}

function fileRole(role: string): string {
  return `appProperties has { key='${FILE_ROLE}' and value='${role}' }`;
}

function collectChanges(files: { changes: DriveChange[] }[]) {
  const latest = new Map<string, DriveChange>();
  for (const file of files) {
    for (const change of file.changes) {
      const id = glossaryIdentity(change.entry);
      const previous = latest.get(id);
      if (
        !previous ||
        change.revision > previous.revision ||
        (change.revision === previous.revision && change.deleted)
      )
        latest.set(id, change);
    }
  }
  return latest;
}

function glossaryCsv(terms: Map<string, GlossaryEntry>): string {
  function cell(text: string): string {
    // A term opened in a spreadsheet should be interpreted as text.
    const safe = /^[\r\n\t]|^\s*[=+\-@]/.test(text) ? "'" + text : text;
    return `"${safe.replaceAll('"', '""')}"`;
  }

  const rows = [...terms.keys()].sort().map((id) => {
    const { k, v, domain } = terms.get(id)!;
    return [k, v, domain ?? ""].map(cell).join(",");
  });
  return "\uFEFF" + ["原文,译文,适用域名", ...rows, ""].join("\r\n");
}

function problemFrom(error: unknown): GlossaryDriveProblem {
  return error instanceof GlossaryDriveError ? error.problem : "sync";
}

async function syncDrive(
  stored: Record<string, unknown>,
  token: string,
): Promise<void> {
  const request: DriveRequest = (url, options) =>
    driveRequest(token, url, options);
  const connection = stored[GLOSSARY_DRIVE_KEY] as
    GlossaryDriveConnection | undefined;
  const { user } = accountSchema.parse(
    await request(`${DRIVE_API}/about?fields=user(permissionId,emailAddress)`),
  );
  if (connection && connection.accountId !== user.permissionId)
    throw new GlossaryDriveError("account");

  const existingDevice = stored[DEVICE_KEY] as string | undefined;
  const device = existingDevice ?? crypto.randomUUID();
  if (!existingDevice)
    await browser.storage.local.set({ [DEVICE_KEY]: device });
  const name = FILE_PREFIX + device;
  const [visible, legacy] = await Promise.all([
    listDriveFiles(
      request,
      "drive",
      ["folder", "ledger", "table"].map(fileRole).join(" or "),
    ),
    connection?.tableId
      ? []
      : listDriveFiles(
          request,
          "appDataFolder",
          `name contains '${FILE_PREFIX}'`,
        ),
  ]);
  const [files, legacyFiles] = await Promise.all([
    readDriveChanges(
      request,
      visible.filter((file) => file.appProperties?.[FILE_ROLE] === "ledger"),
    ),
    readDriveChanges(request, legacy),
  ]);
  const own = files.find((file) => file.appProperties?.deviceId === device);
  const remote = collectChanges(files);
  const changes = new Map<string, DriveChange>();
  // Import old changes and tombstones once per browser. Keep their revisions
  // when another browser has already started writing to the visible folder.
  for (const [id, change] of collectChanges(legacyFiles)) {
    if (change.revision > (remote.get(id)?.revision ?? 0)) {
      remote.set(id, change);
      changes.set(id, change);
    }
  }

  const config = migrateConfig(stored[CONFIG_STORAGE_KEY]);
  const glossary = config.glossaries;
  const baseline = new Set(connection?.baseline);
  const local = new Map(
    glossary
      .filter(isCompleteGlossaryEntry)
      .map((entry) => [glossaryIdentity(entry), entry]),
  );
  let latestRevision = 0;
  for (const change of remote.values())
    latestRevision = Math.max(latestRevision, change.revision);
  const revision = latestRevision + 1;
  for (const [id, entry] of local) {
    const previous = remote.get(id);
    if (!previous || (previous.deleted && connection && !baseline.has(id)))
      changes.set(id, { entry, revision });
  }
  for (const [id, change] of remote) {
    if (!change.deleted && baseline.has(id) && !local.has(id))
      changes.set(id, { entry: change.entry, revision, deleted: true });
  }
  const folder = visible.find(
    (file) => file.appProperties?.[FILE_ROLE] === "folder",
  );
  const folderId =
    folder?.id ??
    createdFileSchema.parse(
      await request(`${DRIVE_API}/files?fields=id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: FOLDER_NAME,
          mimeType: "application/vnd.google-apps.folder",
          appProperties: { [FILE_ROLE]: "folder" },
        }),
      }),
    ).id;
  if (changes.size) {
    // Each browser updates its own file, so simultaneous uploads preserve both sets of edits.
    const outgoing = new Map(
      own?.changes.map((change) => [glossaryIdentity(change.entry), change]),
    );
    for (const [id, change] of changes) {
      outgoing.set(id, change);
      remote.set(id, change);
    }
    await writeDriveFile(
      request,
      {
        name,
        parents: [folderId],
        mimeType: "application/json",
        appProperties: { [FILE_ROLE]: "ledger", deviceId: device },
      },
      JSON.stringify({ version: 1, changes: [...outgoing.values()] }),
      own?.id,
    );
  }

  const live = new Map<string, GlossaryEntry>();
  for (const [id, change] of remote) {
    if (!change.deleted) live.set(id, change.entry);
  }
  const csv = glossaryCsv(live);
  const checksum = await sha256Hex(csv);
  const table = visible.find(
    (file) =>
      file.appProperties?.[FILE_ROLE] === "table" &&
      file.parents?.includes(folderId),
  );
  const tableId =
    table?.sha256Checksum === checksum
      ? table.id
      : await writeDriveFile(
          request,
          {
            name: TABLE_NAME,
            parents: [folderId],
            mimeType: CSV_TYPE,
            appProperties: { [FILE_ROLE]: "table" },
          },
          csv,
          table?.id,
        );
  const next: GlossaryDriveConnection = {
    accountId: user.permissionId,
    email: user.emailAddress,
    tableId,
    baseline: [...live.keys()].sort(),
  };
  const merged = glossary.filter(
    (entry) =>
      !isCompleteGlossaryEntry(entry) || live.delete(glossaryIdentity(entry)),
  );
  merged.push(...live.values());

  await withConfigWrite(async () => {
    const current = migrateConfig(
      (await browser.storage.local.get(CONFIG_STORAGE_KEY))[CONFIG_STORAGE_KEY],
    );
    const edited = mergeGlossaryEdit(current.glossaries, glossary, merged);
    const patch: Record<string, unknown> = {};
    if (JSON.stringify(edited) !== JSON.stringify(current.glossaries))
      patch[CONFIG_STORAGE_KEY] = { ...current, glossaries: edited };
    if (JSON.stringify(next) !== JSON.stringify(connection))
      patch[GLOSSARY_DRIVE_KEY] = next;
    if (Object.keys(patch).length) await browser.storage.local.set(patch);
  });
}

let pending = Promise.resolve();

export function syncDriveGlossary(connect = false): Promise<{
  connected: boolean;
  problem?: GlossaryDriveProblem;
}> {
  const operation = pending.then(async () => {
    const stored = await browser.storage.local.get([
      CONFIG_STORAGE_KEY,
      GLOSSARY_DRIVE_KEY,
      DEVICE_KEY,
    ]);
    const connection = stored[GLOSSARY_DRIVE_KEY] as
      GlossaryDriveConnection | undefined;
    if (!connection && !connect) return { connected: false };
    try {
      const token = await getGlossaryDriveToken();
      try {
        await syncDrive(stored, token);
      } catch (error) {
        // Retry from the account check so a refreshed token cannot switch drives mid-sync.
        if (problemFrom(error) !== "authorization") throw error;
        await forgetGlossaryDriveToken(token);
        const retryState = await browser.storage.local.get([
          CONFIG_STORAGE_KEY,
          GLOSSARY_DRIVE_KEY,
          DEVICE_KEY,
        ]);
        await syncDrive(retryState, await getGlossaryDriveToken());
      }
      return { connected: true };
    } catch (error) {
      const problem = problemFrom(error);
      if (connection && problem !== connection.problem)
        await browser.storage.local.set({
          [GLOSSARY_DRIVE_KEY]: { ...connection, problem },
        });
      return { connected: Boolean(connection), problem };
    }
  });
  pending = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
