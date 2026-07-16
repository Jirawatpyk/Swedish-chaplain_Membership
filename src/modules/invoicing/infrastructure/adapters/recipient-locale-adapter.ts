/**
 * Email-locale audit 2026-07-16 — live member email-locale read for F4
 * auto-emails (see `recipient-locale-port.ts` for the why).
 *
 * Cross-module raw SQL on the F3 `members` + `contacts` tables — same posture
 * as `member-identity-adapter.ts` (RLS still scopes both tables via the
 * per-tenant `tx`; the members barrel exposes no tx-threaded locale read).
 *
 * Precedence: `members.preferred_locale` (nullable — only ever set by an
 * explicit member/admin choice) COALESCEs over the primary contact's
 * `preferred_language` (NOT NULL DEFAULT 'en' — indistinguishable from "never
 * chose"). An out-of-range value (should be unreachable behind the migration
 * 0082 CHECK) returns null so the outbox `?? 'en'` default applies.
 */
import { sql } from 'drizzle-orm';
import type { RecipientLocalePort } from '../../application/ports/recipient-locale-port';
import type { F4OutboxLocale } from '../../application/ports/email-outbox-port';
import { db, runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

function narrowLocale(value: unknown): F4OutboxLocale | null {
  return value === 'en' || value === 'th' || value === 'sv' ? value : null;
}

async function readLocale(
  tx: TenantTx | typeof db,
  tenantId: string,
  memberId: string,
): Promise<F4OutboxLocale | null> {
  // COALESCE the member-level explicit choice over the primary contact's
  // column. Tenant-filtered explicitly (belt-and-braces with RLS).
  const rows = (await tx.execute(sql`
    SELECT COALESCE(
             m.preferred_locale,
             (SELECT c.preferred_language
                FROM contacts c
               WHERE c.tenant_id = m.tenant_id
                 AND c.member_id = m.member_id
                 AND c.is_primary = true
               LIMIT 1)
           ) AS locale
      FROM members m
     WHERE m.tenant_id = ${tenantId}
       AND m.member_id = ${memberId}
     LIMIT 1
  `)) as unknown as Array<{ locale: string | null }>;
  return narrowLocale(rows[0]?.locale ?? null);
}

export const recipientLocaleAdapter: RecipientLocalePort = {
  async getMemberEmailLocale(
    txUnknown,
    tenantId: string,
    memberId: string,
  ): Promise<F4OutboxLocale | null> {
    // `null` tx = standalone read (resend-pdf runs outside a mutating financial
    // tx) → self-scope via runInTenant so the FORCE-RLS policy applies. When a
    // caller threads its open tenant tx, reuse it (same RLS context).
    const tx = txUnknown as TenantTx | null;
    if (tx === null) {
      return runInTenant(asTenantContext(tenantId), (scoped) =>
        readLocale(scoped, tenantId, memberId),
      );
    }
    return readLocale(tx, tenantId, memberId);
  },
};
