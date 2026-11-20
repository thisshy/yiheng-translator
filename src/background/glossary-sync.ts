import browser from "webextension-polyfill";

import {
  CONFIG_STORAGE_KEY,
  glossaryIdentity,
  glossarySchema,
  migrateConfig,
  withConfigWrite,
} from "../shared/config";
import type { Config, GlossaryEntry } from "../shared/types";
import { sha256Hex } from "./services/crypto";

const PREFIX = "glossary.v1.";
const BASELINE_KEY = "glossarySyncBaseline";
const DEBOUNCE_MS = 1200;

const complete = (entry: GlossaryEntry): boolean =>
  Boolean(entry.k.trim() && entry.v.trim());

/** Keep a local glossary for the existing translation and settings entry points. */
export async function syncGlossary(): Promise<void> {
  const sync = browser.storage.sync;
  if (!sync) return;

  await withConfigWrite(async () => {
    const [stored, synced] = await Promise.all([
      browser.storage.local.get([CONFIG_STORAGE_KEY, BASELINE_KEY]),
      sync.get(null),
    ]);
    const config = migrateConfig(stored[CONFIG_STORAGE_KEY]);
    const savedBaseline: unknown = stored[BASELINE_KEY];
    const baseline = new Set(
      Array.isArray(savedBaseline)
        ? savedBaseline.filter((key): key is string => typeof key === "string")
        : [],
    );

    const local = new Map(
      config.glossaries
        .filter(complete)
        .map((entry) => [glossaryIdentity(entry), entry]),
    );
    const remote = new Map<string, { key: string; entry: GlossaryEntry }>();
    for (const [key, value] of Object.entries(synced)) {
      if (!key.startsWith(PREFIX)) continue;
      const entry = glossarySchema.safeParse(value);
      if (entry.success && complete(entry.data))
        remote.set(glossaryIdentity(entry.data), { key, entry: entry.data });
    }

    // The baseline distinguishes unsent edits from terms removed by another
    // device. On first use it is empty, so both devices contribute their terms.
    const additions: Record<string, GlossaryEntry> = {};
    for (const [id, entry] of local) {
      if (baseline.has(id) || remote.has(id)) continue;
      const key = PREFIX + (await sha256Hex(id));
      additions[key] = entry;
      remote.set(id, { key, entry });
    }
    const removals: string[] = [];
    for (const [id, { key }] of remote) {
      if (!baseline.has(id) || local.has(id)) continue;
      removals.push(key);
      remote.delete(id);
    }
    if (Object.keys(additions).length) await sync.set(additions);
    if (removals.length) await sync.remove(removals);

    const nextBaseline = [...remote.keys()].sort();
    // Keep the current row order and unfinished edits in this browser.
    const remaining = new Map(remote);
    const glossaries = config.glossaries.filter(
      (entry) => !complete(entry) || remaining.delete(glossaryIdentity(entry)),
    );
    glossaries.push(...Array.from(remaining.values(), ({ entry }) => entry));

    const changes: Record<string, Config | string[]> = {};
    if (JSON.stringify(glossaries) !== JSON.stringify(config.glossaries))
      changes[CONFIG_STORAGE_KEY] = { ...config, glossaries };
    if (JSON.stringify(nextBaseline) !== JSON.stringify(savedBaseline))
      changes[BASELINE_KEY] = nextBaseline;
    if (Object.keys(changes).length) await browser.storage.local.set(changes);
  });
}

export function registerGlossarySync(): void {
  if (!browser.storage.sync) return;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void syncGlossary().catch((error: unknown) => {
        console.warn("[imt] Could not sync the glossary", error);
      });
    }, DEBOUNCE_MS);
  };
  browser.storage.onChanged.addListener((changes, area) => {
    if (
      area === "sync" &&
      Object.keys(changes).some((key) => key.startsWith(PREFIX))
    ) {
      schedule();
    }
    const config = changes[CONFIG_STORAGE_KEY];
    if (
      area === "local" &&
      config &&
      JSON.stringify((config.oldValue as Config | undefined)?.glossaries) !==
        JSON.stringify((config.newValue as Config | undefined)?.glossaries)
    ) {
      schedule();
    }
  });
  schedule();
}
