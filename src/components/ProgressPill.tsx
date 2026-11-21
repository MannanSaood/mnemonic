"use client";
import { useEffect, useState } from "react";
import { readProgress } from "./Prefs";
import { STEP_KEYS } from "@/lib/types";

const STEPS = STEP_KEYS.length;

export function ProgressPill({ id }: { id: string }) {
  const [label, setLabel] = useState<{ text: string; done: boolean } | null>(null);
  useEffect(() => {
    const p = readProgress(id);
    const names: Record<string, string> = { overview: "Overview", engineer: "Engineer", deep: "Deep" };
    if (p.passed.length) setLabel({ text: `Done · ${p.passed.map((d) => names[d]).join(", ")}`, done: true });
    else if (p.seen.length > 1) setLabel({ text: `${p.seen.length} / ${STEPS} steps`, done: false });
    else setLabel({ text: "Start", done: false });
  }, [id]);
  return <span className={"progress-pill" + (label?.done ? " done" : "")}>{label?.text ?? ""}</span>;
}
