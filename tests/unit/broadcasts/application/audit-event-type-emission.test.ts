/**
 * Round 5 review fix — emission-grep parity test.
 *
 * Complements `tests/integration/broadcasts/audit-event-type-parity.test.ts`
 * which validates the enum ↔ TS-tuple parity. That structural check
 * does NOT prove every event in `F7_AUDIT_EVENT_TYPES` actually has an
 * `audit.emit({eventType: '<name>'})` call site somewhere in the F7
 * source tree — a dead-code event would pass the structural test but
 * silently mean ops never sees that audit row in production.
 *
 * Strategy: read every `.ts` file under `src/modules/broadcasts/`
 * and `src/app/api/{cron,webhooks}/broadcasts/` (and the unsubscribe
 * route + the two cron metrics gauge routes), grep for each event
 * type literal, and assert that every event in `F7_AUDIT_EVENT_TYPES`
 * appears in at least one source file.
 *
 * False-positive guard: events that legitimately have no emission
 * site (placeholder slots reserved for F7.1) are listed in
 * `KNOWN_NOT_YET_EMITTED` with a justification.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { F7_AUDIT_EVENT_TYPES } from '@/modules/broadcasts/application/ports/audit-port';

const ROOTS_TO_GREP = [
  'src/modules/broadcasts',
  'src/app/api/cron/broadcasts',
  'src/app/api/webhooks/resend-broadcasts',
  'src/app/unsubscribe',
  // F3 boundary that emits broadcast_cancelled (cascade adapter):
  'src/modules/members/infrastructure/adapters',
];

/**
 * Events with no emission site in the F7 source tree (yet). Each entry
 * MUST carry a code-comment justification — if you find yourself adding
 * a new entry here, double-check that the omission is intentional and
 * not a regression from an earlier round.
 *
 * R6 staff-review W-S2/W-S3 — verified emission sites for previously
 * suspected gaps:
 *   - `broadcast_resend_audience_drift` → emitted in
 *     `dispatch-scheduled-broadcast.ts:800` (no longer allow-listed).
 *   - `broadcast_resend_drift_check_unverifiable` → emitted at
 *     `dispatch-scheduled-broadcast.ts:764`.
 *   - `broadcast_cross_tenant_probe` → emitted at
 *     `enforce-tenant-context.ts:65,81`.
 *
 * The list is intentionally empty post-R6 — every F7 audit event type
 * has a verified emission site in the production tree.
 *
 * Phase 3F.11.19 update (2026-05-19) — F71A US2 + US7 audit events
 * declared in Phase 2 (T031 + migration 0167) but emit sites NOT
 * YET IMPLEMENTED. US2 (image embedding) = Phase 4; US7 (multi-
 * template library) = Phase 5. Both phases deferred to F7.1a-Phase-2
 * follow-up branch per Staff Review W-1 (2026-05-19). Removing these
 * from KNOWN_NOT_YET_EMITTED when Phase 4 + Phase 5 ship.
 */
const KNOWN_NOT_YET_EMITTED: ReadonlyArray<string> = [
  // F71A US2 (Phase 4 — not implemented on this branch)
  'broadcast_body_image_source_unsafe',
  'broadcast_image_too_large',
  'broadcast_image_allowlist_updated',
  // F71A US7 (Phase 5 — not implemented on this branch)
  'broadcast_template_created',
  'broadcast_template_updated',
  'broadcast_template_deleted',
];

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // Root may not exist on a partial checkout — skip silently.
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
    }
  }
  return out;
}

describe('F7 audit-event emission-site parity (Round 5)', () => {
  it('every event in F7_AUDIT_EVENT_TYPES has at least one emission site (or is in KNOWN_NOT_YET_EMITTED)', () => {
    const allFiles = ROOTS_TO_GREP.flatMap(listTsFiles).filter(
      // The audit-port itself defines the literal — exclude so it
      // doesn't count as an emission site.
      (p) =>
        !p.includes(join('broadcasts', 'application', 'ports', 'audit-port')),
    );
    const corpus = allFiles
      .map((p) => readFileSync(p, 'utf-8'))
      .join('\n--FILE-BREAK--\n');

    const missing: string[] = [];
    for (const eventType of F7_AUDIT_EVENT_TYPES) {
      if (KNOWN_NOT_YET_EMITTED.includes(eventType)) continue;
      // We grep for the quoted literal — same shape every emit site
      // uses (`eventType: 'broadcast_…'`).
      if (!corpus.includes(`'${eventType}'`)) missing.push(eventType);
    }

    expect(
      missing,
      `F7 audit events declared but never emitted from src: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
