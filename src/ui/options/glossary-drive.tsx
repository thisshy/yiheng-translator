import { useEffect, useState } from "preact/hooks";
import browser from "webextension-polyfill";

import {
  getGlossaryDriveToken,
  GLOSSARY_DRIVE_KEY,
  GlossaryDriveError,
  hasGlossaryDriveAuth,
  type GlossaryDriveConnection,
  type GlossaryDriveProblem,
} from "../../shared/glossary-drive";
import { sendToBackground } from "../../shared/messages";
import { Button } from "../shared/components";
import { t } from "../shared/i18n";

export function GlossaryDrive(): preact.JSX.Element | null {
  const [connection, setConnection] = useState<GlossaryDriveConnection>();
  const [feedback, setFeedback] = useState<GlossaryDriveProblem | "done">();
  const [busy, setBusy] = useState(false);
  const available = hasGlossaryDriveAuth();

  useEffect(() => {
    if (!available) return;
    let open = true;
    void browser.storage.local
      .get(GLOSSARY_DRIVE_KEY)
      .then((stored) => {
        if (open)
          setConnection(
            stored[GLOSSARY_DRIVE_KEY] as GlossaryDriveConnection | undefined,
          );
      })
      .catch(() => undefined);
    const changed: Parameters<
      typeof browser.storage.onChanged.addListener
    >[0] = (changes, area) => {
      if (area !== "local" || !changes[GLOSSARY_DRIVE_KEY]) return;
      setConnection(
        changes[GLOSSARY_DRIVE_KEY].newValue as
          GlossaryDriveConnection | undefined,
      );
      setFeedback(undefined);
    };
    browser.storage.onChanged.addListener(changed);
    return () => {
      open = false;
      browser.storage.onChanged.removeListener(changed);
    };
  }, [available]);

  if (!available) return null;

  const problem =
    connection?.problem ?? (feedback === "done" ? undefined : feedback);
  const authorize =
    !connection?.tableId ||
    problem === "authorization" ||
    problem === "account";
  const sync = async () => {
    setBusy(true);
    setFeedback(undefined);
    try {
      if (authorize) await getGlossaryDriveToken(true);
      const result = await sendToBackground({
        type: "syncDriveGlossary",
        connect: authorize,
      });
      setFeedback(result.problem ?? "done");
    } catch (error) {
      setFeedback(error instanceof GlossaryDriveError ? error.problem : "sync");
    } finally {
      setBusy(false);
    }
  };
  const status = connection?.email
    ? `Google Drive · ${connection.email}`
    : connection
      ? t("glossary.driveConnected")
      : t("glossary.driveConnectHint");
  const button =
    connection && authorize
      ? t("glossary.driveReauthorize")
      : connection
        ? t("glossary.driveSync")
        : t("glossary.driveConnect");

  return (
    <div class="glossary-drive">
      <div>
        <span>{status}</span>
        {connection?.tableId && (
          <a
            class="glossary-drive-link"
            href={`https://drive.google.com/file/d/${encodeURIComponent(connection.tableId)}/view`}
            target="_blank"
            rel="noreferrer"
          >
            {t("glossary.driveView")}
          </a>
        )}
        <p class="ui-status" role="status">
          {busy
            ? t("glossary.driveWorking")
            : problem
              ? t(`glossary.driveProblem.${problem}`)
              : feedback === "done"
                ? t("glossary.driveDone")
                : null}
        </p>
      </div>
      <Button disabled={busy} onClick={() => void sync()}>
        {button}
      </Button>
    </div>
  );
}
