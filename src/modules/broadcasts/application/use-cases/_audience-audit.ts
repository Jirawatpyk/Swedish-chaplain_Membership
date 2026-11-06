/**
 * Spec 139 slice 2 (DA1–DA3) — the Art. 30 rows of the import leg's Resend
 * calls on a segment.
 *
 * `broadcast_audience_disclosed` records a recipient list handed to Resend
 * (tick 1, before `createContactImport`); `broadcast_audience_deleted` records
 * the delete of a segment that may hold recipients, once per (tenant,
 * segment). Spec 142: that row is written only through `AudienceDeletedAuditPort.emitOnce`,
 * whose `ON CONFLICT DO NOTHING` against migration 0328's partial unique index
 * is the dedupe (the first `reason` wins); `emitOnce` answering false is a
 * skip. Every deleted row is built by `audienceDeletedInput`. The orphan
 * reclaim writes its deleted row only when this tenant's disclosed row names
 * the segment, copying that row's broadcast and requester (pdpa M-3: never
 * filed under a guessed tenant or member); a segment already recorded as
 * deleted is skipped, and any other gets a WARN and a counter.
 *
 * Every row is written BEFORE its Resend call, in its own tenant-bound
 * `withTx` (never a null tx: that would take a pool connection with no
 * `app.current_tenant`, where RLS writes nothing), so it records a request,
 * not its outcome. The envelope is `writePreCallAuditRow` (spec 142 AO4,
 * shared with the pre-send unverifiable row); this file supplies its log
 * lines. On failure:
 *   - an adapter invariant error (`isAdapterInvariantError`: a wiring bug) is
 *     logged at ERROR with `severity: 'critical'` (`<prefix>.audit_invariant`)
 *     and RETHROWN, so the call is never made (review round 2, code-review #5:
 *     logged here, so the tick restart has the line as well as the crons);
 *   - a lock timeout (SQLSTATE 55P03: `emitOnce`'s INSERT waited
 *     `AUDIENCE_AUDIT_LOCK_TIMEOUT_MS` on another tx's uncommitted insert of
 *     the same key, spec 142) is not a known loss, because the holder may be
 *     writing this very row: the WARN `<prefix>.audience_audit_lock_timeout`
 *     and the counter below (the row may be missing), and the caller makes the
 *     call (spec 139 s2 review round 2, code-review #1 / #4, reliability
 *     LOW-1);
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

import type {
  AudienceDeletedAuditPort,
  AudienceDeletedEmitInput,
  AudienceDeleteReason,
  AuditPort,
} from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import { writePreCallAuditRow, type PreCallAuditRowDeps } from './_pre-call-audit-row';

/** The ports the disclosed row needs. */
export interface AudienceAuditDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<BroadcastsRepo, 'withTx'>;
  readonly audit: Pick<AuditPort, 'emit'>;
}

/**
 * A delete site's ports: the deleted row's one writer, `emitOnce` (spec 142;
 * the index is the dedupe, so restart and cleanup read nothing first).
 */
export interface AudienceDeleteAuditDeps extends Omit<AudienceAuditDeps, 'audit'> {
  readonly audit: Pick<AudienceDeletedAuditPort, 'emitOnce'>;
}

type AudienceEventType = 'broadcast_audience_disclosed' | 'broadcast_audience_deleted';

/** The log-line prefix of the site that writes the row. */
export type AudienceAuditLogPrefix =
  | 'broadcasts.audience_import'
  | 'broadcasts.audience_cleanup'
  | 'broadcasts.audience_reclaim';

/** SQLSTATE `lock_not_available`: a `lock_timeout` wait ran out. */
const LOCK_NOT_AVAILABLE = '55P03';

/** Why `write` wrote nothing: deduped (`emitOnce` false), or (reclaim) never disclosed here. */
type NoRow = 'skip' | 'unattributed';

/**
 * Write one audience row through the shared envelope, with this file's log
 * lines. `write` runs inside the row's tx and answers whether it wrote, or why
 * it did not. Answers what happened.
 */
async function writeAudienceRow(
  deps: PreCallAuditRowDeps,
  eventType: AudienceEventType,
  logPrefix: AudienceAuditLogPrefix,
  ids: {
    readonly broadcastId: string | null;
    readonly resendAudienceId: string;
    /** Log-only (the reclaim): the id parsed from the segment name, never on the record. */
    readonly segmentNameBroadcastId?: string;
  },
  write: (tx: unknown) => Promise<'written' | NoRow>,
): Promise<'written' | NoRow | 'lost'> {
  const where = {
    tenantId: deps.tenant.slug,
    broadcastId: ids.broadcastId,
    resendAudienceId: ids.resendAudienceId,
    ...(ids.segmentNameBroadcastId === undefined ? {} : { segmentNameBroadcastId: ids.segmentNameBroadcastId }),
    eventType,
  };
  return writePreCallAuditRow(deps, eventType, write, {
    onInvariant: (e) => logger.error({ ...where, err: errKind(e), severity: 'critical' }, `${logPrefix}.audit_invariant`),
    onLost: (e) => {
      const fields = errLogFields(e);
      if (fields.code === LOCK_NOT_AVAILABLE) {
        logger.warn({ ...where, ...fields }, `${logPrefix}.audience_audit_lock_timeout`);
      } else {
        logger.error({ ...where, ...fields, severity: 'critical' }, `${logPrefix}.audience_audit_lost`);
      }
    },
  });
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
  await writeAudienceRow(deps, 'broadcast_audience_disclosed', 'broadcasts.audience_import', fields, async (tx) => {
    await deps.audit.emit(tx, {
      eventType: 'broadcast_audience_disclosed',
      tenantId: deps.tenant.slug,
      actorUserId: 'system:cron',
      summary: `Broadcast ${fields.broadcastId}: recipient list disclosure to Resend requested (${fields.recipientCount} recipients)`,
      payload: {
        broadcast_id: fields.broadcastId,
        related_member_id: fields.relatedMemberId,
        resend_audience_id: fields.resendAudienceId,
        recipient_count: fields.recipientCount,
        leg: 'import',
        actor_role: 'system',
      },
      requestId: null,
    });
    return 'written';
  });
}

/**
 * Spec 142 (AO4) — the one builder of the deleted row, for every site. The
 * segment id is required by type: a NULL key never conflicts in the index.
 */
function audienceDeletedInput(
  tenant: TenantContext,
  fields: {
    readonly broadcastId: string;
    readonly relatedMemberId: string;
    readonly resendAudienceId: string;
    readonly reason: AudienceDeleteReason;
  },
): AudienceDeletedEmitInput {
  return {
    eventType: 'broadcast_audience_deleted',
    tenantId: tenant.slug,
    actorUserId: 'system:cron',
    summary: `Broadcast ${fields.broadcastId}: Resend segment removal requested (${fields.reason})`,
    payload: {
      broadcast_id: fields.broadcastId,
      related_member_id: fields.relatedMemberId,
      resend_audience_id: fields.resendAudienceId,
      reason: fields.reason,
      leg: 'import',
      actor_role: 'system',
    },
    requestId: null,
  };
}

/**
 * DA2 — a segment is about to be deleted. Deduped by the index: a segment that
 * already has this tenant's deleted row gets no second one (`emitOnce` answers
 * false, a skip; the delete still runs). No read first (spec 142); the tenant
 * binding is checked inside `emitOnce`. Never throws, except an adapter
 * invariant error.
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
  await writeAudienceRow(deps, 'broadcast_audience_deleted', logPrefix, fields, async (tx) =>
    (await deps.audit.emitOnce(tx, audienceDeletedInput(deps.tenant, fields))) ? 'written' : 'skip',
  );
}

/** The orphan reclaim's ports: the disclosure read and the lockless existence read too. */
export interface ReclaimAudienceAuditDeps extends AudienceDeleteAuditDeps {
  readonly broadcastsRepo: Pick<BroadcastsRepo, 'withTx' | 'hasAudienceDeletedAuditInTx' | 'findAudienceDisclosureInTx'>;
}

/**
 * DA2 (pdpa M-3) — the orphan reclaim is about to delete a segment named for
 * this tenant. Only a segment this tenant DISCLOSED gets a deleted row
 * (`reason: 'orphan_reclaim'`), with the disclosure's broadcast and
 * requester. The disclosure read comes first, in the row's tx (review round 1,
 * code-review #5):
 *   - found: `emitOnce`. False (the key already has its row) is a skip, with
 *     no WARN and no count. `emitOnce` is the tx's last statement, so its
 *     `SET LOCAL lock_timeout` bounds its own INSERT only.
 *   - not found: the lockless existence read. A segment already recorded as
 *     deleted (e.g. cleanup's row for a pre-s2 segment whose delete keeps
 *     failing) is a skip, with no WARN. Any other was never filled by this
 *     deployment (one created before spec 139 s2, or by the attach-failed
 *     reclaim): no row, the WARN
 *     `broadcasts.audience_reclaim.delete_unattributed` (`deleteReason`, never
 *     `reason`: the logger redacts that key) and its counter.
 * The delete runs either way. Never throws, except an adapter invariant error.
 *
 * Spec 142: the existence read is lockless, so it does not order the reclaim
 * against another writer of the row. The worst case is one false unattributed
 * WARN (a row written after that read found nothing), which needs cleanup to
 * act on a live row while the reclaim acts on a gone one. A lock timeout on
 * the INSERT (55P03) writes no row and no unattributed WARN on this run, only
 * the `audience_audit_lock_timeout` WARN and its counter, which are then the
 * only trace of that delete. The delete runs; if it fails, the next daily run
 * lists the segment again and retries the row.
 *
 * Review round 3 (code-review #5): `segmentNameBroadcastId` is the id parsed
 * from the segment name. It goes on the lost, lock-timeout and invariant lines
 * only (so ops can find the E-Blast); `broadcastId` there stays `null`, and the
 * record never carries it (a name is a guess).
 */
export async function recordReclaimedAudienceDeleted(
  deps: ReclaimAudienceAuditDeps,
  resendAudienceId: string,
  segmentNameBroadcastId: string,
): Promise<void> {
  const written = await writeAudienceRow(
    deps,
    'broadcast_audience_deleted',
    'broadcasts.audience_reclaim',
    { broadcastId: null, resendAudienceId, segmentNameBroadcastId },
    async (tx) => {
      const disclosed = await deps.broadcastsRepo.findAudienceDisclosureInTx(tx, deps.tenant.slug, resendAudienceId);
      if (disclosed === null) {
        // Not disclosed here: a segment already recorded as deleted is not
        // unattributed.
        const recorded = await deps.broadcastsRepo.hasAudienceDeletedAuditInTx(tx, deps.tenant.slug, resendAudienceId);
        return recorded ? 'skip' : 'unattributed';
      }
      const wrote = await deps.audit.emitOnce(
        tx,
        audienceDeletedInput(deps.tenant, {
          broadcastId: disclosed.broadcastId,
          relatedMemberId: disclosed.relatedMemberId,
          resendAudienceId,
          reason: 'orphan_reclaim',
        }),
      );
      return wrote ? 'written' : 'skip';
    },
  );
  if (written !== 'unattributed') return;
  logger.warn(
    { tenantId: deps.tenant.slug, resendAudienceId, deleteReason: 'never_disclosed' },
    'broadcasts.audience_reclaim.delete_unattributed',
  );
  broadcastsMetrics.audienceReclaimDeleteUnattributed(deps.tenant.slug);
}
