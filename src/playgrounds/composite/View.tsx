"use client";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  byId, children, compositeCost, init, isGroup, loopCost, missed, step, targets,
  type Guess, type Node, type State,
} from "./model";

const CSS = `
.composite-tree { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); background: var(--surface); }
.composite-tree li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: center; padding: 3px 6px; border-top: 1px solid var(--grid); }
.composite-tree li:first-child { border-top: 0; }
.composite-tree li.lit { background: var(--hl); }
.composite-tree li.lit.fresh { animation: pg-hop .35s var(--ease) both; }
.composite-tree li.miss .composite-cost { color: var(--pain); text-decoration: line-through; }
.composite-who { display: flex; align-items: center; gap: 6px; min-width: 0; }
.composite-who button { border: 0; background: none; padding: 0; text-align: left; font: inherit; color: var(--ink); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composite-who button:hover, .composite-who button:focus-visible { text-decoration: underline; }
.composite-kind { font-family: var(--f-code); font-size: .56rem; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); border: 1px solid var(--line); padding: 0 4px; flex: none; }
.composite-kind.group { color: var(--accent); border-color: var(--accent); }
.composite-cost { font-family: var(--f-code); font-size: .72rem; font-variant-numeric: tabular-nums; color: var(--ink-2); flex: none; }
.composite-flag { font-family: var(--f-code); font-size: .56rem; letter-spacing: .06em; text-transform: uppercase; color: var(--pain); flex: none; }
.composite-move { font-size: .74rem; max-width: 9.5em; border: 1px solid var(--line); background: var(--bg); color: var(--ink); padding: 1px 2px; }
.composite-reports { display: grid; gap: 8px; }
.composite-big { font-family: var(--f-code); font-size: 1.3rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.composite-big.bad { color: var(--pain); }
.composite-big.good { color: var(--good); }
.composite-tasks { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: .92rem; }
.composite-tasks li { padding-left: 1.5em; position: relative; }
.composite-tasks li::before { content: "○"; position: absolute; left: 0; font-family: var(--f-code); color: var(--ink-2); }
.composite-tasks li.done::before { content: "✓"; color: var(--good); font-weight: 700; }
@media (prefers-reduced-motion: reduce) { .composite-tree li.lit.fresh { animation: none; } }
`;

const LOOPS: Record<Lang, string> = {
  go: "for _, team := range org.Teams {\n  for _, p := range team.Projects {\n    for _, r := range p.Resources {\n      total += r.Monthly }}}",
  python: "for team in org.teams:\n  for p in team.projects:\n    for r in p.resources:\n      total += r.monthly",
  typescript: "for (const team of org.teams)\n  for (const p of team.projects)\n    for (const r of p.resources)\n      total += r.monthly;",
  rust: "for team in &org.teams {\n  for p in &team.projects {\n    for r in &p.resources {\n      total += r.monthly; }}}",
};
const CALL: Record<Lang, string> = {
  go: "total := node.Cost() // a VM or the whole org",
  python: "total = node.cost()  # a VM or the whole org",
  typescript: "const total = node.cost(); // a VM or the whole org",
  rust: "let total = node.cost(); // a VM or the whole org",
};

const usd = (v: number) => "$" + v.toLocaleString("en-US");

function flatten(t: Node[]): { n: Node; depth: number }[] {
  const out: { n: Node; depth: number }[] = [];
  const walk = (id: string, depth: number) => {
    out.push({ n: byId(t, id), depth });
    for (const c of children(t, id)) walk(c.id, depth + 1);
  };
  walk("org", 0);
  return out;
}

function Tree({ st, dispatch, reduced }: { st: State; dispatch: (a: Parameters<typeof step>[1]) => void; reduced: boolean }) {
  const lit = compositeCost(st.tree, st.selected).order;
  const { visited } = loopCost(st.tree);
  return (
    <ul className="composite-tree" aria-label="The org's cloud resources">
      {flatten(st.tree).map(({ n, depth }) => {
        const group = isGroup(n.kind);
        const sum = compositeCost(st.tree, n.id).total;
        const miss = !visited.has(n.id) && n.own > 0;
        const i = lit.indexOf(n.id);
        const moves = targets(st.tree, n.id);
        return (
          <li key={n.id} className={(i >= 0 ? "lit" + (reduced ? "" : " fresh") : "") + (miss ? " miss" : "")}
            style={{ paddingLeft: 6 + depth * 14, animationDelay: i >= 0 ? `${Math.min(i, 20) * 45}ms` : undefined }}>
            <span className="composite-who">
              <span className={"composite-kind" + (group ? " group" : "")}>{n.kind === "workload" ? "pods" : n.kind}</span>
              <button onClick={() => dispatch({ type: "select", id: n.id })} title={`Call cost() on ${n.name}`} aria-pressed={st.selected === n.id}>{n.name}</button>
              <span className="composite-cost">{group ? `Σ ${usd(sum)}` : usd(n.own)}{group && n.own ? ` (fee ${usd(n.own)})` : ""}</span>
              {miss && <span className="composite-flag">not counted</span>}
            </span>
            {n.id !== "org" && moves.length > 0 ? (
              <select className="composite-move" aria-label={`Move ${n.name} into`} value="" onChange={(e) => e.target.value && dispatch({ type: "move", id: n.id, to: e.target.value })}>
                <option value="">move into…</option>
                {moves.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : <span />}
          </li>
        );
      })}
    </ul>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "same", label: "Still $4,770" },
  { value: "drops", label: "Lower, no error" },
  { value: "error", label: "An error" },
];

export default function CompositePlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const comp = compositeCost(st.tree, "org");
  const loops = loopCost(st.tree);
  const gap = comp.total - loops.total;
  const lost = missed(st.tree);
  const sel = byId(st.tree, st.selected);
  const selCost = compositeCost(st.tree, st.selected);
  const sharedTop = byId(st.tree, "shared").parent === "org";

  return (
    <PgFrame title="Reorganise the org, compare the bills" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        Finance totals the cloud bill two ways. One report loops over teams, then projects, then resources: the shape the
        org had when it was written. The other asks the root for <code>cost()</code>, and every node, a VM or a whole
        team, answers the same question. <b>Reorganise the org and see which report you can trust.</b>
      </p>

      <PgPredict<Guess>
        question="ML platform becomes a sub-team of Data. What does the loop report say the org spends?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={st.revealed}
        answer="drops"
        explain="The loops expect projects inside teams. Under Data they find the warehouse project and a team, which they skip without a word. $2,390 of GPU and storage disappears from the report. cost() does not care what kind of node it is asking, so its total does not move."
      />
      {!st.revealed && (
        <div className="pg-actions">
          <PgButton primary onClick={() => dispatch({ type: "move", id: "ml", to: "data" })}>Move ML platform under Data</PgButton>
          <span className="muted">Or use the move menus in the tree.</span>
        </div>
      )}

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">The org · click a name to call cost() on it</span>
          <Tree st={st} dispatch={dispatch} reduced={reduced} />
          {st.refused && <p className="pg-note" role="status" style={{ color: "var(--pain)" }}>{st.refused}</p>}
        </div>
        <div className="composite-reports">
          <div className="pg-card">
            <span className="label">Report A · nested loops</span>
            <div className="pgc"><div className="pgc-line"><code>{LOOPS[lang]}</code></div></div>
            <span className={"composite-big" + (gap ? " bad" : "")}>{usd(loops.total)}</span>
            <p className="pg-note">{gap ? `Missing ${usd(gap)}: ${lost.map((n) => n.name).join(", ")}. No error, no warning.` : "Matches, for now."}</p>
          </div>
          <div className="pg-card">
            <span className="label">Report B · composite</span>
            <div className="pgc"><div className="pgc-line"><code>{CALL[lang]}</code></div></div>
            <span className="composite-big good">{usd(comp.total)}</span>
            <p className="pg-note" aria-live="polite">
              {sel.name}.cost() = {usd(selCost.total)}, {selCost.calls === 1 ? "1 call: a leaf answers for itself." : `${selCost.calls} calls: the group asks each child the same question.`}
            </p>
          </div>
        </div>
      </div>

      {st.revealed && (
        <div className="pg-req">
          <span className="label">More reorganisations</span>
          <ul className="composite-tasks">
            <li className={byId(st.tree, "ml").parent === "data" ? "done" : ""}>ML platform is a sub-team of Data.</li>
            <li className={sharedTop ? "done" : ""}>shared-infra belongs to the whole org, not to Payments. Move it into Org.</li>
            <li className={st.clusterAdded ? "done" : ""}>
              Platform moves the API onto Kubernetes: a cluster with its own fee that holds namespaces, which hold pods.{" "}
              {!st.clusterAdded && <PgButton onClick={() => dispatch({ type: "addCluster" })}>Add the cluster</PgButton>}
            </li>
          </ul>
          <div className="pg-result" aria-live="polite">
            <span className="label">Your result</span>
            <p>After {st.moves} {st.moves === 1 ? "change" : "changes"} to the org, it spends <b>{usd(comp.total)}</b> a month. Report A says <b>{usd(loops.total)}</b>: it misses {usd(gap)}{comp.total ? ` (${Math.round((gap / comp.total) * 100)}%)` : ""} in {lost.length} {lost.length === 1 ? "resource" : "resources"}. Report B made {comp.calls} calls, one per node, and needed no code change.</p>
            <p className="pg-takeaway">The loops hard-code the tree's shape, so every new shape (a sub-team, a project with no team, a resource that has children) needs another loop in every report that walks the tree. With Composite, a leaf and a group answer the same call, so the code that asks never learns the shape.</p>
          </div>
        </div>
      )}

      <PgSources links={[
        { title: "Refactoring.Guru's Composite (its order-of-boxes example)", href: "https://refactoring.guru/design-patterns/composite" },
        { title: "Google Cloud's resource hierarchy", href: "https://docs.cloud.google.com/resource-manager/docs/cloud-platform-resource-hierarchy" },
        { title: "AWS Organizations' nested OUs", href: "https://docs.aws.amazon.com/organizations/latest/userguide/orgs_reference_limits.html" },
      ]} />
    </PgFrame>
  );
}
