import { compileMDX } from "next-mdx-remote/rsc";
import { Depth, Lang } from "@/components/MdxBits";
import { Term } from "@/components/Term";

const components = { Depth, Lang, Term };

/** Compile one section of topic prose. Runs at build time only. */
export async function renderMdx(source: string) {
  const { content } = await compileMDX({ source, components, options: { parseFrontmatter: false } });
  return content;
}
