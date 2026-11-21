"use client";
// Components available inside topic MDX: <Depth level={2|3}> and <Lang only="go">.
import type { ReactNode } from "react";
import { usePrefs } from "./Prefs";
import { DEPTH_LABEL, type Depth as D, type Lang as L } from "@/lib/types";

export function Depth({ level, children }: { level: D; children: ReactNode }) {
  const { depth } = usePrefs();
  if (depth < level) return null;
  return (
    <div className="depth" data-depth={level}>
      <span className="label">{DEPTH_LABEL[level]}</span>
      {children}
    </div>
  );
}

export function Lang({ only, children }: { only: L; children: ReactNode }) {
  const { lang } = usePrefs();
  return lang === only ? <>{children}</> : null;
}
