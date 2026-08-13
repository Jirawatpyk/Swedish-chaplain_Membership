/**
 * SYSTEM_ACTORS stay inside the reserved uuid namespace.
 *
 * Migration C (0287, applied at the 2026-08-11 cutover) excluded system actors
 * from the admin→super_admin promotion by the RESERVED UUID NAMESPACE
 * (`00000000-0000-0000-0000-0000000%`) rather than an enumerated id list,
 * precisely so a future actor is covered without anyone editing the migration.
 * That only holds while every SYSTEM_ACTORS id is minted inside the namespace —
 * nothing else enforces it, so an actor seeded outside it would have been
 * silently PROMOTED to super_admin at cutover.
 *
 * The migration has run, but the invariant is not historical: the namespace is
 * what erasure/audit tooling uses to tell "system actor" from "human", and a
 * future data migration may key on it the same way 0287 did. This suite lived
 * in `rbac-promotion-gate.test.ts` until PR 5 deleted the D7 gate; the
 * invariant outlives the gate, so it moved here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SYSTEM_ACTORS stay inside the reserved uuid namespace', () => {
  it('every canonical system actor matches the prefix Migration C excludes', () => {
    const src = readFileSync(
      join(process.cwd(), 'scripts', 'seed-system-actors.ts'),
      'utf-8',
    );
    const ids = [...src.matchAll(/id:\s*'([0-9a-f-]{36})'/gi)].map((m) => m[1] as string);
    expect(ids.length, 'no system-actor ids parsed — the fixture shape changed').toBeGreaterThan(0);
    for (const id of ids) {
      expect(id, `${id} sits OUTSIDE the reserved namespace and WOULD be promoted`).toMatch(
        /^00000000-0000-0000-0000-0000000/,
      );
    }
  });
});
