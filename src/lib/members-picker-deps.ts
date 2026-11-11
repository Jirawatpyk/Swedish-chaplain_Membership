/**
 * #89 — composition wrappers over the members barrel's slim picker reads.
 *
 * Each opens one `runInTenant` (Principle I) and degrades a failed read to an
 * empty answer with a warn: the new-invoice picker then has no preload (it
 * still searches the server) and the invoices list shows "—" for a draft's
 * buyer, as it did when the directory read failed. `asTenantContext` runs
 * outside the try, so a malformed slug (a caller bug) throws.
 */
import 'server-only';
import { runInTenant } from '@/lib/db';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import {
  memberCompanyNamesByIdsInTx,
  memberPickerOptionsInTx,
  type MemberPickerRow,
  type MemberPickerStatus,
} from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';

export async function runListMemberPickerOptions(
  tenantSlug: string,
  input: { readonly statuses: ReadonlyArray<MemberPickerStatus>; readonly limit: number },
): Promise<readonly MemberPickerRow[]> {
  const ctx = asTenantContext(tenantSlug);
  try {
    return await runInTenant(ctx, (tx) => memberPickerOptionsInTx(tx, tenantSlug, input));
  } catch (e) {
    logger.warn(
      { event: 'members_picker_options_read_failed', tenant_slug: tenantSlug, err: errKind(e) },
      '[#89] member picker preload failed — the picker falls back to server search only',
    );
    return [];
  }
}

export async function runListMemberNamesByIds(
  tenantSlug: string,
  memberIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string>> {
  if (memberIds.length === 0) return new Map();
  const ctx = asTenantContext(tenantSlug);
  try {
    return await runInTenant(ctx, (tx) => memberCompanyNamesByIdsInTx(tx, tenantSlug, memberIds));
  } catch (e) {
    logger.warn(
      {
        event: 'members_picker_names_read_failed',
        tenant_slug: tenantSlug,
        member_id_count: memberIds.length,
        err: errKind(e),
      },
      '[#89] draft buyer-name read failed — the rows show the placeholder',
    );
    return new Map();
  }
}
