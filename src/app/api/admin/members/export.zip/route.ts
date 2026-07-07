/**
 * Members Backup Export (design 2026-07-07) — GET
 * `/api/admin/members/export.zip`.
 *
 * Admin-only full-tenant backup ZIP (members.csv + contacts.csv +
 * invoices.csv). Guard: `members:bulk`+`write` — the policy matrix grants
 * that pair to admin ONLY (`policies.ts`: manager never bulk, member never
 * staff surface), so managers are rejected at the guard, before the
 * use-case's own role gate (defence-in-depth).
 *
 * Audit `members_backup_exported` (5y) commits inside the use-case's
 * gather transaction. Response is a small in-memory ZIP (<1MB at chamber
 * scale) — no streaming needed; the async F9 export-job path is the
 * documented escape hatch for 10k+-member tenants.
 *
 * Node runtime pinned (Drizzle).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { buildAttachmentContentDisposition } from '@/lib/content-disposition';
import { logger } from '@/lib/logger';
import {
  exportMembersBackup,
  makeExportMembersBackupDeps,
} from '@/modules/insights';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<Response> {
  const ctx = await requireAdminContext(request, {
    resource: 'members:bulk',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  const result = await exportMembersBackup(
    {
      actorUserId: ctx.current.user.id,
      actorRole: ctx.current.user.role as 'admin' | 'manager' | 'member',
      requestId,
    },
    tenantCtx,
    makeExportMembersBackupDeps(),
  );

  if (!result.ok) {
    if (result.error === 'forbidden') {
      // Cloak: non-admin actors must not learn the endpoint exists.
      return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
    }
    logger.error(
      { tenantSlug: tenantCtx.slug, requestId, err: result.error },
      '[admin-members-backup] export use-case failed',
    );
    return NextResponse.json({ error: { code: 'server_error' } }, { status: 500 });
  }

  const { zip, filename, rowCounts } = result.value;
  return new NextResponse(Buffer.from(zip), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': buildAttachmentContentDisposition(filename),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      // For the button's success toast.
      'X-Members-Count': String(rowCounts.members),
      'X-Contacts-Count': String(rowCounts.contacts),
      'X-Invoices-Count': String(rowCounts.invoices),
    },
  });
}
