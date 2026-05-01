/**
 * F7 US3 AS7 — `acknowledge-broadcasts-terms.ts` Application use-case.
 *
 * Member CTA on the GDPR Art. 7 banner (Q15 + Q19 per-tenant scope).
 * Sets `members.broadcasts_acknowledged_at = now()` via the F3
 * `markBroadcastsAcknowledged` bridge + emits the
 * `member_acknowledged_broadcasts_terms` F7 audit event.
 *
 * Idempotent: re-acknowledgment returns `{ alreadyAcknowledged: true }`
 * with no audit emission (the event-type already lives in the audit log
 * from the first acknowledgment; emitting it twice would create
 * misleading consent records).
 *
 * Atomicity tradeoff: F3 use-case + F7 audit emit run in two phases (F3
 * first, F7 audit second) — F3's tx is closed before the F7 audit fires.
 * The F3 column change is the **legal source of truth** for consent.
 * If the audit emit fails AFTER the F3 column commits, we **swallow the
 * audit failure to a logger.error and still return ok** — surfacing the
 * audit-emit error to the route would force the client to display an
 * error banner for a successfully-recorded consent, AND a retry would
 * hit the F3 idempotent path which skips the audit emit, leaving the
 * audit row permanently missing. Best-effort audit + observability log
 * is the only consistent semantic; a future audit-row-backfill cron can
 * recover from logger entries if needed.
 */
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import type { AuditPort } from '../ports/audit-port';
import { f7RetentionFor } from '../ports/audit-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';

export type AcknowledgeBroadcastsTermsError =
  | {
      readonly kind: 'ack.member_not_found';
      readonly memberId: MemberId;
    }
  // Round 5 CRIT — F3 repo failure surfaces here so the route can
  // 500 + logger.error instead of silently 200-OK with a lost consent.
  | {
      readonly kind: 'ack.repo_error';
      readonly cause: unknown;
    };

export interface AcknowledgeBroadcastsTermsDeps {
  readonly tenant: TenantContext;
  readonly membersBridge: MembersBridgePort;
  readonly audit: AuditPort;
  readonly clock: { now(): Date };
}

export interface AcknowledgeBroadcastsTermsInput {
  readonly memberId: MemberId;
  readonly actorUserId: string;
  readonly locale: 'en' | 'th' | 'sv';
  readonly requestId: string | null;
}

/**
 * Discriminated union — the `acknowledgedAt` on the `'fresh'` variant
 * is the truthful consent timestamp; the `'idempotent'` variant has no
 * timestamp because the F3 bridge does not currently return the
 * persisted column on the already-acknowledged path. Callers that
 * need the original timestamp must read it separately from the F3
 * member record (or the F3 bridge can be extended to return it).
 */
export type AcknowledgeBroadcastsTermsOutput =
  | { readonly kind: 'fresh'; readonly acknowledgedAt: Date }
  | { readonly kind: 'idempotent' };

export async function acknowledgeBroadcastsTerms(
  deps: AcknowledgeBroadcastsTermsDeps,
  input: AcknowledgeBroadcastsTermsInput,
): Promise<
  Result<AcknowledgeBroadcastsTermsOutput, AcknowledgeBroadcastsTermsError>
> {
  const result = await deps.membersBridge.markBroadcastsAcknowledged(
    deps.tenant,
    input.memberId,
    input.locale,
  );

  if (!result.ok) {
    if (result.error.kind === 'mark_ack.member_not_found') {
      return err({
        kind: 'ack.member_not_found',
        memberId: input.memberId,
      });
    }
    if (result.error.kind === 'mark_ack.repo_error') {
      // Round 5 CRIT — propagate so the route returns 500. The audit
      // row was never written, the F3 column was never set; the user
      // MUST see an error toast and retry.
      logger.error(
        {
          err:
            result.error.cause instanceof Error
              ? result.error.cause.message
              : String(result.error.cause),
          tenantId: deps.tenant.slug,
          memberId: input.memberId,
          userId: input.actorUserId,
          requestId: input.requestId,
        },
        'broadcasts.acknowledge.repo_error',
      );
      return err({ kind: 'ack.repo_error', cause: result.error.cause });
    }
    // Already acknowledged — idempotent success. No `acknowledgedAt`
    // field because we'd be returning `clock.now()`, which is NOT
    // the persisted consent timestamp; the discriminant tells the
    // caller "this was a no-op; if you need the original timestamp,
    // read it from the F3 member record separately".
    return ok({ kind: 'idempotent' });
  }

  const acknowledgedAt = deps.clock.now();

  // Q15 audit emit (the F3 column change is the legal source of truth;
  // see header doc for the atomicity tradeoff). tx=null → adapter writes
  // on auto-commit. Failure is logged as `ack.audit_emit_failed` so a
  // future backfill cron can reconstruct missing audit rows from the
  // logged correlationId + memberId, but the consent itself is
  // already-and-permanently recorded.
  try {
    await deps.audit.emit(null, {
      tenantId: deps.tenant.slug,
      requestId: input.requestId,
      eventType: 'member_acknowledged_broadcasts_terms',
      actorUserId: input.actorUserId,
      summary: `Member ${input.memberId} acknowledged broadcasts terms (locale=${input.locale})`,
      payload: {
        memberId: input.memberId,
        userId: input.actorUserId,
        acknowledgedAt: acknowledgedAt.toISOString(),
        bannerLocale: input.locale,
        retentionYears: f7RetentionFor('member_acknowledged_broadcasts_terms'),
      },
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: deps.tenant.slug,
        memberId: input.memberId,
        userId: input.actorUserId,
        bannerLocale: input.locale,
        acknowledgedAt: acknowledgedAt.toISOString(),
        requestId: input.requestId,
      },
      'broadcasts.acknowledge.audit_emit_failed',
    );
    // Fall through to ok() — the F3 column already records consent.
  }

  return ok({ kind: 'fresh', acknowledgedAt });
}
