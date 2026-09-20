import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

/*
 * Markdown lives in `site/content/`, outside `src/`, so prose is editable
 * without touching the site's source tree. The glob loader's `base` is
 * resolved against the Astro project root (`site/`).
 */
const docs = defineCollection({
  loader: glob({ base: "./content/docs", pattern: "**/*.md" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    /** Sidebar position; lower sorts first. */
    order: z.number().default(100),
  }),
});

export const collections = { docs };
