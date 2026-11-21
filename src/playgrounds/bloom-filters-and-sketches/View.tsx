"use client";
import { useMemo } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, K_MAX, LINKS_PER_PAGE, MAX_URLS, M_OPTIONS, SET_BYTES_PER_URL, STORE_MS,
  bestK, curve, falseNegatives, fill, formula, init, measured, step,
  type Bits, type State, type Verdict,
} from "./model";

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const n0 = (x: number) => x.toLocaleString("en");

const VERDICT: Record<Verdict, { text: string; tone: "ok" | "warn" | "bad" | "info" }> = {
  new: { text: "New URL. The filter said no, so the crawler skipped the database, crawled it and set its bits.", tone: "ok" },
  seen: { text: "Crawled before. The filter said maybe, the database confirmed it, and the link was dropped.", tone: "info" },
  falsePositive: { text: "False positive: every bit was already set by other URLs, so the filter said maybe for a URL it never saw. The database said no, and the page was crawled after a wasted lookup.", tone: "warn" },
  falseNegative: { text: "False negative: this page was crawled before, but a delete cleared one of its bits. The filter said no, the database was skipped, and the page was crawled again.", tone: "bad" },
  probeNo: { text: "A URL the crawler never saw. At least one of its bits is 0, so the answer is a certain no.", tone: "ok" },
  probeFp: { text: "A URL the crawler never saw, and all its bits happen to be set: a false positive.", tone: "warn" },
  removed: { text: "Removed by clearing its bits. Every other URL that shared one of those bits now tests no.", tone: "bad" },
};

function BitArray({ st, reduced }: { st: State; reduced: boolean }) {
  const pos = new Set(st.last?.positions ?? []);
  const tone = st.last ? VERDICT[st.last.verdict].tone : "info";
  const cols = st.m <= 256 ? 32 : 64;
  return (
    <div className={`bf-bits${reduced ? "" : " anim"}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      role="img" aria-label={`Bit array of ${st.m} bits, ${Math.round(fill(st.bits) * 100)}% set. The last URL checked bits ${[...pos].join(", ")}.`}>
      {st.bits.map((b, i) => (
        <span key={i} className={`bf-bit${b ? " on" : ""}${pos.has(i) ? ` hit ${tone}` : ""}`} />
      ))}
    </div>
  );
}

function Curve({ st }: { st: State }) {
  const data = useMemo(() => curve(st.crawled, st.m), [st.crawled, st.m]);
  const top = Math.max(0.05, ...data.map((d) => Math.max(d.measured, d.formula)));
  const W = 320, H = 120, pad = 22, bw = (W - pad) / K_MAX;
  const y = (v: number) => H - 14 - (v / top) * (H - 24);
  const line = data.map((d, i) => `${i ? "L" : "M"}${pad + i * bw + bw / 2},${y(d.formula)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="bf-curve" role="img"
      aria-label={`False-positive rate by number of hashes for ${st.crawled.length} URLs in ${st.m} bits. ${data.map((d) => `k ${d.k}: ${pct(d.measured)}`).join(", ")}.`}>
      <text x={2} y={10} className="bf-ax">{pct(top)}</text>
      <text x={2} y={H - 14} className="bf-ax">0</text>
      {data.map((d, i) => (
        <g key={d.k}>
          <rect x={pad + i * bw + 3} y={y(d.measured)} width={bw - 6} height={H - 14 - y(d.measured)} className={d.k === st.k ? "bf-bar cur" : "bf-bar"} />
          <text x={pad + i * bw + bw / 2} y={H - 2} textAnchor="middle" className={d.k === st.k ? "bf-ax cur" : "bf-ax"}>k{d.k}</text>
        </g>
      ))}
      <path d={line} className="bf-formula" />
    </svg>
  );
}

function Result({ st }: { st: State }) {
  const n = st.crawled.length;
  const fp = measured(st.bits, st.k);
  const naiveMs = st.links * STORE_MS, filterMs = st.storeLookups * STORE_MS;
  const fn = falseNegatives(st).length;
  let take: string;
  if (fn || st.recrawls) take = `Clearing bits to delete broke the one promise a Bloom filter makes: ${fn} crawled URL${fn === 1 ? "" : "s"} now test no${st.recrawls ? `, and ${st.recrawls} page${st.recrawls === 1 ? " was" : "s were"} crawled again` : ""}. Bits are shared, so a plain Bloom filter cannot delete. Rebuild it, or use a counting Bloom filter or a cuckoo filter.`;
  else if (fp > 0.1) take = `At ${(st.m / n).toFixed(1)} bits per URL the array is ${pct(fill(st.bits))} set, so random URLs find all their bits set ${pct(fp)} of the time. More bits per URL is the only real fix; about 10 bits per URL with ${bestK(n, st.m)} hashes gives about 1%.`;
  else take = `Every "no" skipped the database for certain, and the price is ${pct(fp)} false positives at ${(st.m / n).toFixed(1)} bits per URL. A hash set holding the same URLs would need about ${n0(n * SET_BYTES_PER_URL)} bytes; the filter uses ${n0(st.m / 8)}.`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your filter did</span>
      <p>{n} URLs in {st.m} bits ({(st.m / n).toFixed(1)} bits per URL) with {st.k} hash{st.k === 1 ? "" : "es"}: measured false positives {pct(fp)}, formula {pct(formula(n, st.m, st.k))}. Of {n0(st.links)} links, the database was asked {n0(st.storeLookups)} times instead of {n0(st.links)} ({n0(filterMs)} ms instead of {n0(naiveMs)} ms at {STORE_MS} ms each); {st.falsePositives} of those asks were false positives.</p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function BloomPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const n = st.crawled.length;
  const fp = n ? measured(st.bits, st.k) : 0;
  const fn = falseNegatives(st).length;
  const recent = st.crawled.slice(-5).reverse();
  const revealed = n >= 32 && st.kTried.length >= 3;
  const full = n >= MAX_URLS;

  return (
    <PgFrame title="Has this URL been crawled?" onReset={() => dispatch({ type: "reset" })}>
      <PgPredict
        question="Keep 256 bits and crawl until the filter holds 32 or more URLs, about 8 bits per URL. Then try several hash counts. Which k gives the fewest false positives?"
        options={[{ value: "1", label: "k = 1, fewest bits to check" }, { value: "mid", label: "In the middle, 3 to 6" }, { value: "8", label: "k = 8, most checks" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={revealed}
        answer="mid"
        explain={<>The best k is about (m/n) · ln 2, here {((st.m / Math.max(1, n)) * Math.LN2).toFixed(1)}. One hash leaves too little evidence: a single set bit is easy to hit by chance. Many hashes set so many bits that the array fills up. In between, each URL sets enough bits to be specific while about half the array stays 0.</>}
      />

      <div className="pg-req">
        <span className="label">Crawl · {n} of {MAX_URLS} URLs · each page links to {LINKS_PER_PAGE} URLs, about half already crawled</span>
        <div className="pg-actions">
          <PgButton primary onClick={() => dispatch({ type: "crawl", pages: 1 })} disabled={full}>Crawl a page</PgButton>
          <PgButton onClick={() => dispatch({ type: "crawl", pages: 5 })} disabled={full}>Crawl 5 pages</PgButton>
          <PgButton onClick={() => dispatch({ type: "probe" })}>Check a URL never crawled</PgButton>
        </div>
        <div className="bf-rows">
          <span className="pg-place">Bits m</span>
          <PgChoice<string> label="Bits in the filter" value={String(st.m)} onChange={(v) => dispatch({ type: "m", m: Number(v) as Bits })}
            options={M_OPTIONS.map((m) => ({ value: String(m), label: `${m} (${m / 8} B)` }))} />
          <span className="pg-place">Hashes k</span>
          <PgChoice<string> label="Hash functions" value={String(st.k)} onChange={(v) => dispatch({ type: "k", k: Number(v) })}
            options={Array.from({ length: K_MAX }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />
        </div>
        <p className="muted">Changing m or k rebuilds the filter from the crawl database. A link the filter says no to skips the database; a maybe costs a {STORE_MS} ms database lookup.</p>
      </div>

      <div className="pg-card">
        <span className="label">Bit array · {st.m} bits · {pct(fill(st.bits))} set · outlined: the bits of the last URL</span>
        <BitArray st={st} reduced={reduced} />
        {st.last ? (
          <p className={`bf-last ${VERDICT[st.last.verdict].tone}`} aria-live="polite">
            <code>{st.last.url}</code> · bits {st.last.positions.join(", ")}. {VERDICT[st.last.verdict].text}
          </p>
        ) : <p className="muted">Crawl a page to set bits.</p>}
      </div>

      <div className="pg-sides">
        <div className="pg-side">
          <header><h4>False positives</h4><span className={"pg-status" + (fp < 0.02 ? " done" : "")}>{n ? `${pct(fp)} measured` : "empty"}</span></header>
          <Curve st={st} />
          <p className="muted">Bars: share of 2,000 never-crawled URLs the filter says maybe to, for each k with your URLs. Line: (1 − e^(−kn/m))^k.</p>
          <dl className="pg-stats bf-stats">
            <div><dt>Bits / URL</dt><dd>{n ? (st.m / n).toFixed(1) : "-"}</dd></div>
            <div><dt>Best k</dt><dd>{n ? bestK(n, st.m) : "-"}</dd></div>
            <div><dt>Formula</dt><dd>{pct(formula(n, st.m, st.k))}</dd></div>
          </dl>
        </div>
        <div className="pg-side">
          <header><h4>The database behind it</h4><span className="pg-status done">{st.links ? `${pct(1 - st.storeLookups / st.links)} skipped` : "idle"}</span></header>
          <dl className="pg-stats bf-stats">
            <div><dt>Links</dt><dd>{n0(st.links)}</dd></div>
            <div><dt>Said no</dt><dd>{n0(st.skipped)}</dd></div>
            <div><dt>DB lookups</dt><dd>{n0(st.storeLookups)}</dd></div>
            <div className={st.falsePositives ? "bad" : ""}><dt>Wasted lookups</dt><dd>{st.falsePositives}</dd></div>
            <div><dt>Filter size</dt><dd>{n0(st.m / 8)} B</dd></div>
            <div><dt>Hash set size</dt><dd>~{n0(n * SET_BYTES_PER_URL)} B</dd></div>
          </dl>
          <span className="pg-place">Break it: a page returned 410 Gone, so delete it from the filter</span>
          <ul className="bf-recent">
            {recent.map((u) => (
              <li key={u}><code>{u.replace("https://", "")}</code><button className="pg-btn bf-del" onClick={() => dispatch({ type: "remove", url: u })}>Clear its bits</button></li>
            ))}
            {!recent.length && <li className="muted">Nothing crawled yet.</li>}
          </ul>
          <dl className="pg-stats bf-stats">
            <div className={fn ? "bad" : ""}><dt>Crawled, test no</dt><dd>{fn}</dd></div>
            <div className={st.recrawls ? "bad" : ""}><dt>Crawled twice</dt><dd>{st.recrawls}</dd></div>
            <div><dt>Deleted</dt><dd>{st.removed}</dd></div>
          </dl>
        </div>
      </div>

      <div className="pg-req">
        <span className="label">Challenges: {CHALLENGES.filter((c) => st.done[c.id]).length} of {CHALLENGES.length}</span>
        <ul className="bf-list">
          {CHALLENGES.map((c) => <li key={c.id} className={st.done[c.id] ? "got" : ""}><span aria-hidden="true">{st.done[c.id] ? "■" : "□"}</span> {c.text}</li>)}
        </ul>
      </div>

      {n >= 20 && <Result st={st} />}

      <PgSources links={[
        { title: "Jason Davies' interactive Bloom filter", href: "https://www.jasondavies.com/bloomfilter/" },
        { title: "Thomas Hurst's Bloom filter calculator", href: "https://hur.st/bloomfilter/" },
        { title: "Bloom's 1970 paper, Space/time trade-offs in hash coding with allowable errors", href: "https://dl.acm.org/doi/10.1145/362686.362692" },
      ]} />

      <style>{CSS}</style>
    </PgFrame>
  );
}

const CSS = `
.bf-rows { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.bf-bits { display: grid; gap: 1px; padding: 6px; border: 1px solid var(--line); background: var(--surface); }
.bf-bit { display: block; aspect-ratio: 1; min-width: 0; background: var(--surface-2); border: 1px solid transparent; }
.bf-bit.on { background: var(--accent); opacity: .75; }
.bf-bit.hit { outline: 2px solid var(--ink); outline-offset: 0; z-index: 1; opacity: 1; }
.bf-bit.hit.ok { outline-color: var(--good); }
.bf-bit.hit.warn { outline-color: var(--pain); }
.bf-bit.hit.bad { outline-color: var(--pain); background: var(--pain); }
.bf-bits.anim .bf-bit { transition: background-color .25s var(--ease); }
.bf-last { margin: 0; font-size: .92rem; border-left: 3px solid var(--line); padding-left: 8px; }
.bf-last.ok { border-color: var(--good); } .bf-last.warn, .bf-last.bad { border-color: var(--pain); }
.bf-last code { word-break: break-all; }
.bf-curve { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
.bf-bar { fill: var(--line); }
.bf-bar.cur { fill: var(--accent); }
.bf-formula { fill: none; stroke: var(--pain); stroke-width: 1.5; stroke-dasharray: 4 3; }
.bf-ax { font-family: var(--f-code); font-size: 8px; fill: var(--ink-2); }
.bf-ax.cur { fill: var(--accent); font-weight: 700; }
.bf-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.bf-recent { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.bf-recent li { display: flex; gap: 6px; align-items: center; justify-content: space-between; font-size: .78rem; min-width: 0; }
.bf-recent code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.bf-del { color: var(--pain); padding: 1px 7px; font-size: .74rem; flex: none; }
.bf-list { list-style: none; padding-left: 0 !important; }
.bf-list li.got { color: var(--good); }
@media (max-width: 520px) { .bf-rows { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .bf-bits.anim .bf-bit { transition: none; } }
`;
