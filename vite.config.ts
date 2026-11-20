import { crx } from "@crxjs/vite-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

import manifest from "./src/manifest.ts";

export default defineConfig(({ mode }) => {
  const driveClientId = loadEnv(
    mode,
    process.cwd(),
    "YIHENG_",
  ).YIHENG_GOOGLE_DRIVE_CLIENT_ID?.trim();
  return {
    plugins: [
      crx({
        manifest:
          driveClientId && "permissions" in manifest
            ? {
                ...manifest,
                permissions: [...(manifest.permissions ?? []), "identity"],
                oauth2: {
                  client_id: driveClientId,
                  scopes: ["https://www.googleapis.com/auth/drive.appdata"],
                },
              }
            : manifest,
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          translator: fileURLToPath(
            new URL("./translator.html", import.meta.url),
          ),
          pdf: fileURLToPath(new URL("./src/pdf/index.html", import.meta.url)),
          subtitleFile: fileURLToPath(
            new URL("./src/subtitle-file/index.html", import.meta.url),
          ),
        },
      },
    },
  };
});
