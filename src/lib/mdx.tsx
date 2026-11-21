import { compileMDX } from "next-mdx-remote/rsc";
import { Depth, Lang } from "@/components/MdxBits";
import { Term } from "@/components/Term";
import { Playground } from "@/playgrounds/Playground";

const components = { Depth, Lang, Term, Playground };

/** Compile one section of topic prose. Runs at build time only. */
export async function renderMdx(source: string) {
  const { content } = await compileMDX({ source, components, options: { parseFrontmatter: false } });
  return content;
}
