"use client";
import { useEffect, useState } from "react";
import { readProgress } from "./Prefs";

export function ProgressPill({ id }: { id: string }) {
  const [label, setLabel] = useState<{ text: string; done: boolean } | null>(null);
  useEffect(() => {
    const p = readProgress(id);
    if (p.done) setLabel({ text: "Done", done: true });
    else if (p.seen.length > 1) setLabel({ text: `${p.seen.length} / 8 steps`, done: false });
    else setLabel({ text: "Start", done: false });
  }, [id]);
  return <span className={"progress-pill" + (label?.done ? " done" : "")}>{label?.text ?? ""}</span>;
}
