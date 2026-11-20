import { useEffect, useState } from "preact/hooks";
import type { Config } from "../../shared/types";

export const paperPresets = {
  warm: "#e9e4d8",
  sage: "#cadaca",
  mist: "#d4dfe7",
  grey: "#b7b9b8",
} as const;

// Lift very dark picks just enough for black text, preserving their hue.
export function readablePaperColor(hex: string): string {
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = channels;
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  if (luminance >= 0.23) return hex;
  const lift = (0.23 - luminance) / (1 - luminance);
  return (
    "#" +
    channels
      .map((channel) => {
        const linear = channel + (1 - channel) * lift;
        return Math.round((1.055 * linear ** (1 / 2.4) - 0.055) * 255)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}

export function useThemePaper(
  theme: Config["sidePanel"]["theme"] | undefined,
): string {
  const [dark, setDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = () => setDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return theme === "dark" || (theme === "system" && dark)
    ? paperPresets.grey
    : paperPresets.warm;
}
