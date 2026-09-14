/** Optional-and-cheap static viewer (STATUS.md phase 3): read the raw HTML off disk, no Bun HTML-bundling. */
import { readFileSync } from "node:fs";

export const VIEWER_HTML: string = readFileSync(`${import.meta.dir}/viewer.html`, "utf8");
