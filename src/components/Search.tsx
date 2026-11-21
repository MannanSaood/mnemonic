"use client";
// Static search with Pagefind. The index is built after `next build`, so search works in the
// built site (npm run build, then npm start), not in `next dev`.
import { useEffect, useRef, useState } from "react";

interface Hit { url: string; title: string; excerpt: string }
interface PFResult { data: () => Promise<{ url: string; meta: { title?: string }; excerpt: string }> }
interface PF { search: (q: string) => Promise<{ results: PFResult[] }>; options?: (o: { baseUrl: string }) => Promise<void> }

const base = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function Search() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pf = useRef<PF | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setHits(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  async function run(term: string) {
    setQ(term);
    if (!term.trim()) { setHits(null); return; }
    try {
      if (!pf.current) {
        const url = `${base}/pagefind/pagefind.js`;
        pf.current = (await import(/* webpackIgnore: true */ url)) as PF;
        // Results must link under the site's base path (for example /mnemonic on GitHub Pages).
        await pf.current.options?.({ baseUrl: `${base}/` });
      }
      const res = await pf.current.search(term);
      const data = await Promise.all(res.results.slice(0, 8).map((r) => r.data()));
      setHits(data.map((d) => ({ url: d.url, title: d.meta.title ?? d.url, excerpt: d.excerpt })));
      setError(null);
    } catch {
      setError("Search works in the built site: run npm run build, then npm start.");
      setHits([]);
    }
  }

  return (
    <div className="search" ref={box}>
      <label htmlFor="site-search" className="skip">Search</label>
      <input id="site-search" type="search" placeholder="Search…" value={q} autoComplete="off"
        onChange={(e) => run(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setHits(null); }} />
      {hits && (
        <div className="search-results">
          {error && <p>{error}</p>}
          {!error && hits.length === 0 && <p>No results for “{q}”.</p>}
          {hits.map((h) => (
            <a key={h.url} href={h.url}>
              <b>{h.title}</b>
              <span dangerouslySetInnerHTML={{ __html: h.excerpt }} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
