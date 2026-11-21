// Fast content check without a full Next build: node --experimental-strip-types scripts/check.ts [topic.mdx ...]
// Validates frontmatter, steps, line ranges, roles, checks, glossary, playgrounds; compiles each
// MDX section; and highlights every code variant.
import fs from "node:fs";
import path from "node:path";
import { compile } from "@mdx-js/mdx";
import { getTopic, listRoadmaps, listTopics, prepareCode } from "../src/lib/content.ts";

const args = process.argv.slice(2);
const files = args.length ? args : fs.readdirSync("content", { withFileTypes: true })
  .filter((d) => d.isDirectory() && !["glossary", "roadmaps", "outlines"].includes(d.name))
  .flatMap((d) => fs.readdirSync(path.join("content", d.name)).filter((f) => f.endsWith(".mdx")).map((f) => path.join("content", d.name, f)));

let failed = 0;
for (const f of files) {
  const [track, file] = f.replace(/\\/g, "/").split("/").slice(-2);
  try {
    const t = getTopic(track, file.replace(/\.mdx$/, ""));
    for (const s of t.steps) await compile(s.mdx).catch((e) => { throw new Error(`MDX in step [${s.key}]: ${e.message}`); });
    if (t.reference) await compile(t.reference).catch((e) => { throw new Error(`MDX in [reference]: ${e.message}`); });
    await prepareCode(t.meta);
    console.log(`ok   ${t.meta.id}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${f}\n     ${(e as Error).message}`);
  }
}
try { listTopics(); listRoadmaps(); } catch (e) { failed++; console.error(`FAIL ${(e as Error).message}`); }
if (failed) process.exit(1);
