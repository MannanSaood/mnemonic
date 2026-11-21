"use client";
// Reader preferences: language lens and depth lens. Stored in localStorage only.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { LANGS, type Depth, type Lang } from "@/lib/types";

interface Prefs { lang: Lang; depth: Depth; setLang: (l: Lang) => void; setDepth: (d: Depth) => void }
const Ctx = createContext<Prefs>({ lang: "go", depth: 2, setLang: () => {}, setDepth: () => {} });

function write(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch {}
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [lang, setLangS] = useState<Lang>("go");
  const [depth, setDepthS] = useState<Depth>(2);
  useEffect(() => {
    try {
      const l = localStorage.getItem("mn:lang");
      if (l && (LANGS as readonly string[]).includes(l)) setLangS(l as Lang);
      const d = Number(localStorage.getItem("mn:depth"));
      if (d === 1 || d === 2 || d === 3) setDepthS(d);
    } catch {}
  }, []);
  const setLang = useCallback((l: Lang) => { setLangS(l); write("mn:lang", l); }, []);
  const setDepth = useCallback((d: Depth) => { setDepthS(d); write("mn:depth", String(d)); }, []);
  return <Ctx.Provider value={{ lang, depth, setLang, setDepth }}>{children}</Ctx.Provider>;
}

export const usePrefs = () => useContext(Ctx);

/* ---------- progress ---------- */
export interface Progress { seen: number[]; done: boolean }
export function readProgress(id: string): Progress {
  try {
    const v = localStorage.getItem("mn:progress:" + id);
    if (v) return JSON.parse(v) as Progress;
  } catch {}
  return { seen: [], done: false };
}
export function writeProgress(id: string, p: Progress) {
  write("mn:progress:" + id, JSON.stringify(p));
}
