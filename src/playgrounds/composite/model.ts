// Composite playground: a company's cloud bill as a tree of teams, projects and resources.
// Two reports total it side by side: one written as nested loops for the shape the org had
// when the report was written (org → team → project → resource), and one that asks the root
// for cost() and lets every node, group or leaf, answer the same question.
//
// Purpose. After this, the reader can answer: "Why does treating a single resource and a whole
// group through one interface let the same code handle a tree of any shape?" The reader
// reorganises the org (sub-teams, a shared project, a Kubernetes cluster that has children of
// its own) and watches the loop report silently drop money while cost() stays right with no
// code change.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Kind = "org" | "team" | "project" | "vm" | "db" | "bucket" | "cluster" | "namespace" | "workload";
export const GROUP_KINDS: Kind[] = ["org", "team", "project", "cluster", "namespace"];
export const isGroup = (k: Kind) => GROUP_KINDS.includes(k);

export interface Node {
  id: string;
  name: string;
  kind: Kind;
  /** Monthly cost of the node itself, in dollars. Groups have 0, except a cluster's control-plane fee. */
  own: number;
  parent: string | null;
}

const N = (id: string, name: string, kind: Kind, parent: string | null, own = 0): Node => ({ id, name, kind, own, parent });

export function startTree(): Node[] {
  return [
    N("org", "Org", "org", null),
    N("payments", "Payments", "team", "org"),
    N("payments-api", "payments-api", "project", "payments"),
    N("api-1", "api-1", "vm", "payments-api", 140),
    N("api-2", "api-2", "vm", "payments-api", 140),
    N("orders-db", "orders-db", "db", "payments-api", 410),
    N("fraud", "fraud", "project", "payments"),
    N("scorer", "scorer", "vm", "fraud", 220),
    N("events", "events", "bucket", "fraud", 35),
    N("data", "Data", "team", "org"),
    N("warehouse", "warehouse", "project", "data"),
    N("wh-db", "warehouse-db", "db", "warehouse", 1200),
    N("raw", "raw-events", "bucket", "warehouse", 160),
    N("ml", "ML platform", "team", "org"),
    N("training", "training", "project", "ml"),
    N("trainer", "gpu-trainer", "vm", "training", 2300),
    N("models", "models", "bucket", "training", 90),
    N("shared", "shared-infra", "project", "payments"),
    N("vpn", "vpn-gateway", "vm", "shared", 75),
  ];
}

/** Which kinds may hold which. A cluster and its namespaces are added by a change request. */
export function canHold(parent: Kind, child: Kind): boolean {
  if (child === "team") return parent === "org" || parent === "team";
  if (child === "project") return parent === "org" || parent === "team";
  if (child === "cluster") return parent === "project";
  if (child === "namespace") return parent === "cluster";
  if (child === "workload") return parent === "namespace";
  return parent === "project";
}

export const children = (t: Node[], id: string) => t.filter((n) => n.parent === id);
export const byId = (t: Node[], id: string) => t.find((n) => n.id === id)!;

export function isDescendant(t: Node[], id: string, ancestor: string): boolean {
  for (let p = byId(t, id).parent; p; p = byId(t, p).parent) if (p === ancestor) return true;
  return false;
}

/* ---------------- the two reports ---------------- */

/** Composite: every node answers cost(). Returns the total, the calls made, and the order visited. */
export function compositeCost(t: Node[], id: string): { total: number; calls: number; order: string[] } {
  const order: string[] = [];
  const visit = (nid: string): number => {
    order.push(nid);
    const n = byId(t, nid);
    return n.own + children(t, nid).reduce((s, c) => s + visit(c.id), 0);
  };
  const total = visit(id);
  return { total, calls: order.length, order };
}

/**
 * The report written when every team held projects and every project held resources:
 * for team in org.teams, for project in team.projects, for r in project.resources.
 * Anything at another depth or of another kind is not visited, and nothing complains.
 */
export function loopCost(t: Node[]): { total: number; visited: Set<string> } {
  const visited = new Set<string>(["org"]);
  let total = 0;
  for (const team of children(t, "org").filter((n) => n.kind === "team")) {
    visited.add(team.id);
    for (const project of children(t, team.id).filter((n) => n.kind === "project")) {
      visited.add(project.id);
      for (const r of children(t, project.id).filter((n) => !isGroup(n.kind) || n.kind === "cluster")) {
        visited.add(r.id);
        total += r.own; // a resource's own price; it was never expected to have children
      }
    }
  }
  return { total, visited };
}

/** Nodes with money the loop report never counts: unvisited nodes with an own cost. */
export function missed(t: Node[]): Node[] {
  const { visited } = loopCost(t);
  return t.filter((n) => !visited.has(n.id) && n.own > 0);
}

/* ---------------- state and step ---------------- */

export type Guess = "same" | "drops" | "error";

export interface State {
  tree: Node[];
  selected: string;
  guess: Guess | null;
  /** The guided move (ML platform under Data) has happened. */
  revealed: boolean;
  /** Reorganisations the reader made. */
  moves: number;
  clusterAdded: boolean;
  /** A refused move and why, shown once. */
  refused: string | null;
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "move"; id: string; to: string }
  | { type: "select"; id: string }
  | { type: "addCluster" }
  | { type: "reset" };

export function init(): State {
  return { tree: startTree(), selected: "org", guess: null, revealed: false, moves: 0, clusterAdded: false, refused: null };
}

/** Groups a node may move into. */
export function targets(t: Node[], id: string): Node[] {
  const n = byId(t, id);
  return t.filter((p) => p.id !== id && p.id !== n.parent && isGroup(p.kind) && canHold(p.kind, n.kind) && !isDescendant(t, p.id, id));
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return st.revealed ? st : { ...st, guess: a.guess };
    case "select":
      return st.tree.some((n) => n.id === a.id) ? { ...st, selected: a.id, refused: null } : st;
    case "move": {
      const t = st.tree;
      if (!t.some((n) => n.id === a.id) || !t.some((n) => n.id === a.to)) return st;
      const n = byId(t, a.id), p = byId(t, a.to);
      if (a.id === a.to || isDescendant(t, a.to, a.id))
        return { ...st, refused: `Refused: ${n.name} would end up inside itself. A composite's add() must check this, or cost() would recurse forever.` };
      if (!canHold(p.kind, n.kind)) return { ...st, refused: `Refused: a ${p.kind} cannot hold a ${n.kind}.` };
      if (n.parent === a.to) return st;
      const tree = t.map((x) => (x.id === a.id ? { ...x, parent: a.to } : x));
      return { ...st, tree, moves: st.moves + 1, refused: null, revealed: st.revealed || (a.id === "ml" && a.to === "data") };
    }
    case "addCluster": {
      if (st.clusterAdded) return st;
      // Platform moves services onto a managed Kubernetes cluster: a resource with its own
      // control-plane fee that also contains namespaces, which contain workloads.
      const add: Node[] = [
        N("k8s", "prod-cluster", "cluster", "payments-api", 73),
        N("ns-api", "ns: api", "namespace", "k8s"),
        N("w-api", "api pods", "workload", "ns-api", 310),
        N("ns-jobs", "ns: jobs", "namespace", "k8s"),
        N("w-jobs", "batch pods", "workload", "ns-jobs", 180),
      ];
      return { ...st, tree: [...st.tree, ...add], clusterAdded: true, moves: st.moves + 1, refused: null };
    }
  }
}
