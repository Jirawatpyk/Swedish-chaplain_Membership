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
 * Phase C C1 — typed view of the grace-secret pair invariant.
 * The aggregate keeps the two-field shape for migration-friendliness
 * (47 reader sites + DB columns) but `getGraceState(cfg)` returns a
 * discriminated union that callers can pattern-match for compile-time
 * invariant expression. The DB CHECK on `tenant_webhook_configs`
 * enforces `(graceSecret IS NULL) = (graceRotatedAt IS NULL)`.
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
  readonly graceSecret: WebhookSecret | null;
  readonly graceRotatedAt: Date | null;

  readonly enabled: boolean;

  readonly createdAt: Date;
  readonly lastReceivedAt: Date | null;
  readonly lastRotatedAt: Date | null;
}

/**
 * Pattern-matchable derivation of the grace-secret invariant. Use this
 * in code paths where the pair is consumed together so the compiler
 * narrows access via `state.active`. Existing callers reading the
 * two-field shape directly remain valid (DB CHECK enforces the
 * invariant at write time).
 */
export function getGraceState(
  cfg: Pick<TenantWebhookConfigAggregate, 'graceSecret' | 'graceRotatedAt'>,
): GraceState {
  if (cfg.graceSecret === null || cfg.graceRotatedAt === null) {
    return { active: false };
  }
  return {
    active: true,
    secret: cfg.graceSecret,
    rotatedAt: cfg.graceRotatedAt,
  };
}

/**
 * 24h grace window per FR-008 + R7. Pure predicate — `now` is injected
 * for deterministic testing rather than read from `Date.now()` inside.
 */
export const GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isGraceSecretActive(
  cfg: Pick<TenantWebhookConfigAggregate, 'graceSecret' | 'graceRotatedAt'>,
  now: Date,
): boolean {
  const state = getGraceState(cfg);
  if (!state.active) return false;
  const ageMs = now.getTime() - state.rotatedAt.getTime();
  return ageMs <= GRACE_WINDOW_MS;
}
