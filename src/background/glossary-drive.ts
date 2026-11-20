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

const DEVICE_KEY = "glossaryDriveDevice";
const FILE_PREFIX = "yiheng-glossary-v1-";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

const driveChangeSchema = z.object({
  entry: glossarySchema.refine(isCompleteGlossaryEntry),
  revision: z.int().positive(),
  deleted: z.literal(true).optional(),
});
const driveFileSchema = z.object({
  version: z.literal(1),
  changes: z.array(driveChangeSchema),
});
const fileListSchema = z.object({
  nextPageToken: z.string().optional(),
  files: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});
const accountSchema = z.object({
  user: z.object({
    permissionId: z.string().min(1),
    emailAddress: z.string().optional(),
  }),
});

type DriveChange = z.infer<typeof driveChangeSchema>;
type DriveFile = z.infer<typeof driveFileSchema>;
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
    if (
      result?.error?.errors?.some(
        ({ reason }: { reason?: string }) => reason === "storageQuotaExceeded",
      )
    )
      throw new GlossaryDriveError("storage");
    throw new GlossaryDriveError("sync");
  }
  return response.json();
}

async function readDriveFiles(request: DriveRequest) {
  const files: z.infer<typeof fileListSchema>["files"] = [];
  const query = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name contains '${FILE_PREFIX}' and trashed = false`,
    fields: "nextPageToken,files(id,name)",
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

  // Stable order also resolves equal revisions from concurrent edits.
  const ordered = files.sort((a, b) => {
    const left = a.name + a.id;
    const right = b.name + b.id;
    return left < right ? -1 : Number(left > right);
  });
  return Promise.all(
    ordered.map(async ({ id, name }) => {
      const file = driveFileSchema.parse(
        await request(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`),
      );
      return { id, name, changes: file.changes };
    }),
  );
}

async function writeDriveFile(
  request: DriveRequest,
  name: string,
  file: DriveFile,
  id?: string,
): Promise<void> {
  const body = JSON.stringify(file);
  if (id) {
    await request(
      `${UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=media&fields=id`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );
    return;
  }

  const boundary = `yiheng_${crypto.randomUUID()}`;
  const metadata = JSON.stringify({
    name,
    parents: ["appDataFolder"],
    mimeType: "application/json",
  });
  await request(`${UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      metadata,
      `--${boundary}`,
      "Content-Type: application/json",
      "",
      body,
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  });
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
  const files = await readDriveFiles(request);
  const own = files.find((file) => file.name === name);
  const remote = new Map<string, DriveChange>();
  let latestRevision = 0;
  for (const file of files) {
    for (const change of file.changes) {
      const id = glossaryIdentity(change.entry);
      if (change.revision >= (remote.get(id)?.revision ?? 0))
        remote.set(id, change);
      latestRevision = Math.max(latestRevision, change.revision);
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
  const changes = new Map<string, DriveChange>();
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
      name,
      { version: 1, changes: [...outgoing.values()] },
      own?.id,
    );
  }

  const live = new Map<string, GlossaryEntry>();
  for (const [id, change] of remote) {
    if (!change.deleted) live.set(id, change.entry);
  }
  const next: GlossaryDriveConnection = {
    accountId: user.permissionId,
    email: user.emailAddress,
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
