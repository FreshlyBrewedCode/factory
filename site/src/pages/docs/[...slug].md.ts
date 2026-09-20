import type { APIRoute, GetStaticPaths } from "astro";
import { sortedDocs } from "../../lib/docs";

/*
 * `/docs/<slug>.md` serves the source of `/docs/<slug>` — for piping into an
 * agent, diffing against a local copy, or just reading without the chrome.
 *
 * A static endpoint, so these are plain files in `dist/` after a build. The
 * filename is `[...slug].md.ts`: Astro strips the final `.ts`, leaving `.md`
 * as part of the route. `[...slug].astro` only emits the exact slugs
 * `getStaticPaths` returns, so the two routes never collide.
 */
export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await sortedDocs();
  return entries.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
};

export const GET: APIRoute = ({ props }) => {
  const { entry } = props;

  // The loader hands back the body with frontmatter already stripped, which is
  // what we want — `order` is sidebar plumbing, not content. But the page's
  // `<h1>` comes from frontmatter too, so the body alone would arrive
  // untitled; reinstate the title and lead as markdown. (To serve the file
  // byte-for-byte instead, read `entry.filePath` off disk.)
  const lead = entry.data.description ? `\n${entry.data.description}\n` : "";
  const markdown = `# ${entry.data.title}\n${lead}\n${entry.body ?? ""}`;

  return new Response(markdown, {
    headers: {
      // `text/plain` rather than `text/markdown` on purpose: browsers download
      // the latter, and the point of a URL you can guess is being able to open
      // it. `curl` and every agent fetcher are indifferent.
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
};
