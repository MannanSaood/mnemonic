"use client";
import { useEffect, useState, type ReactNode } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  IMPLS, NAME, REQUIRED, START, TRAY, fits, init, missing, step, typedReady,
  type ChannelId, type Method, type Note, type State, type Tally,
} from "./model";

/* ---------------- names in the reader's language ---------------- */

const M: Record<Lang, Record<Method | "balance", string>> = {
  go: { send: "Send(u, m) error", wakesPeople: "WakesPeople() bool", balance: "Balance() int" },
  python: { send: "send(user, msg)", wakesPeople: "wakes_people: bool", balance: "balance()" },
  typescript: { send: "send(user, msg)", wakesPeople: "wakesPeople: boolean", balance: "balance()" },
  rust: { send: "fn send(&self, …)", wakesPeople: "fn wakes_people(&self)", balance: "fn balance(&self)" },
};
const IFACE: Record<Lang, string> = { go: "Notifier interface", python: "Notifier Protocol", typescript: "Notifier interface", rust: "Notifier trait" };

function rejectMsg(lang: Lang, id: ChannelId): string {
  const n = NAME[id];
  switch (lang) {
    case "go": return `cannot use ${n}{} (value of type ${n}) as Notifier value: ${n} does not implement Notifier (missing method WakesPeople)`;
    case "typescript": return `Property 'wakesPeople' is missing in type '${n}' but required in type 'Notifier'.`;
    case "rust": return "error[E0046]: not all trait items implemented, missing: `wakes_people`";
    default: return "";
  }
}

const NOTIFY: Record<Lang, string[]> = {
  go: ["n, ok := s.channels[u.Channel]", "if n.WakesPeople() && quietHours(t) { enqueue }", "return n.Send(u, m)"],
  python: ["notifier = self.channels[user.channel]", "if notifier.wakes_people and quiet_hours(now): enqueue", "notifier.send(user, msg)"],
  typescript: ["const n = this.channels.get(user.channel);", "if (n.wakesPeople && quietHours(now)) enqueue", "return n.send(user, msg);"],
  rust: ["let n = self.channels.get(&user.channel)?;", "if n.wakes_people() && quiet_hours(now) { enqueue }", "n.send(user, msg)"],
};
const TYPED: Record<Lang, { quiet: (ids: ChannelId[]) => string; arm: (id: ChannelId) => string; head: string }> = {
  go: { quiet: (ids) => `case ${ids.map((i) => `"${i}"`).join(", ")}: // quiet hours`, arm: (id) => `case "${id}": …`, head: "switch u.Channel {" },
  python: { quiet: (ids) => `if user.channel in (${ids.map((i) => `"${i}"`).join(", ")}):`, arm: (id) => `elif user.channel == "${id}": …`, head: "# send" },
  typescript: { quiet: (ids) => `if (${ids.map((i) => `ch === "${i}"`).join(" || ")})`, arm: (id) => `case "${id}": …`, head: "switch (user.channel) {" },
  rust: { quiet: (ids) => `if matches!(ch, ${ids.map((i) => `"${i}"`).join(" | ")})`, arm: (id) => `"${id}" => …,`, head: "match user.channel.as_str() {" },
};

/* ---------------- small parts ---------------- */

function Line({ children, tone, action }: { children: ReactNode; tone?: "new" | "bad" | "file" | "head"; action?: ReactNode }) {
  return (
    <div className={"pgc-line" + (tone ? ` ${tone}` : "")}>
      <code>{children}</code>
      {action}
    </div>
  );
}

function Log({ notes, reduced, empty }: { notes: Note[]; reduced: boolean; empty: string }) {
  if (!notes.length) return <p className="pg-empty">{empty}</p>;
  return (
    <div className="pg-log" aria-live="polite">
      {notes.map((e, i) => (
        <div key={e.id} className={"pg-entry" + (e.kind === "error" || e.kind === "woke" ? " fail" : " ok") + (reduced ? "" : " fresh")}>
          <div className="pg-path" aria-hidden="true">
            {e.path.map((p, j) => <span key={j} style={{ animationDelay: `${i * 90 + j * 100}ms` }}>{p}</span>)}
          </div>
          <p>{e.text}</p>
        </div>
      ))}
    </div>
  );
}

function Stats({ t, iface }: { t: Tally; iface: boolean }) {
  return (
    <dl className="pg-stats">
      <div className={!iface && t.notifyLines ? "bad" : ""}><dt>notify() lines edited</dt><dd>{t.notifyLines}</dd></div>
      <div><dt>{iface ? "Lines in new types" : "Test code in prod"}</dt><dd>{iface ? t.newTypeLines : t.testLinesInProd}</dd></div>
      <div className={t.failures ? "bad" : ""}><dt>Failed sends</dt><dd>{t.failures}</dd></div>
      <div className={t.wokeUp ? "bad" : ""}><dt>Woken at night</dt><dd>{t.wokeUp}</dd></div>
    </dl>
  );
}

/* ---------------- the tray: implementations against the socket ---------------- */

function Card({ id, st, lang, onPlug }: { id: ChannelId; st: State; lang: Lang; onPlug: () => void }) {
  const impl = IMPLS[id];
  const plugged = st.plugged.includes(id);
  const blurb: Record<string, string> = {
    whatsapp: "The Brazil launch wants it. Nobody had heard of it when notify() was written.",
    slack: "An ops team wrote it in a hurry. It can send, and nothing else.",
    fake: "For tests: records messages instead of sending them.",
  };
  const extra = impl.methods.filter((m) => !(REQUIRED as string[]).includes(m));
  return (
    <div className={"iap-card" + (plugged ? " plugged" : "")}>
      <div className="iap-card-head">
        <b>{NAME[id]}</b>
        <PgButton primary={!plugged} disabled={plugged} onClick={onPlug}>{plugged ? "Plugged in" : "Plug in"}</PgButton>
      </div>
      <p className="muted">{blurb[id]}</p>
      <ul className="iap-methods" aria-label={`${NAME[id]} against the ${IFACE[lang]}`}>
        {REQUIRED.map((m) => {
          const has = impl.methods.includes(m) || (id === "slack" && st.iface.slackFixed);
          return <li key={m} className={has ? "ok" : "no"}><span aria-hidden="true">{has ? "✓" : "✗"}</span> <code>{M[lang][m]}</code>{has ? "" : " missing"}</li>;
        })}
        {extra.map((m) => <li key={m} className="extra"><span aria-hidden="true">+</span> <code>{M[lang][m]}</code> extra, ignored</li>)}
      </ul>
    </div>
  );
}

/* ---------------- result ---------------- */

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Result({ st }: { st: State }) {
  const i = st.iface.total, t = st.typed.total;
  const lagging = st.plugged.filter((id) => !typedReady(st.typed, id));
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your plugs cost</span>
      <p><b>Interface design:</b> you plugged in {n(st.plugged.length, "type")}. notify() changed {n(i.notifyLines, "line")}. The new code lived in the new types ({n(i.newTypeLines, "line")}), and customers saw {n(i.failures, "failed send")}.</p>
      <p><b>Type-check design:</b> notify() changed {n(t.notifyLines, "line")}{t.testLinesInProd ? `, ${n(t.testLinesInProd, "of them", "of them")} only for tests` : ""}. While it caught up, customers saw {n(t.failures, "failed send")} and {n(t.wokeUp, "night-time wake-up")}.{lagging.length ? ` It still does not handle ${lagging.map((x) => NAME[x]).join(", ")} correctly.` : ""}</p>
      <p className="pg-takeaway">The interface service only ever asked &quot;can you send, and do you wake people?&quot;. Anything that answers both plugs in, including a fake, and the caller never learns its name. Type checks make the caller learn every name, in every place it branches.</p>
    </div>
  );
}

/* ---------------- the playground ---------------- */

export default function InterfacesPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, () => init(lang === "python" ? "duck" : "static"));
  const [guess, setGuess] = useState<"zero" | "zero-three" | "three" | null>(null);
  const typing = lang === "python" ? "duck" : "static";
  useEffect(() => { if (st.typing !== typing) dispatch({ type: "setTyping", typing }); }, [typing, st.typing, dispatch]);

  const T = TYPED[lang];
  const quietIds = st.typed.quiet;
  const caseIds = st.typed.cases;
  const pluggedWaking = st.plugged.filter((id) => IMPLS[id].wakes && !quietIds.includes(id));
  const pluggedNoCase = st.plugged.filter((id) => !caseIds.includes(id));

  return (
    <PgFrame title="Plug a channel into two notifiers" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict
        question="You plug WhatsApp, a channel neither service has heard of, into both. How many lines inside notify() must change before it works correctly?"
        options={[{ value: "zero", label: "0 and 0" }, { value: "zero-three", label: "0 in the interface one, 3 in the type-check one" }, { value: "three", label: "3 in both" }]}
        value={guess}
        onChange={setGuess}
        revealed={st.plugged.includes("whatsapp")}
        answer="zero-three"
        explain={<>The interface service looks the channel up by name and calls its two methods, so it works the moment WhatsApp has them. The type-check service needs a new case in the send switch (2 lines) and WhatsApp in the quiet-hours list (1 line). Forget the second and nothing errors: customers just get messages at 03:12.</>}
      />

      <div className="iap-socket" aria-label="The interface both services were written against">
        <span className="label">The socket · {IFACE[lang]}</span>
        <div className="iap-socket-row">
          {REQUIRED.map((m) => <code key={m}>{M[lang][m]}</code>)}
          <span className="muted">Already plugged: {START.map((x) => NAME[x]).join(", ")}</span>
        </div>
        <p className="muted iap-hint">
          {typing === "duck"
            ? "Python checks nothing when you plug a type in. A missing method shows up only when notify() reaches for it."
            : "A type fits when it has every method in the socket. Extra methods are fine. The compiler checks this where the type is stored as a Notifier."}
        </p>
      </div>

      <div className="iap-tray">
        {TRAY.map((id) => <Card key={id} id={id} st={st} lang={lang} onPlug={() => dispatch({ type: "plug", id })} />)}
      </div>

      {st.last && <p className="iap-last" aria-live="polite">{st.last}</p>}

      <div className="pg-sides">
        <section className="pg-side" aria-label="Interface design">
          <header><h4>Talks to the interface</h4></header>
          <p className="muted">notify() holds a map of channel name to Notifier and calls the methods.</p>
          <div className="pgc">
            <Line tone="file">notify(): never edited</Line>
            {NOTIFY[lang].map((l) => <Line key={l}>{l}</Line>)}
            <Line tone="file">channel map, built in main</Line>
            {st.iface.channels.map((id) => <Line key={id} tone={START.includes(id) ? undefined : "new"}>{`"${id}" → ${NAME[id]}`}</Line>)}
            {st.iface.rejected.map((id) => (
              <Line key={id} tone="bad" action={id === "slack" ? <PgButton onClick={() => dispatch({ type: "fixSlack" })}>Add the method</PgButton> : null}>
                {rejectMsg(lang, id)}
              </Line>
            ))}
            {typing === "duck" && st.plugged.includes("slack") && !st.iface.slackFixed && (
              <Line tone="bad" action={<PgButton onClick={() => dispatch({ type: "fixSlack" })}>Add the attribute</PgButton>}>AttributeError: &apos;Slack&apos; object has no attribute &apos;wakes_people&apos;</Line>
            )}
          </div>
          <Stats t={st.iface.total} iface />
          <span className="label">Messages after the last change</span>
          <Log notes={st.iface.log} reduced={reduced} empty="Plug something in. Three customers on that channel get a message: two in the afternoon, one at 03:12." />
        </section>

        <section className="pg-side" aria-label="Type-check design">
          <header><h4>Checks the type</h4></header>
          <p className="muted">notify() names channels twice: in the quiet-hours list and in the send switch.</p>
          <div className="pgc">
            <Line tone="file">notify(): quiet hours</Line>
            <Line tone={quietIds.length > 2 ? "new" : undefined}>{T.quiet(quietIds)}</Line>
            {pluggedWaking.map((id) => (
              <Line key={id} tone="bad" action={<PgButton onClick={() => dispatch({ type: "addQuiet", id })}>+ &quot;{id}&quot;</PgButton>}>
                {NAME[id]} wakes people, and this list does not know it
              </Line>
            ))}
            <Line tone="file">notify(): send</Line>
            <Line tone="head">{T.head}</Line>
            {caseIds.map((id) => <Line key={id} tone={START.includes(id) ? undefined : "new"}>{T.arm(id)}{IMPLS[id].records ? "  // test only" : ""}</Line>)}
            {pluggedNoCase.map((id) => (
              <Line key={id} tone="bad" action={<PgButton onClick={() => dispatch({ type: "addCase", id })}>+ case</PgButton>}>
                no case for &quot;{id}&quot;
              </Line>
            ))}
          </div>
          <Stats t={st.typed.total} iface={false} />
          <span className="label">Messages after the last change</span>
          <Log notes={st.typed.log} reduced={reduced} empty="The same three customers, the same plug, through the type checks." />
        </section>
      </div>

      {st.plugged.length > 0 && <Result st={st} />}

      <PgSources links={[
        { title: "Refactoring.Guru: Replace Conditional with Polymorphism", href: "https://refactoring.guru/replace-conditional-with-polymorphism" },
        { title: "A Tour of Go: Interfaces", href: "https://go.dev/tour/methods/9" },
      ]} />

      <style>{`
        .iap-socket { border: 1px dashed var(--accent); background: var(--bg); padding: 10px 12px; display: grid; gap: 6px; }
        .iap-socket-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .iap-socket-row code { border: 1px solid var(--accent); font-size: .72rem; }
        .iap-hint { margin: 0; font-size: .9rem; }
        .iap-tray { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
        .iap-card { border: 1px solid var(--line); background: var(--bg); padding: 8px 10px; display: grid; gap: 6px; align-content: start; min-width: 0; transition: border-color .2s var(--ease); }
        .iap-card.plugged { border-color: var(--accent); }
        .iap-card-head { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
        .iap-card p { margin: 0; font-size: .88rem; }
        .iap-methods { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; font-size: .85rem; }
        .iap-methods code { font-size: .68rem; }
        .iap-methods li.ok span { color: var(--good); }
        .iap-methods li.no { color: var(--pain); }
        .iap-methods li.extra { color: var(--ink-2); }
        .iap-last { margin: 0; border-left: 3px solid var(--accent); padding-left: 10px; }
        @media (max-width: 720px) { .iap-tray { grid-template-columns: 1fr; } }
        @media (prefers-reduced-motion: reduce) { .iap-card { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
