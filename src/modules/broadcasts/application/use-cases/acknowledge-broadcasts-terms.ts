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
 * Atomicity: F3 use-case + F7 audit emit run in two phases (F3 first,
 * F7 audit second) — F3's tx is closed before the F7 audit fires. This
 * is acceptable for a write-once consent event because the F3 column
 * change is the legal source of truth; an audit-log write failure
 * downgrades observability but does not invalidate the consent.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { AuditPort } from '../ports/audit-port';
import { f7RetentionFor } from '../ports/audit-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';

export type AcknowledgeBroadcastsTermsError =
  | { readonly kind: 'ack.member_not_found'; readonly memberId: string }
  | { readonly kind: 'ack.server_error'; readonly message: string };

export interface AcknowledgeBroadcastsTermsDeps {
  readonly tenant: TenantContext;
  readonly membersBridge: MembersBridgePort;
  readonly audit: AuditPort;
  readonly clock: { now(): Date };
}

export interface AcknowledgeBroadcastsTermsInput {
  readonly memberId: string;
  readonly actorUserId: string;
  readonly locale: 'en' | 'th' | 'sv';
  readonly requestId: string | null;
}

export interface AcknowledgeBroadcastsTermsOutput {
  readonly alreadyAcknowledged: boolean;
  readonly acknowledgedAt: Date;
}

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
    // Already acknowledged — idempotent success, NO audit emit.
    return ok({
      alreadyAcknowledged: true,
      acknowledgedAt: deps.clock.now(),
    });
  }

  const acknowledgedAt = deps.clock.now();

  // Q15 audit emit. tx=null → adapter writes on auto-commit; matches
  // F4 read-path probe convention. Loss of a single audit row is
  // tolerable; the F3 column change is the consent source of truth.
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
    return err({
      kind: 'ack.server_error',
      message: e instanceof Error ? e.message : 'audit emit failed',
    });
  }

  return ok({ alreadyAcknowledged: false, acknowledgedAt });
}
