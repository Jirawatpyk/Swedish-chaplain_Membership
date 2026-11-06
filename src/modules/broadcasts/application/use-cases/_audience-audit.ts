/**
 * Spec 139 slice 2 (DA1–DA3) — the Art. 30 rows of the import leg's Resend
 * calls on a segment.
 *
 * `broadcast_audience_disclosed` records a recipient list handed to Resend
 * (tick 1, before `createContactImport`); `broadcast_audience_deleted` records
 * the delete of a segment that may hold recipients, once per segment (deduped
 * on `resend_audience_id` under the repo's advisory lock, in the same tx as
 * the insert; the first `reason` wins). The orphan reclaim writes its deleted
 * row only when this tenant's disclosed row names the segment, copying that
 * row's broadcast and requester (pdpa M-3: never filed under a guessed tenant
 * or member); a segment already recorded as deleted is skipped, and any other
 * gets a WARN and a counter.
 *
 * Every row is written BEFORE its Resend call, in its own tenant-bound
 * `withTx` (never a null tx: that would take a pool connection with no
 * `app.current_tenant`, where RLS writes nothing), so it records a request,
 * not its outcome. On failure (the pre-send unverifiable row's pattern, spec
 * 140 s4):
 *   - an adapter invariant error (`isAdapterInvariantError`: a wiring bug) is
 *     logged at ERROR with `severity: 'critical'` (`<prefix>.audit_invariant`)
 *     and RETHROWN, so the call is never made (review round 2, code-review #5:
 *     logged here, so the tick restart has the line as well as the crons);
 *   - a lock timeout (SQLSTATE 55P03: the dedupe waited
 *     `AUDIENCE_AUDIT_LOCK_TIMEOUT_MS` for the segment's advisory lock) is not
 *     a known loss, because the holder may be writing this very row: the WARN
 *     `<prefix>.audience_audit_lock_timeout` and the counter below (the row may
 *     be missing), and the caller makes the call (review round 2, code-review
 *     #1 / #4, reliability LOW-1);
 *   - any other error is a lost record: logged at ERROR with
 *     `severity: 'critical'` (`<prefix>.audience_audit_lost`) and counted on
 *     `broadcasts_audit_emit_failed_total`, and the caller makes the call
 *     anyway. So a missing row is not proof that nothing was disclosed. No
 *     alert backend is wired: the ERROR line and the counter are the control.
 * The two storage lines log `errLogFields` (class and SQLSTATE), never the
 * driver's message (review round 2, code-review #3).
 *
 * Payloads carry ids and a count only, never an address or a hash.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { errKind, errLogFields } from '@/lib/log-id';
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

/** SQLSTATE `lock_not_available`: a `lock_timeout` wait ran out. */
const LOCK_NOT_AVAILABLE = '55P03';

/** Why `build` wrote nothing: deduped, or (reclaim) never disclosed here. */
type NoRow = 'skip' | 'unattributed';

/**
 * Write one row in its own tx. `build` runs inside that tx and answers the
 * payload, or why nothing is written. Answers what happened.
 */
async function writeAudienceRow<E extends AudienceEventType>(
  deps: AudienceAuditDeps,
  eventType: E,
  logPrefix: AudienceAuditLogPrefix,
  ids: { readonly broadcastId: string | null; readonly resendAudienceId: string },
  summary: (payload: F7AuditPayloadShapes[E]) => string,
  build: (tx: unknown) => Promise<F7AuditPayloadShapes[E] | NoRow>,
): Promise<'written' | NoRow | 'lost'> {
  let result: 'written' | NoRow;
  try {
    result = await deps.broadcastsRepo.withTx(async (tx): Promise<'written' | NoRow> => {
      const payload = await build(tx);
      if (payload === 'skip' || payload === 'unattributed') return payload;
      await deps.audit.emit(tx, {
        eventType,
        tenantId: deps.tenant.slug,
        actorUserId: 'system:cron',
        summary: summary(payload),
        payload: { ...payload },
        requestId: null,
      });
      return 'written';
    });
  } catch (e) {
    const where = {
      tenantId: deps.tenant.slug,
      broadcastId: ids.broadcastId,
      resendAudienceId: ids.resendAudienceId,
      eventType,
    };
    // A wiring bug fails closed: nothing has been sent or deleted yet.
    if (isAdapterInvariantError(e)) {
      logger.error({ ...where, err: errKind(e), severity: 'critical' }, `${logPrefix}.audit_invariant`);
      throw e;
    }
    const fields = errLogFields(e);
    if (fields.code === LOCK_NOT_AVAILABLE) {
      logger.warn({ ...where, ...fields }, `${logPrefix}.audience_audit_lock_timeout`);
    } else {
      logger.error({ ...where, ...fields, severity: 'critical' }, `${logPrefix}.audience_audit_lost`);
    }
    broadcastsMetrics.auditEmitFailed(eventType, deps.tenant.slug);
    return 'lost';
  }
  if (result === 'written') broadcastsMetrics.auditEmitCount(deps.tenant.slug, eventType);
  return result;
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
        ? 'skip'
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

/** The orphan reclaim's ports: the disclosure read too. */
export interface ReclaimAudienceAuditDeps extends AudienceAuditDeps {
  readonly broadcastsRepo: Pick<BroadcastsRepo, 'withTx' | 'hasAudienceDeletedAuditInTx' | 'findAudienceDisclosureInTx'>;
}

/**
 * DA2 (pdpa M-3) — the orphan reclaim is about to delete a segment named for
 * this tenant. Only a segment this tenant DISCLOSED gets a deleted row
 * (`reason: 'orphan_reclaim'`), with the disclosure's broadcast and
 * requester; the dedupe, the read and the insert share one tx, the dedupe
 * first, so a segment that already has this tenant's deleted row is skipped
 * (no row, no WARN) whether or not it was disclosed. Any other segment with
 * no disclosed row was never filled by this deployment (one created before
 * spec 139 s2, or by the attach-failed reclaim): no row, the WARN
 * `broadcasts.audience_reclaim.delete_unattributed` (`deleteReason`, never
 * `reason`: the logger redacts that key) and its counter. The delete runs
 * either way. Never throws, except an adapter invariant error.
 *
 * Review round 2 (code-review #1 / #4): a lock timeout on the dedupe ends the
 * tx before the disclosure read, so that segment writes no row and no
 * unattributed WARN on this run, only the `audience_audit_lock_timeout` WARN
 * and its counter, which are then the only trace of that delete. The delete
 * runs; if it fails, the next daily run lists the segment again and retries
 * the row (dedupe, disclosure read, then the row or the unattributed WARN).
 */
export async function recordReclaimedAudienceDeleted(
  deps: ReclaimAudienceAuditDeps,
  resendAudienceId: string,
): Promise<void> {
  const written = await writeAudienceRow(
    deps,
    'broadcast_audience_deleted',
    'broadcasts.audience_reclaim',
    { broadcastId: null, resendAudienceId },
    (p) => `Broadcast ${p.broadcast_id}: Resend segment removal requested (${p.reason})`,
    async (tx) => {
      // The dedupe first: a segment already recorded as deleted (e.g. cleanup's
      // row for a segment whose delete keeps failing) is not unattributed.
      if (await deps.broadcastsRepo.hasAudienceDeletedAuditInTx(tx, deps.tenant.slug, resendAudienceId)) return 'skip';
      const disclosed = await deps.broadcastsRepo.findAudienceDisclosureInTx(tx, deps.tenant.slug, resendAudienceId);
      if (disclosed === null) return 'unattributed';
      return {
        broadcast_id: disclosed.broadcastId,
        related_member_id: disclosed.relatedMemberId,
        resend_audience_id: resendAudienceId,
        reason: 'orphan_reclaim',
        leg: 'import',
        actor_role: 'system',
      };
    },
  );
  if (written !== 'unattributed') return;
  logger.warn(
    { tenantId: deps.tenant.slug, resendAudienceId, deleteReason: 'never_disclosed' },
    'broadcasts.audience_reclaim.delete_unattributed',
  );
  broadcastsMetrics.audienceReclaimDeleteUnattributed(deps.tenant.slug);
}
