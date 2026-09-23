/**
 * F119 T055 — Drizzle adapter for `BroadcastVersionsRepo` (migration 0305).
 *
 * Every query runs on the caller's `runInTenant` `tx` — the port makes it
 * required, so there is no path to the pool-global `db` (which would bypass
 * RLS + FORCE silently; the F7.1a US2 rule). Every WHERE also names
 * `tenant_id`, so the application layer scopes the row even before RLS does.
 * Drizzle-inferred row types stay inside this file.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import type { TenantSlug } from '@/modules/tenants';
import { asBroadcastId, type BroadcastId } from '../../domain/broadcast';
import type { BroadcastVersion } from '../../domain/approval/broadcast-version';
import type {
  BroadcastVersionsRepo,
  BroadcastVersionsTx,
  NewBroadcastVersion,
  WorkingCopyWrite,
} from '../../application/ports/broadcast-versions-repo';
import { broadcastVersions, type BroadcastVersionRow } from '../schema';

function toVersion(row: BroadcastVersionRow): BroadcastVersion {
  return {
    id: row.id,
    tenantId: row.tenantId,
    broadcastId: asBroadcastId(row.broadcastId),
    versionNo: row.versionNo,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodySource: row.bodySource,
    noteToMember: row.noteToMember,
    authoredByUserId: row.authoredByUserId,
    authoredByRole: row.authoredByRole,
    sentToMemberAt: row.sentToMemberAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const drizzleBroadcastVersionsRepo: BroadcastVersionsRepo = {
  async listByBroadcast(
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
    tx: BroadcastVersionsTx,
  ): Promise<readonly BroadcastVersion[]> {
    const rows = await (tx as TenantTx)
      .select()
      .from(broadcastVersions)
      .where(
        and(
          eq(broadcastVersions.tenantId, tenantId as string),
          eq(broadcastVersions.broadcastId, broadcastId as string),
        ),
      )
      .orderBy(asc(broadcastVersions.versionNo));
    return rows.map(toVersion);
  },

  async insert(
    tenantId: TenantSlug,
    input: NewBroadcastVersion,
    tx: BroadcastVersionsTx,
  ): Promise<BroadcastVersion> {
    const rows = await (tx as TenantTx)
      .insert(broadcastVersions)
      .values({
        tenantId: tenantId as string,
        broadcastId: input.broadcastId as string,
        versionNo: input.versionNo,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        bodySource: input.bodySource,
        noteToMember: input.noteToMember,
        authoredByUserId: input.authoredByUserId,
        authoredByRole: input.authoredByRole,
        sentToMemberAt: input.sentToMemberAt,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('broadcast_versions_insert_returned_no_row');
    return toVersion(row);
  },

  async updateWorkingCopy(
    tenantId: TenantSlug,
    versionId: string,
    write: WorkingCopyWrite,
    tx: BroadcastVersionsTx,
  ): Promise<BroadcastVersion | null> {
    const rows = await (tx as TenantTx)
      .update(broadcastVersions)
      .set({
        subject: write.subject,
        bodyHtml: write.bodyHtml,
        bodySource: write.bodySource,
        noteToMember: write.noteToMember,
        updatedAt: write.updatedAt,
      })
      .where(
        and(
          eq(broadcastVersions.tenantId, tenantId as string),
          eq(broadcastVersions.id, versionId),
          isNull(broadcastVersions.sentToMemberAt),
        ),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? null : toVersion(row);
  },
};
