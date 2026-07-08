/**
 * `exportMembersBackup` use-case (design 2026-07-07-members-backup-export).
 *
 * Admin-only, SYNCHRONOUS full-tenant backup: one `runInTenant` transaction
 * gathers members (all statuses) + live contacts + member-linked invoices
 * through the `MembersBackupSource` port, and the `members_backup_exported`
 * audit row commits ATOMICALLY inside that same tx (bulk PII egress must
 * never succeed unaudited — Principle I audit sub-clause). CSV rendering +
 * zipping happen after the tx commits (pure CPU, no reason to hold the
 * connection).
 *
 * Role gate mirrors `generateDirectoryExport` (defence-in-depth behind the
 * route's `requireAdminContext`): manager/member → 'forbidden'. Managers
 * are read-only on the directory but this artefact is the full PII dump —
 * admin only per the approved design.
 *
 * Sync-vs-async: at SweCham scale (~131 members / ~164 contacts / a few
 * hundred invoices) the gather is <100ms and the ZIP <1MB. A 10k+-member
 * tenant should migrate this onto the F9 export-job worker (out of scope,
 * design § Out of scope).
 *
 * Application layer: no ORM imports; `runInTenant` usage follows the
 * `generate-directory-export.ts` precedent (Principle III).
 */
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { ok, err, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import {
  buildContactsCsv,
  buildInvoicesCsv,
  buildMembersCsv,
} from '../members-backup-csv';
import { f9RetentionFor, type InsightsAuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type {
  MembersBackupData,
  MembersBackupSource,
} from '../ports/members-backup-source';

export type ExportMembersBackupActorRole = 'admin' | 'manager' | 'member';

export interface ExportMembersBackupMeta {
  readonly actorUserId: string;
  readonly actorRole: ExportMembersBackupActorRole;
  readonly requestId: string | null;
}

/** Pure ZIP packer port — bound to the fflate adapter in insights-deps. */
export type ZipFilesPort = (
  files: ReadonlyArray<{ readonly name: string; readonly content: string }>,
) => Uint8Array;

export interface ExportMembersBackupDeps {
  readonly source: MembersBackupSource;
  readonly audit: InsightsAuditPort;
  readonly zip: ZipFilesPort;
  readonly clock: ClockPort;
}

export type ExportMembersBackupError = 'forbidden' | 'gather_failed';

export interface ExportMembersBackupOutput {
  readonly zip: Uint8Array;
  readonly filename: string;
  readonly rowCounts: {
    readonly members: number;
    readonly contacts: number;
    readonly invoices: number;
  };
}

export async function exportMembersBackup(
  meta: ExportMembersBackupMeta,
  ctx: TenantContext,
  deps: ExportMembersBackupDeps,
): Promise<Result<ExportMembersBackupOutput, ExportMembersBackupError>> {
  if (meta.actorRole !== 'admin') return err('forbidden');

  let data: MembersBackupData;
  try {
    data = await runInTenant(ctx, async (tx) => {
      const gathered = await deps.source.gatherInTx(tx);
      await deps.audit.recordInTx(tx, {
        tenantId: ctx.slug,
        requestId: meta.requestId,
        eventType: 'members_backup_exported',
        actorUserId: meta.actorUserId,
        summary: `Members backup ZIP exported (${gathered.members.length} members, ${gathered.contacts.length} contacts, ${gathered.invoices.length} invoices)`,
        payload: {
          member_count: gathered.members.length,
          contact_count: gathered.contacts.length,
          invoice_count: gathered.invoices.length,
        },
        retentionYears: f9RetentionFor('members_backup_exported'),
      });
      return gathered;
    });
  } catch (e) {
    logger.error(
      { tenantSlug: ctx.slug, requestId: meta.requestId, errKind: errKind(e) },
      'exportMembersBackup: gather failed',
    );
    return err('gather_failed');
  }

  const zip = deps.zip([
    { name: 'members.csv', content: buildMembersCsv(data.members) },
    { name: 'contacts.csv', content: buildContactsCsv(data.contacts) },
    { name: 'invoices.csv', content: buildInvoicesCsv(data.invoices) },
  ]);

  return ok({
    zip,
    filename: `${ctx.slug}-members-backup-${bangkokStamp(deps.clock.now())}.zip`,
    rowCounts: {
      members: data.members.length,
      contacts: data.contacts.length,
      invoices: data.invoices.length,
    },
  });
}

/**
 * `YYYYMMDD-HHmm` in Asia/Bangkok. Pure UTC+7 shift (TH has no DST) —
 * mirrors `paidAtToBangkokYmd` in F4's CSV export.
 */
function bangkokStamp(now: Date): string {
  const d = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
