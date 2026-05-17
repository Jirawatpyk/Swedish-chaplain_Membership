/**
 * T022 — `TenantWebhookConfigAggregate` (F6 Domain).
 *
 * Per-tenant, per-source HMAC-SHA256 webhook credentials with 24h grace
 * window post-rotation per FR-008 + research.md R7.
 *
 * Rotation invariants (FR-008 + R7):
 *   - `activeSecret` is always non-null (table NOT NULL).
 *   - `graceSecret` is non-null iff a rotation occurred within the last
 *     24h; the DB CHECK constraint on `tenant_webhook_configs` enforces
 *     `(graceSecret IS NULL) = (graceRotatedAt IS NULL)`.
 *   - Verifier (Phase 3 T043 / Phase 8 T101) tries active first; on
 *     mismatch AND `graceRotatedAt > NOW() - 24h`, tries grace. On
 *     grace-success emits `webhook_secret_grace_used` audit IN ADDITION
 *     to the success event.
 *   - Daily cron (Phase 10) sweeps rows where `graceRotatedAt < NOW() -
 *     24h` and clears the grace secret + grace_rotated_at.
 *
 * `enabled = false` → handler returns 503 + Retry-After per FR-033
 * without touching the stored secrets (incident response without
 * forcing a rotation).
 *
 * Pure TypeScript — Constitution Principle III.
 */
import type { TenantId } from '@/modules/members';
import type { WebhookSecret } from './branded-types';
import type { Source } from './value-objects/source';

/**
 * Phase C / Phase H3.1 — `GraceState` discriminated union encodes the
 * grace-secret pair invariant at the type level. The aggregate field
 * `grace: GraceState` replaces the previous loose pair (`graceSecret +
 * graceRotatedAt`) so callers pattern-match on `state.active` for
 * compile-time-enforced narrowing.
 *
 * Underlying DB columns (`webhook_secret_grace`, `grace_rotated_at`)
 * remain two nullable columns paired by a CHECK constraint at
 * migration 0129; the Drizzle row→aggregate mapper constructs the
 * union once at the boundary. The repo writers continue to write
 * both columns atomically (rotate sets both, clearExpiredGrace clears
 * both) — the DB CHECK enforces the pair invariant at write time.
 */
export type GraceState =
  | { readonly active: false }
  | {
      readonly active: true;
      readonly secret: WebhookSecret;
      readonly rotatedAt: Date;
    };

export interface TenantWebhookConfigAggregate {
  readonly tenantId: TenantId;
  readonly source: Source;

  readonly activeSecret: WebhookSecret;
  /**
   * Grace-secret state — discriminated union. When `active: true`,
   * `secret` + `rotatedAt` are compile-time guaranteed non-null and
   * paired. When `active: false`, both DB columns are NULL.
   */
  readonly grace: GraceState;

  readonly enabled: boolean;

  readonly createdAt: Date;
  readonly lastReceivedAt: Date | null;
  readonly lastRotatedAt: Date | null;
}

/**
 * 24h grace window per FR-008 + R7. Pure predicate — `now` is injected
 * for deterministic testing rather than read from `Date.now()` inside.
 */
export const GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isGraceSecretActive(
  cfg: Pick<TenantWebhookConfigAggregate, 'grace'>,
  now: Date,
): boolean {
  if (!cfg.grace.active) return false;
  const ageMs = now.getTime() - cfg.grace.rotatedAt.getTime();
  return ageMs <= GRACE_WINDOW_MS;
}

/**
 * R3.7.1 — construct a `GraceState` discriminated union from raw DB
 * column values. Migration 0129 CHECK constraint guarantees
 * `(graceSecret IS NULL) = (graceRotatedAt IS NULL)`, so this helper
 * never sees a half-set pair in practice. A half-set pair AT READ time
 * is a hard invariant violation — throw loudly rather than silently
 * coerce to `{ active: false }`.
 *
 * Used by:
 *   - `drizzleTenantWebhookConfigRepository.toAggregate`
 *     (`src/modules/events/infrastructure/drizzle-tenant-webhook-config-repository.ts`)
 *   - `events-webhook-deps.ts` inline mapper (composition adapter)
 *
 * Both call sites previously inlined the same 3-arm match; consolidating
 * here removes ~12 LOC and pins the read-time invariant in one place.
 */
export function asGraceState(
  rawSecret: WebhookSecret | null,
  rawRotatedAt: Date | null,
): GraceState {
  if (rawSecret !== null && rawRotatedAt !== null) {
    return { active: true, secret: rawSecret, rotatedAt: rawRotatedAt };
  }
  if (rawSecret === null && rawRotatedAt === null) {
    return { active: false };
  }
  throw new Error(
    'GraceState invariant violated at read-time: graceSecret + graceRotatedAt are half-set. Likely migration 0129 CHECK regression or RLS surfacing rows that violate the pair invariant.',
  );
}
