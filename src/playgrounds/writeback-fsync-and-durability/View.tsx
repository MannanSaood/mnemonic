"use client";
import { useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  SAFE, goals, init, isSafe, replyMs, sameRecipe, step, steps, sweep as sweepOf,
  type Content, type EventId, type Mode, type Recipe, type Verdict,
} from "./model";

/* ---------------- the save, as code in the reader's language ---------------- */

const CODE: Record<Lang, (r: Recipe) => Partial<Record<EventId, string>>> = {
  go: (r) => ({
    open: r.mode === "inplace" ? `f, _ := os.Create("data.json") // O_TRUNC` : `f, _ := os.Create("data.json.tmp")`,
    write: "f.Write(snapshot)",
    fsync: "if err := f.Sync(); err != nil { return err }",
    rename: `os.Rename("data.json.tmp", "data.json")`,
    fsyncDir: `d, _ := os.Open("."); d.Sync(); d.Close()`,
    reply: `f.Close(); reply("saved")`,
  }),
  python: (r) => ({
    open: r.mode === "inplace" ? `f = open("data.json", "wb")  # O_TRUNC` : `f = open("data.json.tmp", "wb")`,
    write: "f.write(snapshot)",
    fsync: "f.flush(); os.fsync(f.fileno())",
    rename: `os.replace("data.json.tmp", "data.json")`,
    fsyncDir: `d = os.open(".", os.O_RDONLY); os.fsync(d); os.close(d)`,
    reply: `f.close(); reply("saved")`,
  }),
  typescript: (r) => ({
    open: r.mode === "inplace" ? `const fh = await open("data.json", "w"); // O_TRUNC` : `const fh = await open("data.json.tmp", "w");`,
    write: "await fh.writeFile(snapshot);",
    fsync: "await fh.sync();",
    rename: `await rename("data.json.tmp", "data.json");`,
    fsyncDir: `const d = await open(".", "r"); await d.sync(); await d.close();`,
    reply: `await fh.close(); reply("saved");`,
  }),
  rust: (r) => ({
    open: r.mode === "inplace" ? `let mut f = File::create("data.json")?; // O_TRUNC` : `let mut f = File::create("data.json.tmp")?;`,
    write: "f.write_all(&snapshot)?;",
    fsync: "f.sync_all()?;",
    rename: `fs::rename("data.json.tmp", "data.json")?;`,
    fsyncDir: `File::open(".")?.sync_all()?;`,
    reply: `drop(f); reply("saved");`,
  }),
};

const CONTENT: Record<Content, { title: string; sub: string }> = {
  v2: { title: "v2", sub: "the new snapshot" },
  v1: { title: "v1", sub: "the old snapshot" },
  empty: { title: "0 bytes", sub: "both versions gone" },
};

const VERDICT: Record<Verdict, { short: string; text: string; bad: boolean }> = {
  "new": { short: "v2", text: "The new snapshot survived.", bad: false },
  "old-retry": { short: "v1", text: "The old snapshot is intact. The client never got its reply, so it retries. No harm done.", bad: false },
  "lost-ack": { short: "lost", text: "The client was told \"saved\", but data.json still holds v1. An acknowledged write is gone.", bad: true },
  "empty": { short: "empty", text: "data.json is empty. The metadata reached the disk before the data did, so the old version is gone and the new one never arrived.", bad: true },
};

function why(r: Recipe, after: number, v: Verdict): string {
  const s = steps(r);
  const passed = new Set(s.slice(0, after + 1).map((x) => x.id));
  if (v === "empty" && r.mode === "inplace") return "Opening with O_TRUNC is metadata. A journal commit wrote the truncate, but the new data was still only dirty pages in RAM.";
  if (v === "empty") return "The rename reached the disk in a journal commit, but the temp file's data was still dirty in RAM. Nothing fsynced it before the rename.";
  if (v === "lost-ack") return passed.has("fsync") ? "fsync made the temp file durable, but the rename lives in the directory, and nothing fsynced the directory before the reply." : "write() returned when the data reached the page cache, not the disk.";
  if (v === "new") return passed.has("fsync") && (r.mode === "inplace" || passed.has("fsyncDir")) ? "Everything the reply promised was fsynced before the reply." : "The kernel's background commit or writeback got there before the power failed. That was luck: the reply had already gone out.";
  return "The crash came before the save finished. Nothing was promised yet.";
}

const ms = (x: number) => `${x < 1 ? x.toFixed(2) : x.toFixed(1)} ms`;
const recipeName = (r: Recipe) =>
  (r.mode === "inplace" ? "In place" : "Temp + rename") + (r.fsyncFile ? " + fsync file" : "") + (r.mode === "rename" && r.fsyncDir ? " + fsync dir" : "");

type Guess = Content;

export default function CrashLab() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const r = st.recipe;
  const tl = steps(r);
  const code = CODE[lang](r);
  const g = goals(st);
  const swept = st.sweeps.find((s) => sameRecipe(s.recipe, r));
  const safeSweep = st.sweeps.find(isSafe);
  const fastest = sweepOf({ mode: "inplace", fsyncFile: false, fsyncDir: false });

  const Plug = ({ after }: { after: number }) => (
    <button className={"crash-plug" + (st.plug === after ? " on" : "")} onClick={() => dispatch({ type: "plug", after })}
      aria-label={after < 0 ? "Pull the plug before the save starts" : `Pull the plug after: ${tl[after].label}`}>
      <span aria-hidden="true">⏻</span> pull the plug here
    </button>
  );

  return (
    <PgFrame title="A crash lab for one saved file" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question={'The service writes v2 to data.json.tmp, fsyncs it, renames it over data.json and replies "saved". One second later the power fails. What is in data.json after the reboot?'}
        options={[{ value: "v2", label: "v2, it was fsynced" }, { value: "v1", label: "v1, the old version" }, { value: "empty", label: "An empty file" }]}
        value={guess} onChange={setGuess} revealed={g.predictSeen} answer="v1"
        explain={<>fsync made the temp file&apos;s data durable, but the rename is a change to the directory. It sits in the next journal commit, up to 5 seconds away. Until then the disk still says data.json is v1, and the client has already been told &quot;saved&quot;. Add an fsync of the directory before the reply.</>}
      />

      <div className="crash-recipe" role="group" aria-label="How the service saves the file">
        <PgChoice<Mode> label="How to save" value={r.mode} onChange={(m) => dispatch({ type: "mode", mode: m })}
          options={[{ value: "inplace", label: "Overwrite in place" }, { value: "rename", label: "Temp file + rename" }]} />
        <button className="crash-toggle" aria-pressed={r.fsyncFile} onClick={() => dispatch({ type: "fsyncFile", on: !r.fsyncFile })}>
          {r.fsyncFile ? "☑" : "☐"} fsync the file
        </button>
        <button className="crash-toggle" aria-pressed={r.mode === "rename" && r.fsyncDir} disabled={r.mode === "inplace"} onClick={() => dispatch({ type: "fsyncDir", on: !r.fsyncDir })}>
          {r.mode === "rename" && r.fsyncDir ? "☑" : "☐"} fsync the directory
        </button>
      </div>

      <p className="pg-rule"><b>Pull the plug</b> after any step and see what is on the disk after the reboot. Or pull it at every moment at once.</p>

      <ol className="crash-timeline">
        <li className="crash-row start"><span className="crash-who">disk</span><span>data.json holds v1, safely on disk.</span><Plug after={-1} /></li>
        {tl.map((s, i) => {
          const happened = st.plug === null || i <= st.plug;
          const c = swept?.crashes[i + 1];
          return (
            <li key={s.id} className={"crash-row " + s.by + (happened ? "" : " undone") + (s.id === "reply" ? " reply" : "") + (reduced ? "" : " anim")}>
              <span className="crash-who">{s.by === "app" ? "app" : "kernel"}</span>
              <span className="crash-what">
                {s.by === "app" && code[s.id] ? <code>{code[s.id]}</code> : null}
                <span className="crash-label">{s.label}</span>
              </span>
              {c && <span className={"crash-badge " + (VERDICT[c.verdict].bad ? "bad" : c.verdict === "new" ? "good" : "")}>{VERDICT[c.verdict].short}</span>}
              <Plug after={i} />
            </li>
          );
        })}
      </ol>

      <div className="pg-actions">
        <PgButton primary onClick={() => dispatch({ type: "sweep" })}>Pull the plug at every moment</PgButton>
      </div>

      {st.crash && (
        <div className={"pg-result crash-after" + (VERDICT[st.crash.verdict].bad ? " bad" : "")} aria-live="polite">
          <span className="label">After the reboot · plug pulled {st.plug! < 0 ? "before the save" : `after step ${st.plug! + 1}`}</span>
          <div className="crash-file">
            <span className="label">data.json</span>
            <b className={"crash-content " + st.crash.content}>{CONTENT[st.crash.content].title}</b>
            <span>{CONTENT[st.crash.content].sub}</span>
          </div>
          <p><b>{VERDICT[st.crash.verdict].text}</b> {why(r, st.plug!, st.crash.verdict)}</p>
        </div>
      )}

      <dl className="pg-stats">
        <div><dt>Time to reply</dt><dd>{ms(replyMs(r))}</dd></div>
        <div><dt>fsync calls</dt><dd>{(r.fsyncFile ? 1 : 0) + (r.mode === "rename" && r.fsyncDir ? 1 : 0)}</dd></div>
        <div className={swept?.lostAck ? "bad" : ""}><dt>Crashes losing a reply</dt><dd>{swept ? swept.lostAck : "?"}</dd></div>
        <div className={swept?.empty ? "bad" : ""}><dt>Crashes leaving 0 bytes</dt><dd>{swept ? swept.empty : "?"}</dd></div>
      </dl>

      {st.sweeps.length > 0 && (
        <div className="crash-table" role="region" aria-label="Recipes you tested" tabIndex={0}>
          <table>
            <thead><tr><th>Recipe</th><th>Reply after</th><th>Lost replies</th><th>Empty file</th></tr></thead>
            <tbody>
              {st.sweeps.map((s, i) => (
                <tr key={i} className={isSafe(s) ? "safe" : ""}><td>{recipeName(s.recipe)}</td><td>{ms(s.replyMs)}</td><td>{s.lostAck}</td><td>{s.empty}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {safeSweep ? (
        <div className="pg-result">
          <span className="label">What durability cost you</span>
          <p>Your safe recipe ({recipeName(safeSweep.recipe)}) replies after {ms(safeSweep.replyMs)}, against {ms(fastest.replyMs)} for a plain overwrite. Out of {safeSweep.crashes.length} moments to lose power, none lost a reply and none left an empty file. The plain overwrite left {fastest.empty} of its {fastest.crashes.length} with an empty file.</p>
          <p className="pg-takeaway">write() returning means the page cache has your data, nothing more. Before you reply, fsync the data, rename it into place, and fsync the directory. Each fsync costs milliseconds, so batch many changes into one save, as databases do with group commit.</p>
        </div>
      ) : st.sweeps.length > 0 ? (
        <p className="pg-takeaway">No recipe so far survives every crash. Look at the red rows: what did the disk still not have when the reply went out?</p>
      ) : null}

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="crash-goals">
          <li className={g.empty ? "done" : ""}>{g.empty ? "✓" : "○"} Lose both versions: find a crash that leaves data.json empty.</li>
          <li className={g.lostWithFsync ? "done" : ""}>{g.lostWithFsync ? "✓" : "○"} Lose a reply even though the file was fsynced.</li>
          <li className={g.safe ? "done" : ""}>{g.safe ? "✓" : "○"} Find a recipe where no crash loses a reply or empties the file{!safeSweep && g.lostWithFsync && g.empty ? ` (hint: ${recipeName(SAFE).toLowerCase()})` : ""}.</li>
        </ul>
      </div>

      <PgSources links={[
        { title: "Pillai et al., All File Systems Are Not Created Equal (OSDI 2014)", href: "https://www.usenix.org/conference/osdi14/technical-sessions/presentation/pillai" },
        { title: "Dan Luu's Files are hard", href: "https://danluu.com/file-consistency/" },
        { title: "LWN's Ensuring data reaches disk", href: "https://lwn.net/Articles/457667/" },
      ]} />

      <style>{`
        .crash-recipe { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
        .crash-toggle { border: 1px solid var(--line); background: var(--surface); padding: 4px 10px; font-size: .85rem; }
        .crash-toggle[aria-pressed="true"] { border-color: var(--accent); background: var(--hl); }
        .crash-toggle:disabled { opacity: .45; }
        .crash-timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; border: 1px solid var(--line); background: var(--surface); counter-reset: crash; }
        .crash-row { display: grid; grid-template-columns: 4.2em minmax(0, 1fr) auto auto; gap: 8px; align-items: center; padding: 6px 8px; border-top: 1px solid var(--line); }
        .crash-row:first-child { border-top: 0; }
        .crash-row.anim { transition: opacity .2s; }
        .crash-row.kernel { background: var(--bg); }
        .crash-row.reply { box-shadow: inset 3px 0 0 var(--accent); }
        .crash-row.undone { opacity: .38; }
        .crash-who { font-family: var(--f-code); font-size: .62rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
        .crash-what { display: grid; gap: 2px; min-width: 0; }
        .crash-what code { font-size: .74rem; background: none; padding: 0; overflow-wrap: anywhere; }
        .crash-label { font-size: .82rem; color: var(--ink-2); }
        .crash-plug { border: 1px dashed var(--line); background: transparent; font-size: .72rem; padding: 2px 6px; white-space: nowrap; color: var(--ink-2); }
        .crash-plug:hover { border-color: var(--pain); color: var(--pain); }
        .crash-plug.on { border-style: solid; border-color: var(--pain); color: var(--pain); background: var(--pain-bg); }
        .crash-badge { font-family: var(--f-code); font-size: .66rem; text-transform: uppercase; padding: 1px 6px; border: 1px solid var(--line); }
        .crash-badge.bad { border-color: var(--pain); color: var(--pain); background: var(--pain-bg); }
        .crash-badge.good { border-color: var(--good); color: var(--good); background: var(--good-bg); }
        .crash-after.bad { border-color: var(--pain); }
        .crash-file { display: inline-grid; grid-template-columns: auto auto auto; gap: 10px; align-items: baseline; border: 1px solid var(--line); background: var(--surface); padding: 6px 10px; }
        .crash-content { font-family: var(--f-code); font-size: 1.2rem; }
        .crash-content.empty { color: var(--pain); }
        .crash-content.v2 { color: var(--good); }
        .crash-table { overflow-x: auto; }
        .crash-table table { border-collapse: collapse; width: 100%; font-size: .8rem; font-family: var(--f-code); }
        .crash-table th, .crash-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
        .crash-table th { font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .crash-table tr.safe td { color: var(--good); }
        .crash-goals { list-style: none; padding-left: 0 !important; }
        .crash-goals li.done { color: var(--good); }
        @media (max-width: 600px) {
          .crash-row { grid-template-columns: minmax(0, 1fr) auto; }
          .crash-who { grid-column: 1 / -1; }
          .crash-plug { grid-column: 1 / -1; justify-self: start; }
        }
        @media (prefers-reduced-motion: reduce) { .crash-row.anim { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
