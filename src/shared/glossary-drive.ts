export const GLOSSARY_DRIVE_KEY = "glossaryDriveConnection";

export type GlossaryDriveProblem =
  "authorization" | "account" | "storage" | "sync";

export interface GlossaryDriveConnection {
  accountId: string;
  email?: string;
  tableId?: string;
  baseline: string[];
  problem?: GlossaryDriveProblem;
}

export class GlossaryDriveError extends Error {
  constructor(readonly problem: GlossaryDriveProblem) {
    super(problem);
  }
}

interface GoogleIdentity {
  getAuthToken(options: { interactive: boolean }): Promise<{ token?: string }>;
  removeCachedAuthToken(options: { token: string }): Promise<void>;
}

function chromeApi() {
  return (
    globalThis as typeof globalThis & {
      chrome?: {
        identity?: GoogleIdentity;
        runtime?: { getManifest(): { oauth2?: { client_id: string } } };
      };
    }
  ).chrome;
}

export function hasGlossaryDriveAuth(): boolean {
  const chrome = chromeApi();
  return (
    typeof chrome?.identity?.getAuthToken === "function" &&
    Boolean(chrome.runtime?.getManifest().oauth2?.client_id)
  );
}

export async function getGlossaryDriveToken(
  interactive = false,
): Promise<string> {
  const result = await chromeApi()
    ?.identity?.getAuthToken({ interactive })
    .catch(() => undefined);
  if (!result?.token) throw new GlossaryDriveError("authorization");
  return result.token;
}

export async function forgetGlossaryDriveToken(token: string): Promise<void> {
  await chromeApi()?.identity?.removeCachedAuthToken({ token });
}
