import { getCollection } from "astro:content";

/**
 * Every doc in sidebar order: `order` ascending, then title, so two pages that
 * forget to set `order` still land somewhere stable. The sidebar, the markdown
 * index, and anything else listing docs read this rather than re-sorting.
 */
export async function sortedDocs() {
  const entries = await getCollection("docs");
  return entries.sort(
    (a, b) => a.data.order - b.data.order || a.data.title.localeCompare(b.data.title),
  );
}
