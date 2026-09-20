import type { APIRoute } from "astro";
import { sortedDocs } from "../../lib/docs";

/*
 * `/docs/index.md` — the whole docs tree as one plain-markdown listing, in
 * sidebar order, linking each page's `.md` source. Meant for agents and
 * scripts: fetch one URL, learn what exists, then fetch what you need.
 *
 * Unlisted on purpose. It is not a collection entry, so the sidebar never sees
 * it, and Pagefind only indexes HTML, so it stays out of search too.
 *
 * Nothing else claims this path: `[...slug].astro` renders `/docs` as
 * `docs/index.html`, which sits beside this `docs/index.md`, and
 * `[...slug].md.ts` only emits slugs that exist as content.
 */
export const GET: APIRoute = async ({ site }) => {
  const docs = await sortedDocs();

  // Absolute URLs when `site` is configured — an agent that fetched this from
  // somewhere else can follow them without knowing the origin.
  const url = (path: string) => (site ? new URL(path, site).href : path);

  const lines = docs.map((entry) => {
    const summary = entry.data.description ? `: ${entry.data.description}` : "";
    return `- [${entry.data.title}](${url(`/docs/${entry.id}.md`)})${summary}`;
  });

  const markdown = [
    "# factory docs",
    "",
    "Every page below is also available as HTML at the same path without the `.md` suffix.",
    "",
    ...lines,
    "",
  ].join("\n");

  return new Response(markdown, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
