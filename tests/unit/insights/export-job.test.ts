/**
 * F9 US5/US6 (T070) — `ExportJob` domain state-machine unit tests.
 *
 * Pins data-model.md § 4 + research R5:
 *   requested → processing → ready → delivered → expired
 *                    └────────── failed ──────────┘
 *   - legal vs illegal transitions (illegal must be rejected by the worker),
 *   - terminal / claimable predicates,
 *   - stuck-`processing` reclaim window (critique E2),
 *   - deterministic idempotency-key canonical input (Principle VIII).
 */
import { describe, expect, it } from 'vitest';
import {
  EXPORT_KINDS,
  EXPORT_STATUSES,
  STUCK_PROCESSING_TIMEOUT_MS,
  canTransition,
  exportJobIdempotencyInput,
  isExportKind,
  isClaimable,
  isStuckProcessing,
  isTerminal,
  type ExportStatus,
} from '@/modules/insights/domain/export-job';

describe('export status/kind tuples', () => {
  it('match the export_status / export_kind DB enums', () => {
    expect([...EXPORT_STATUSES]).toEqual([
      'requested',
      'processing',
      'ready',
      'delivered',
      'expired',
      'failed',
    ]);
    expect([...EXPORT_KINDS]).toEqual([
      'gdpr_member_archive',
      'directory_ebook',
      'directory_json',
      'audit_export',
    ]);
  });
});

describe('canTransition (state machine, data-model § 4)', () => {
  const legal: Array<[ExportStatus, ExportStatus]> = [
    ['requested', 'processing'],
    ['requested', 'failed'],
    ['processing', 'ready'],
    ['processing', 'failed'],
    ['processing', 'requested'], // bounded reclaim
    ['ready', 'delivered'],
    ['ready', 'expired'],
    ['delivered', 'expired'],
  ];

  it.each(legal)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  const illegal: Array<[ExportStatus, ExportStatus]> = [
    ['requested', 'ready'], // must be claimed first
    ['requested', 'delivered'],
    ['processing', 'delivered'], // must reach ready first
    ['ready', 'requested'],
    ['ready', 'processing'],
    ['delivered', 'ready'],
    ['delivered', 'delivered'],
    ['expired', 'ready'], // terminal
    ['expired', 'requested'],
    ['failed', 'processing'], // terminal
    ['failed', 'ready'],
  ];

  it.each(illegal)('rejects %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('no status may transition to itself', () => {
    for (const s of EXPORT_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  // Repo↔Domain parity tripwire (review I5): the Drizzle repo enforces each
  // transition with a hand-rolled `WHERE status = $from` guard rather than calling
  // `canTransition`. This mirror pins every guard the repo relies on to the Domain
  // graph — if a future edit to ALLOWED_TRANSITIONS drops an edge a repo method
  // uses, this fails CI, flagging that the repo guard (drizzle-export-job-repo.ts)
  // is now stale. (The full fix — drive the repo from the graph — is tracked.)
  // Genuine state-CHANGING guards (a `from → to` graph edge). Note: the repo's
  // consume/setDownloadToken/markExpired methods ALSO accept `delivered` as a
  // from-state for idempotent re-runs (delivered→delivered / token re-set) — that
  // is intentionally NOT a graph edge (no-op, not a transition) and is excluded.
  const REPO_GUARD_TRANSITIONS: Array<[string, ExportStatus, ExportStatus]> = [
    ['claimInTx', 'requested', 'processing'],
    ['markReadyInTx', 'processing', 'ready'],
    ['markFailedInTx (from requested)', 'requested', 'failed'],
    ['markFailedInTx (from processing)', 'processing', 'failed'],
    ['consumeForDownloadInTx', 'ready', 'delivered'],
    ['markExpiredInTx (from ready)', 'ready', 'expired'],
    ['markExpiredInTx (from delivered)', 'delivered', 'expired'],
    ['reclaimStuckInTx', 'processing', 'failed'],
  ];

  it.each(REPO_GUARD_TRANSITIONS)(
    'repo guard %s (%s → %s) is permitted by the Domain graph',
    (_method, from, to) => {
      expect(canTransition(from, to)).toBe(true);
    },
  );
});

describe('predicates', () => {
  it('isTerminal = expired | failed', () => {
    expect(isTerminal('expired')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('requested')).toBe(false);
    expect(isTerminal('processing')).toBe(false);
    expect(isTerminal('ready')).toBe(false);
    expect(isTerminal('delivered')).toBe(false);
  });

  it('isClaimable = requested only', () => {
    expect(isClaimable('requested')).toBe(true);
    for (const s of EXPORT_STATUSES.filter((x) => x !== 'requested')) {
      expect(isClaimable(s)).toBe(false);
    }
  });

  it('isExportKind accepts every known kind and rejects unknown strings', () => {
    for (const k of EXPORT_KINDS) expect(isExportKind(k)).toBe(true);
    expect(isExportKind('not_a_kind')).toBe(false);
    expect(isExportKind('')).toBe(false);
  });
});

describe('isStuckProcessing (reclaim window, critique E2)', () => {
  const claimedAt = 1_000_000;

  it('a processing job claimed longer ago than the timeout is stuck', () => {
    expect(
      isStuckProcessing(
        'processing',
        claimedAt,
        claimedAt + STUCK_PROCESSING_TIMEOUT_MS + 1,
      ),
    ).toBe(true);
  });

  it('a processing job within the timeout is not stuck', () => {
    expect(
      isStuckProcessing(
        'processing',
        claimedAt,
        claimedAt + STUCK_PROCESSING_TIMEOUT_MS - 1,
      ),
    ).toBe(false);
  });

  it('a non-processing job is never "stuck" regardless of age', () => {
    expect(
      isStuckProcessing('ready', claimedAt, claimedAt + 10 * STUCK_PROCESSING_TIMEOUT_MS),
    ).toBe(false);
    expect(
      isStuckProcessing('requested', claimedAt, claimedAt + 10 * STUCK_PROCESSING_TIMEOUT_MS),
    ).toBe(false);
  });

  it('a null claim timestamp is never stuck (defensive)', () => {
    expect(isStuckProcessing('processing', null, claimedAt + 10 * STUCK_PROCESSING_TIMEOUT_MS)).toBe(
      false,
    );
  });
});

describe('exportJobIdempotencyInput (Principle VIII)', () => {
  it('is deterministic for identical components', () => {
    const a = exportJobIdempotencyInput({
      tenantId: 'swecham',
      kind: 'directory_ebook',
      subjectMemberId: null,
      requestedForPeriod: '2026',
    });
    const b = exportJobIdempotencyInput({
      tenantId: 'swecham',
      kind: 'directory_ebook',
      subjectMemberId: null,
      requestedForPeriod: '2026',
    });
    expect(a).toBe(b);
  });

  it('null subject/period collapse to a stable sentinel, not "null"/"undefined"', () => {
    const s = exportJobIdempotencyInput({
      tenantId: 'swecham',
      kind: 'directory_json',
      subjectMemberId: null,
      requestedForPeriod: null,
    });
    expect(s).not.toContain('null');
    expect(s).not.toContain('undefined');
    expect(s).toContain('swecham');
    expect(s).toContain('directory_json');
  });

  it('differs across tenant, kind, subject, and period', () => {
    const base = {
      tenantId: 'swecham',
      kind: 'gdpr_member_archive' as const,
      subjectMemberId: 'm1',
      requestedForPeriod: '2026',
    };
    const variants = [
      { ...base, tenantId: 'other' },
      { ...base, kind: 'directory_ebook' as const },
      { ...base, subjectMemberId: 'm2' },
      { ...base, requestedForPeriod: '2027' },
    ];
    const baseKey = exportJobIdempotencyInput(base);
    for (const v of variants) {
      expect(exportJobIdempotencyInput(v)).not.toBe(baseKey);
    }
  });
});
