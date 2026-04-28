/**
 * Audit 2026-04-26 round-2 self-review #R2-A4 — runtime pinning canary
 * (revised after #4 cacheComponents migration was reverted).
 *
 * Each F5 route MUST explicitly declare `runtime = 'nodejs'` because:
 *   1. Stripe SDK + `node:crypto` require Node.js (not Edge)
 *   2. Defensive declaration prevents accidental Edge regression even
 *      though Next.js 16 default IS nodejs
 *   3. Without an explicit declaration, a future Next.js default-flip
 *      OR a developer adding `runtime = 'edge'` would silently break
 *      the F5 pipeline (Stripe SDK throws on Edge runtime)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const F5_ROUTE_FILES = [
  'src/app/api/payments/initiate/route.ts',
  'src/app/api/payments/[id]/cancel/route.ts',
  'src/app/api/webhooks/stripe/route.ts',
] as const;

describe('F5 route runtime pinning (audit 2026-04-26 round-2 #R2-A4)', () => {
  for (const relPath of F5_ROUTE_FILES) {
    describe(relPath, () => {
      const source = readFileSync(resolve(process.cwd(), relPath), 'utf8');

      it('does NOT export `runtime = \'edge\'` (Stripe SDK + node:crypto require Node)', () => {
        expect(source).not.toMatch(
          /export\s+const\s+runtime\s*=\s*['"]edge['"]/,
        );
      });

      it('explicitly exports `runtime = \'nodejs\'` (defensive against default flip)', () => {
        expect(source).toMatch(
          /export\s+const\s+runtime\s*=\s*['"]nodejs['"]/,
        );
      });
    });
  }
});
