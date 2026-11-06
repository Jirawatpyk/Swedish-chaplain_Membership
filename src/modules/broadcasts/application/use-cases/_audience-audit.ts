/**
 * Spec 139 slice 2 (DA1–DA3) — the Art. 30 rows of the import leg's Resend
 * calls on a segment.
 *
 * `broadcast_audience_disclosed` records a recipient list handed to Resend
 * (tick 1, before `createContactImport`); `broadcast_audience_deleted` records
 * the delete of a segment that may hold recipients, once per segment (deduped
 * on `resend_audience_id` under the repo's advisory lock, in the same tx as
 * the insert; the first `reason` wins).
 *
 * Every row is written BEFORE its Resend call, in its own tenant-bound
 * `withTx` (never a null tx: that would take a pool connection with no
 * `app.current_tenant`, where RLS writes nothing), so it records a request,
 * not its outcome. On failure (the pre-send unverifiable row's pattern, spec
 * 140 s4):
 *   - an adapter invariant error (`isAdapterInvariantError`: a wiring bug)
 *     RETHROWS, so the call is never made;
 *   - any other error is a lost record: logged at ERROR with
 *     `severity: 'critical'` (`<prefix>.audience_audit_lost`) and counted on
 *     `broadcasts_audit_emit_failed_total`, and the caller makes the call
 *     anyway. So a missing row is not proof that nothing was disclosed. No
 *     alert backend is wired: the ERROR line and the counter are the control.
 *
 * Payloads carry ids and a count only, never an address or a hash.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';

import type { AudienceDeleteReason, AuditPort, F7AuditPayloadShapes } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import { isAdapterInvariantError } from './_safe-audit-emit';

/** The ports a site needs to write an audience row. */
export interface AudienceAuditDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<BroadcastsRepo, 'withTx'>;
  readonly audit: Pick<AuditPort, 'emit'>;
}

/** A delete site's ports: the dedupe read too. */
export interface AudienceDeleteAuditDeps extends AudienceAuditDeps {
  readonly broadcastsRepo: Pick<BroadcastsRepo, 'withTx' | 'hasAudienceDeletedAuditInTx'>;
}

type AudienceEventType = 'broadcast_audience_disclosed' | 'broadcast_audience_deleted';

/** The log-line prefix of the site that writes the row. */
export type AudienceAuditLogPrefix =
  | 'broadcasts.audience_import'
  | 'broadcasts.audience_cleanup'
  | 'broadcasts.audience_reclaim';

/**
 * Write one row in its own tx. `build` runs inside that tx and answers the
 * payload, or `null` to write nothing. Answers whether a row was written.
 */
async function writeAudienceRow<E extends AudienceEventType>(
  deps: AudienceAuditDeps,
  eventType: E,
  logPrefix: AudienceAuditLogPrefix,
  ids: { readonly broadcastId: string | null; readonly resendAudienceId: string },
  summary: (payload: F7AuditPayloadShapes[E]) => string,
  build: (tx: unknown) => Promise<F7AuditPayloadShapes[E] | null>,
): Promise<'written' | 'skipped' | 'lost'> {
  let written = false;
  try {
    await deps.broadcastsRepo.withTx(async (tx) => {
      written = false;
      const payload = await build(tx);
      if (payload === null) return;
      await deps.audit.emit(tx, {
        eventType,
        tenantId: deps.tenant.slug,
        actorUserId: 'system:cron',
        summary: summary(payload),
        payload: { ...payload },
        requestId: null,
      });
      written = true;
    });
  } catch (e) {
    // A wiring bug fails closed: nothing has been sent or deleted yet.
    if (isAdapterInvariantError(e)) throw e;
    logger.error(
      {
        tenantId: deps.tenant.slug,
        broadcastId: ids.broadcastId,
        resendAudienceId: ids.resendAudienceId,
        eventType,
        err: errKind(e),
        severity: 'critical',
      },
      `${logPrefix}.audience_audit_lost`,
    );
    broadcastsMetrics.auditEmitFailed(eventType, deps.tenant.slug);
    return 'lost';
  }
  if (!written) return 'skipped';
  broadcastsMetrics.auditEmitCount(deps.tenant.slug, eventType);
  return 'written';
}

/**
 * DA1 — the recipient list is about to go to Resend. Never deduped: a row that
 * already holds a segment is restarted, so one segment id reaches the import
 * once. Never throws, except an adapter invariant error.
 */
export async function recordAudienceDisclosed(
  deps: AudienceAuditDeps,
  fields: {
    readonly broadcastId: string;
    readonly relatedMemberId: string;
    readonly resendAudienceId: string;
    readonly recipientCount: number;
  },
): Promise<void> {
  await writeAudienceRow(
    deps,
    'broadcast_audience_disclosed',
    'broadcasts.audience_import',
    fields,
    (p) => `Broadcast ${p.broadcast_id}: recipient list disclosure to Resend requested (${p.recipient_count} recipients)`,
    async () => ({
      broadcast_id: fields.broadcastId,
      related_member_id: fields.relatedMemberId,
      resend_audience_id: fields.resendAudienceId,
      recipient_count: fields.recipientCount,
      leg: 'import',
      actor_role: 'system',
    }),
  );
}

/**
 * DA2 — a segment is about to be deleted. Deduped: a segment that already has
 * this tenant's deleted row gets no second one (the delete still runs). Never
 * throws, except an adapter invariant error.
 */
export async function recordAudienceDeleted(
  deps: AudienceDeleteAuditDeps,
  fields: {
    readonly broadcastId: string;
    readonly relatedMemberId: string;
    readonly resendAudienceId: string;
    readonly reason: AudienceDeleteReason;
  },
  logPrefix: AudienceAuditLogPrefix,
): Promise<void> {
  await writeAudienceRow(
    deps,
    'broadcast_audience_deleted',
    logPrefix,
    fields,
    (p) => `Broadcast ${p.broadcast_id}: Resend segment removal requested (${p.reason})`,
    async (tx) =>
      (await deps.broadcastsRepo.hasAudienceDeletedAuditInTx(tx, deps.tenant.slug, fields.resendAudienceId))
        ? null
        : {
            broadcast_id: fields.broadcastId,
            related_member_id: fields.relatedMemberId,
            resend_audience_id: fields.resendAudienceId,
            reason: fields.reason,
            leg: 'import',
            actor_role: 'system',
          },
  );
}
