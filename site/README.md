# site

The marketing page and docs for factory. Astro 7 (static output), Tailwind v4, Expressive Code for
codeblocks, Pagefind for search.

Its own package with its own `node_modules` — it is not a workspace of the root, and nothing here
ships in `@frebreco/factory`.

```bash
cd site
bun install

bun run dev      # http://localhost:4321 — no search, see below
bun run build    # astro build, then pagefind indexes dist/
bun run preview  # build + serve dist/ — the only way to test search locally
bun run check    # astro check (types across .astro files)
```

## Layout

| Path                             | What it is                                                  |
| -------------------------------- | ----------------------------------------------------------- |
| `content/docs/*.md`              | Docs prose. Frontmatter: `title`, `description?`, `order`   |
| `src/content.config.ts`          | The `docs` collection — glob loader + zod schema            |
| `src/pages/index.astro`          | Marketing landing page                                      |
| `src/pages/docs/[...slug].astro` | One route per markdown file                                 |
| `src/pages/docs/[...slug].md.ts` | The same pages as raw markdown at `/docs/<slug>.md`         |
| `src/pages/docs/index.md.ts`     | Unlisted markdown index of every doc                        |
| `src/lib/docs.ts`                | `sortedDocs()` — sidebar order, shared by the above         |
| `src/components/NavDrawer.astro` | Mobile nav: trigger bar + drawer, below `lg`                |
| `src/styles/global.css`          | Tailwind entry + design tokens + prose and Pagefind theming |
| `ec.config.mjs`                  | Expressive Code themes and style overrides                  |

## Adding a page

Drop a `.md` file in `content/docs/`. It appears at `/docs/<filename>` and in the sidebar, sorted by
`order`. Nothing else to register.

## Raw markdown

Append `.md` to any docs URL — `/docs/introduction.md` — for the source without the chrome. The doc
header links it, and `src/pages/docs/[...slug].md.ts` generates it as a static file alongside the
HTML. Served as `text/plain` so browsers display it rather than downloading; frontmatter is stripped
and the `title` and `description` are reinstated as an H1 and a lead paragraph.

`/docs/index.md` lists every page in sidebar order with its description, each linking to its `.md`
source — fetch one URL to learn what exists, then fetch what you need. It is unlisted: not a
collection entry, so the sidebar never shows it, and Pagefind only indexes HTML, so search ignores
it. Its links are absolute, built from `site` in `astro.config.mjs` — **that value is currently the
placeholder `https://factory.frebreco.de`**, so set it to the real domain before deploying or the
index will point at nothing.

## Things that will bite you

- **Search is build-only.** Pagefind indexes rendered HTML in `dist/`, so `astro dev` has no index.
  The header shows a "build only" chip there instead of a dead search box. Use `bun run preview`.
- **Expressive Code options live in `ec.config.mjs`,** not `astro.config.mjs`. The `<Code>` component
  needs options it can serialise to JSON, and `themeCssSelector` is a function.
- **Tailwind v4 puts everything in `@layer`, and unlayered CSS beats every layer** regardless of
  specificity — and separately, two unlayered rules of _equal_ specificity still just fall to source
  order. Third-party stylesheets here are unlayered, so they quietly win either way. Four instances
  so far: the `.prose` token bindings (unlayered to beat `@layer utilities`), the Pagefind `--pf-*`
  block and the Expressive Code copy-button size (both `.foo.foo`-doubled, because Pagefind reuses
  `:root` and Expressive Code scopes its own plugin CSS under `.expressive-code` too — so a selector
  that looks more specific than theirs can turn out to be identical to theirs), and hiding
  `<pagefind-searchbox>` responsively (Tailwind's `hidden` loses to Pagefind's element selector, so
  the breakpoint classes live on a wrapper div instead). Each has a comment. When a utility class or
  an apparently-more-specific override inexplicably does nothing to a third-party element, this is
  why — check what selector the library actually emits before assuming yours wins.
- **Editing `ec.config.mjs` (or anything else that changes how markdown renders, without touching
  any `.md` file) can 404 the Expressive Code stylesheet — in dev _and_ in a build.** Astro's
  content layer caches each doc's rendered HTML, keyed only on the source markdown's digest. That
  digest doesn't change, so the cache reuses the old HTML, `<link>` to the old theme's hash and
  all, while Expressive Code emits only the new hash's file. Symptom in dev: a 404 for
  `/_astro/ec.<hash>.css` (or, if two restart triggers race — Astro's own config watcher and
  Expressive Code's `handleHotUpdate` both fire on the same save — a dev server that reports itself
  running but stops listening entirely; check `.astro/dev.log` for
  `Vite module runner has been closed`). Symptom in a build: a shipped page linking a CSS file that
  was never written to `dist/`.

  `bun run dev` now runs `dev:clean` first, so this cannot happen from a fresh `astro dev` — it can
  still happen if you edit `ec.config.mjs` while an _already-running_ dev server is up (the cache
  only clears at startup) or when running `bun run build` directly. In either case:

  ```bash
  bun run dev:clean   # or: rm -f .astro/data-store.json node_modules/.astro/data-store.json
  ```

- **`astro check` needs TypeScript 6.** TS 7 (tsgo, what the root package pins) does not expose the
  programmatic API the Astro language server uses, so this package pins `typescript@^6` locally.

## Not done yet

- Design tokens are copied from `src/web/styles.css` rather than shared. Lift them into one file
  once both surfaces settle.
- No `.astro` formatter. oxfmt does not parse the format, and the root `bun run check` does not
  cover this package.
- Nothing else. Icons come from `@lucide/astro`, imported one file at a time
  (`@lucide/astro/icons/search`) rather than through the barrel.
