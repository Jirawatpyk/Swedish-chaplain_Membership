/**
 * F119 T082 — Drizzle adapter for `BroadcastApprovalScrubPort` (research R17).
 *
 * Three statements, each on the caller's `runInTenant` tx, each naming
 * `tenant_id` on both sides of its member join, each keyed on
 * `broadcasts.requested_by_member_id` — a column the parent's redaction GUC
 * arm forbids changing, so the join finds the member's E-Blasts whether the
 * parent row was already scrubbed or not (order-independent).
 *
 * The two UPDATEs set `app.allow_broadcast_redaction = 'on'` themselves
 * (SET LOCAL — scoped to this tx, idempotent) rather than relying on
 * `scrubContentForMemberInTx` having run first: under it the 0308 triggers
 * permit ONLY `subject`/`body_html`/`body_source`/`note_to_member` on a sent
 * version and ONLY `reason` on a decision, so this path cannot move anything
 * else. `'[redacted]'` satisfies every CHECK it touches (subject 1–200 chars,
 * body 1–200 KB, note ≤ 1,000, reason 1–500 / 1–2,000).
 *
 * The WHERE clauses exclude rows already redacted, so each count is rows
 * CHANGED and a re-drive returns 0.
 *
 * The outbox leg DELETEs pending rows — the same disposition as the members
 * erasure's `outboxCancelAdapter` (sent / permanently-failed history is kept;
 * it holds no content). `notifications_outbox` is RLS + FORCE, so the tx's
 * `app.current_tenant` confines it; the explicit `tenant_id` is belt and
 * braces.
 */
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import type { BroadcastApprovalScrubPort } from '../../application/ports/broadcast-approval-scrub-port';
import { F119_NOTIFICATION_TYPES } from '../../application/ports/eblast-notification-outbox-port';
import { assertTenantBoundTx } from './drizzle-broadcasts-repo';

const SENTINEL = '[redacted]';

export const drizzleBroadcastApprovalScrub: BroadcastApprovalScrubPort = {
  async redactVersionsForMemberInTx(txUnknown, tenantId, memberId) {
    const tx = txUnknown as TenantTx;
    await assertTenantBoundTx(tx, tenantId as string, 'redactVersionsForMemberInTx');
    await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
    const rows = (await tx.execute(sql`
      UPDATE broadcast_versions v SET
        subject = ${SENTINEL},
        body_html = ${SENTINEL},
        body_source = ${SENTINEL},
        note_to_member = CASE WHEN v.note_to_member IS NULL THEN NULL ELSE ${SENTINEL} END
      WHERE v.tenant_id = ${tenantId as string}
        AND EXISTS (
              SELECT 1 FROM broadcasts b
               WHERE b.tenant_id = ${tenantId as string}
                 AND b.broadcast_id = v.broadcast_id
                 AND b.requested_by_member_id = ${memberId}
            )
        AND (
              v.subject <> ${SENTINEL}
           OR v.body_html <> ${SENTINEL}
           OR v.body_source <> ${SENTINEL}
           OR (v.note_to_member IS NOT NULL AND v.note_to_member <> ${SENTINEL})
            )
      RETURNING v.id
    `)) as unknown as Array<{ id: string }>;
    return { redactedCount: rows.length };
  },

  async redactDecisionReasonsForMemberInTx(txUnknown, tenantId, memberId) {
    const tx = txUnknown as TenantTx;
    await assertTenantBoundTx(tx, tenantId as string, 'redactDecisionReasonsForMemberInTx');
    await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
    const rows = (await tx.execute(sql`
      UPDATE broadcast_member_decisions d SET reason = ${SENTINEL}
      WHERE d.tenant_id = ${tenantId as string}
        AND d.reason IS NOT NULL
        AND d.reason <> ${SENTINEL}
        AND EXISTS (
              SELECT 1 FROM broadcasts b
               WHERE b.tenant_id = ${tenantId as string}
                 AND b.broadcast_id = d.broadcast_id
                 AND b.requested_by_member_id = ${memberId}
            )
      RETURNING d.id
    `)) as unknown as Array<{ id: string }>;
    return { redactedCount: rows.length };
  },

  async cancelPendingNotificationsForMemberInTx(txUnknown, tenantId, memberId) {
    const tx = txUnknown as TenantTx;
    await assertTenantBoundTx(tx, tenantId as string, 'cancelPendingNotificationsForMemberInTx');
    const rows = (await tx.execute(sql`
      DELETE FROM notifications_outbox o
      WHERE o.tenant_id = ${tenantId as string}
        AND o.status = 'pending'
        AND o.notification_type::text = ANY(ARRAY[${sql.join(
          F119_NOTIFICATION_TYPES.map((t) => sql`${t}`),
          sql`, `,
        )}]::text[])
        AND EXISTS (
              SELECT 1 FROM broadcasts b
               WHERE b.tenant_id = ${tenantId as string}
                 AND b.broadcast_id::text = o.context_data->>'broadcastId'
                 AND b.requested_by_member_id = ${memberId}
            )
      RETURNING o.id
    `)) as unknown as Array<{ id: string }>;
    return { cancelledCount: rows.length };
  },
};
