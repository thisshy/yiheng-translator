import { describe, expect, it } from "vitest";
import {
  bilingualText,
  cleanPdfText,
  paragraphs,
} from "../../src/ui/sidepanel/reading";

describe("paper text preparation", () => {
  it("joins PDF line wraps while retaining mathematical signs and paragraph boundaries", () => {
    const raw =
      "The gravita-\ntional signal-to-\nnoise ratio was measured at −2 Hz.\nThe soft\u00ad\nware agrees.\n\nNext paragraph.";
    expect(cleanPdfText(raw)).toBe(
      "The gravitational signal-to-noise ratio was measured at −2 Hz. The software agrees.\n\nNext paragraph.",
    );
  });
  it("keeps display formulas and code opaque even across empty lines", () => {
    const formula = String.raw`\begin{align}
x &= -2 \\

y &= 4
\end{align}`;
    const code = "\x60\x60\x60\nx = -4\n\ny = 6\n\x60\x60\x60";
    const raw = ["Intro", formula, code, "尾段"].join("\n\n");
    expect(cleanPdfText(raw)).toBe(raw);
    expect(paragraphs(raw)).toEqual(["Intro", formula, code, "尾段"]);
  });
  it("copies one-to-many translated paragraphs as one bilingual pair", () => {
    expect(
      bilingualText([
        { source: "A", translation: "甲\n\n乙" },
        { source: "B", translation: "丙" },
      ]),
    ).toBe("A\n甲\n\n乙\n\nB\n丙");
  });
});
