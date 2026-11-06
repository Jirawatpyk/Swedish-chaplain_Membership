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
 * `KNOWN_NOT_YET_EMITTED` with a justification. Events whose emitter was
 * deleted on purpose are `RETIRED`, and the opposite is asserted for them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  F7_AUDIT_EVENT_TYPES,
  RETIRED_F7_AUDIT_EVENT_TYPES,
} from '@/modules/broadcasts/application/ports/audit-port';

const ROOTS_TO_GREP = [
  'src/modules/broadcasts',
  'src/app/api/cron/broadcasts',
  'src/app/api/webhooks/resend-broadcasts',
  'src/app/unsubscribe',
  // Public-unsubscribe pipeline shared by the page and the one-click POST
  // (emits broadcast_unsubscribe_token_invalid).
  'src/lib/broadcasts-public-unsubscribe.ts',
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
 *   - `broadcast_resend_audience_drift` → emitted by the legacy dispatch
 *     leg until spec 140 s4 deleted it; now `RETIRED`, below.
 *   - `broadcast_resend_drift_check_unverifiable` → emitted by the legacy
 *     leg, and since PR #756 review round 1 by the import tick's
 *     unverifiable-count arm (`build-audience-tick.ts`).
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
 *
 * F119 PR-2 (2026-09-23): the ten 0308 approval-round events were listed
 * here, each naming its emitting task, and each left with its emitter; since
 * T130 (2026-09-24) the list holds no F119 value, and it must stay that way.
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
  // R2.1 M-test-2 close-out — forward-looking event. Migration 0168
  // seeds run-once at first apply (rare conflict surface); a future
  // Application-layer `reseedStarterTemplates` use-case will become
  // the primary emit caller. No emit site in src/ today.
  'broadcast_template_seed_skipped_existing_name',
  // F119 PR-2 (migration 0308, T050): no F119 value may appear here — every
  // one of the fourteen has its emit site (the last three, the approval
  // lifecycle's, since T130 `expire-stale-member-approvals`).
];

/**
 * Event types that can never be emitted again, read from the audit port's
 * `RETIRED_F7_AUDIT_EVENT_TYPES` rather than restated here: the six batch events
 * of 108 Phase 9 and, since PR #756 review round 1 (pdpa L-2), the two whose
 * ONLY emitter was the legacy dispatch leg spec 140 s4 deleted. They are not
 * "not yet emitted" (that list is for events still to be built): nothing will
 * emit them again. They are OUT of `F7_AUDIT_EVENT_TYPES` (which forces an emit
 * site per entry) and the DB enum and the en/th/sv labels keep them, so rows
 * already written still render in the F9 audit viewer and the DSAR export.
 * Asserted the other way round: none is in the live tuple, and none has an
 * emission site.
 */
const RETIRED: ReadonlyArray<string> = RETIRED_F7_AUDIT_EVENT_TYPES;

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      if (statSync(dir).isFile()) {
        out.push(dir);
        continue;
      }
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

/** Every source file under `ROOTS_TO_GREP`, the audit port itself excluded. */
function emissionCorpus(): string {
  const allFiles = ROOTS_TO_GREP.flatMap(listTsFiles).filter(
    // The audit-port itself defines the literal — exclude so it
    // doesn't count as an emission site.
    (p) =>
      !p.includes(join('broadcasts', 'application', 'ports', 'audit-port')),
  );
  return allFiles
    .map((p) => readFileSync(p, 'utf-8'))
    .join('\n--FILE-BREAK--\n');
}

describe('F7 audit-event emission-site parity (Round 5)', () => {
  it('every event in F7_AUDIT_EVENT_TYPES has at least one emission site (or is in KNOWN_NOT_YET_EMITTED or RETIRED)', () => {
    const corpus = emissionCorpus();

    const missing: string[] = [];
    for (const eventType of F7_AUDIT_EVENT_TYPES) {
      if (KNOWN_NOT_YET_EMITTED.includes(eventType)) continue;
      if (RETIRED.includes(eventType)) continue;
      // We grep for the quoted literal — same shape every emit site
      // uses (`eventType: 'broadcast_…'`).
      if (!corpus.includes(`'${eventType}'`)) missing.push(eventType);
    }

    expect(
      missing,
      `F7 audit events declared but never emitted from src: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every RETIRED event is out of the live tuple, is not KNOWN_NOT_YET_EMITTED, and has NO emission site', () => {
    const corpus = emissionCorpus();
    // Positive control: the corpus is the real tree, so an always-empty read
    // cannot pass the negative assertion below.
    expect(corpus).toContain(`'broadcast_failed_to_dispatch'`);

    const f7Types: ReadonlyArray<string> = F7_AUDIT_EVENT_TYPES;
    expect(RETIRED.filter((t) => f7Types.includes(t)), 'RETIRED ∩ F7_AUDIT_EVENT_TYPES = ∅').toEqual([]);
    expect(RETIRED.filter((t) => KNOWN_NOT_YET_EMITTED.includes(t))).toEqual([]);
    const emitted = RETIRED.filter((t) => corpus.includes(`'${t}'`));
    expect(emitted, `RETIRED events that still have an emission site: ${emitted.join(', ')}`).toEqual([]);
  });

  // PR #756 review round 1 (pdpa L-2) — the legacy leg's two orphans are retired
  // where every consumer reads it (the parity test, the audit viewer dropdown),
  // and the unverifiable row, which the import tick emits again, is not.
  it('the two types only the legacy leg emitted are RETIRED_F7_AUDIT_EVENT_TYPES; the unverifiable row is live', () => {
    expect(RETIRED).toEqual(
      expect.arrayContaining(['broadcast_resend_audience_drift', 'broadcast_dispatch_idempotency_conflict_pre_send']),
    );
    expect(RETIRED).not.toContain('broadcast_resend_drift_check_unverifiable');
    expect(F7_AUDIT_EVENT_TYPES).toContain('broadcast_resend_drift_check_unverifiable');
  });
});
