import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `data.json` is GENERATED (scripts/generate-thai-postal-data.ts) and committed.
 * If you regenerate it, update this hash and `src/lib/thai-postal/SOURCE.md`
 * in the same commit. A failure here means someone hand-edited the dataset.
 */
const EXPECTED_SHA256 =
  'e89c9820179373b1035e67d9965bfd9bfab781b8fa1205901a81c182c4f8609a';

describe('thai-postal data.json', () => {
  it('matches the checksum recorded in SOURCE.md', () => {
    const bytes = readFileSync(
      resolve(process.cwd(), 'src/lib/thai-postal/data.json'),
    );
    const actual = createHash('sha256').update(bytes).digest('hex');

    expect(actual).toBe(EXPECTED_SHA256);
  });
});
