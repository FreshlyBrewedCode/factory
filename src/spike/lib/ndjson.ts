/**
 * Raw stream-chunk dumper (D14). No schema, no filtering: every chunk that
 * comes off `chat()` is `JSON.stringify`'d and appended as one line. This is
 * a corpus for phase 1 to design the real event type against, not a log —
 * resist the urge to shape it.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface NdjsonSink {
  append(value: unknown): Promise<void>;
}

export async function createNdjsonSink(path: string): Promise<NdjsonSink> {
  await mkdir(dirname(path), { recursive: true });
  return {
    async append(value: unknown): Promise<void> {
      await appendFile(path, `${JSON.stringify(value)}\n`);
    },
  };
}
