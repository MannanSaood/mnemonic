import { createCssVariablesTheme, createHighlighter, type Highlighter } from "shiki";
import type { Lang, Tok } from "./types.ts";

// Colours come from CSS variables (--shiki-token-*), so code follows the light/dark theme
// without highlighting twice.
const theme = createCssVariablesTheme({ name: "mnemonic", variablePrefix: "--shiki-", fontStyle: true });

let hl: Promise<Highlighter> | null = null;
function highlighter() {
  hl ??= createHighlighter({ themes: [theme], langs: ["go", "python", "typescript", "rust"] });
  return hl;
}

/** Highlight a source string and return one token list per line. */
export async function highlightLines(code: string, lang: Lang): Promise<Tok[][]> {
  const h = await highlighter();
  const lines = h.codeToTokensBase(code, { lang, theme });
  return lines.map((line) =>
    line.map((t) => {
      const tok: Tok = { c: t.content };
      if (t.color) tok.v = t.color.replace(/^var\(--shiki-/, "").replace(/\)$/, "");
      return tok;
    }),
  );
}
