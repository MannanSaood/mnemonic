"use client";
import { useEffect, useState } from "react";

type Mode = "system" | "light" | "dark";
const LABEL: Record<Mode, string> = { system: "Auto", light: "Light", dark: "Dark" };

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");
  useEffect(() => {
    try {
      const t = localStorage.getItem("mn:theme");
      if (t === "light" || t === "dark") setMode(t);
    } catch {}
  }, []);
  function choose(m: Mode) {
    setMode(m);
    try { localStorage.setItem("mn:theme", m); } catch {}
    if (m === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", m);
  }
  return (
    <div className="seg" role="group" aria-label="Theme">
      {(["system", "light", "dark"] as Mode[]).map((m) => (
        <button key={m} aria-pressed={mode === m} onClick={() => choose(m)}>{LABEL[m]}</button>
      ))}
    </div>
  );
}
