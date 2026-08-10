/**
 * 016 T039 — `src/lib/rbac.ts` must stay under coverage enforcement.
 *
 * The composition root is the single gate every staff surface calls, so its
 * 100%-branch threshold (vitest.config.ts) is a Constitution-II requirement.
 * A well-meaning edit that adds the file to the coverage `exclude` list (the
 * fate of its predecessor `src/lib/rbac-guard.ts`, excluded as a "Next.js
 * server-runtime utility") would silently void that threshold — the entry
 * still parses, it just never measures anything. Text-level assertion on the
 * config file keeps that failure mode loud.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('T039 rbac.ts coverage enforcement', () => {
  const config = readFileSync(join(process.cwd(), 'vitest.config.ts'), 'utf8');

  it('declares the 100%-branch per-file threshold', () => {
    expect(config).toMatch(/'src\/lib\/rbac\.ts':\s*\{[^}]*branches:\s*100/);
  });

  it('never lists src/lib/rbac.ts in the coverage exclude list', () => {
    // The exclude entries are quoted path strings; the threshold entry is a
    // quoted KEY followed by `:`. An exclude entry is the bare quoted string
    // WITHOUT a trailing colon — assert no such line exists.
    const excludeEntry = /'src\/lib\/rbac\.ts',/;
    expect(config).not.toMatch(excludeEntry);
  });
});
