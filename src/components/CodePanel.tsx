"use client";
import type { PreparedCode, Range } from "@/lib/types";

/** Pre-highlighted code with optional highlighted line range and change markers. */
export function CodePanel({ code, note, lit }: { code: PreparedCode; note: string; lit?: Range | null }) {
  return (
    <div className="code">
      <div className="code-head">
        <span className="label">{code.file}</span>
        <span className="label">{note}</span>
      </div>
      <pre>
        {code.lines.map((l, i) => {
          const on = lit && l.n !== null && l.n >= lit[0] && l.n <= lit[1];
          const cls = ["ln"];
          if (l.kind !== "base") cls.push(l.kind);
          if (on) cls.push("hl");
          return (
            <span key={i} className={cls.join(" ")} data-n={l.n ?? ""}>
              <span>
                {l.toks.length === 0 ? " " : l.toks.map((t, j) => (
                  <span key={j} style={t.v ? { color: `var(--shiki-${t.v})` } : undefined}>{t.c}</span>
                ))}
              </span>
            </span>
          );
        })}
      </pre>
    </div>
  );
}
