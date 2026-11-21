import type { ReactNode } from "react";
import { getGlossary } from "@/lib/content";

/** A glossary term with its definition on hover or keyboard focus. */
export function Term({ id, children }: { id: string; children?: ReactNode }) {
  const g = getGlossary()[id];
  if (!g) throw new Error(`[content] unknown glossary term "${id}"`);
  return (
    <span className="term" tabIndex={0}>
      {children ?? g.term}
      <span className="tip" role="tooltip"><b>{g.term}</b>{g.short}</span>
    </span>
  );
}
