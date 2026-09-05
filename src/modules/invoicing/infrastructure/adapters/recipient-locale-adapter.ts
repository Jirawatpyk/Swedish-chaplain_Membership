/**
 * Email-locale audit 2026-07-16 — live member email-locale read for F4
 * auto-emails (see `recipient-locale-port.ts` for the why).
 *
 * Cross-module raw SQL on the F3 `members` + `contacts` tables — same posture
 * as `member-identity-adapter.ts` (RLS still scopes both tables via the
 * per-tenant `tx`; the members barrel exposes no tx-threaded locale read).
 *
 * 108: both reads also state `removed_at IS NULL` next to `is_primary`. That
 * is REDUNDANT today — migration 0009's CHECK `contacts_primary_not_removed`
 * already forbids a removed row from staying primary (verified by mutation:
 * dropping the predicate changes no result, and the seed that would prove it
 * is rejected by the constraint). It stays because both reads should state the
 * whole rule they depend on rather than inherit half of it from a constraint
 * three migrations away.
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
                 AND c.removed_at IS NULL
               -- At most ONE row can match: contacts_one_primary_per_member
               -- (migration 0009) is a UNIQUE index whose WHERE clause is this
               -- predicate exactly. See the note on readRecipient below.
               LIMIT 1)
           ) AS locale
      FROM members m
     WHERE m.tenant_id = ${tenantId}
       AND m.member_id = ${memberId}
     LIMIT 1
  `)) as unknown as Array<{ locale: string | null }>;
  return narrowLocale(rows[0]?.locale ?? null);
}

/**
 * 108 FR-001 — the live money-email recipient: the member's one primary,
 * non-removed contact. The JOIN drops the member row when no such contact
 * exists, so "no live primary" surfaces as `null` (no fallback address).
 * Locale precedence is identical to `readLocale` above.
 */
async function readRecipient(
  tx: TenantTx | typeof db,
  tenantId: string,
  memberId: string,
): Promise<{ email: string; locale: F4OutboxLocale | null } | null> {
  const rows = (await tx.execute(sql`
    SELECT c.email                                        AS email,
           COALESCE(m.preferred_locale, c.preferred_language) AS locale
      FROM members m
      JOIN contacts c
        ON c.tenant_id = m.tenant_id
       AND c.member_id = m.member_id
       AND c.is_primary = true
       AND c.removed_at IS NULL
     WHERE m.tenant_id = ${tenantId}
       AND m.member_id = ${memberId}
     -- Exactly one row can match. contacts_one_primary_per_member (migration
     -- 0009) is a UNIQUE index on (tenant_id, member_id) whose WHERE clause is
     -- character-for-character the two conditions above, so LIMIT 1 is
     -- unambiguous and needs no ORDER BY tiebreak. Review round 3 finding #13
     -- asked for one on the premise that the invariant was not yet a DB
     -- constraint; it has been since 0009 (PR-B adds the at-LEAST-one half, not
     -- the at-most-one half). Verified against the live index definition, and
     -- pinned by tests/integration/invoicing/primary-contact-read-agreement.
     LIMIT 1
  `)) as unknown as Array<{ email: string | null; locale: string | null }>;
  const row = rows[0];
  if (row === undefined || row.email === null) return null;
  return { email: row.email, locale: narrowLocale(row.locale) };
}

/**
 * 108 FR-003 — the banner's three facts in one indexed read.
 *
 * `erased_at` and `status` come from the SAME members row the primary-contact
 * JOIN already visits, so this costs one query, not three. LEFT JOIN (not the
 * inner JOIN `readRecipient` uses) because the member must be returned even
 * when they have no live primary contact — that IS the question.
 */
async function readRecipientStatus(
  tx: TenantTx | typeof db,
  tenantId: string,
  memberId: string,
): Promise<{ hasLivePrimary: boolean; erased: boolean; archived: boolean } | null> {
  const rows = (await tx.execute(sql`
    SELECT (c.contact_id IS NOT NULL) AS has_live_primary,
           (m.erased_at IS NOT NULL)  AS erased,
           (m.status = 'archived')    AS archived
      FROM members m
      LEFT JOIN contacts c
        ON c.tenant_id = m.tenant_id
       AND c.member_id = m.member_id
       AND c.is_primary = true
       AND c.removed_at IS NULL
       AND btrim(c.email) <> ''
     WHERE m.tenant_id = ${tenantId}
       AND m.member_id = ${memberId}
     LIMIT 1
  `)) as unknown as Array<{
    has_live_primary: boolean;
    erased: boolean;
    archived: boolean;
  }>;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    hasLivePrimary: row.has_live_primary === true,
    erased: row.erased === true,
    archived: row.archived === true,
  };
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

  async getMemberEmailRecipient(
    txUnknown,
    tenantId: string,
    memberId: string,
  ): Promise<{ email: string; locale: F4OutboxLocale | null } | null> {
    // Same tx convention as getMemberEmailLocale: null tx = standalone read
    // (resend-pdf) → self-scope via runInTenant so FORCE-RLS applies.
    const tx = txUnknown as TenantTx | null;
    if (tx === null) {
      return runInTenant(asTenantContext(tenantId), (scoped) =>
        readRecipient(scoped, tenantId, memberId),
      );
    }
    return readRecipient(tx, tenantId, memberId);
  },

  async getMemberRecipientStatus(txUnknown, tenantId: string, memberId: string) {
    const tx = txUnknown as TenantTx | null;
    if (tx === null) {
      return runInTenant(asTenantContext(tenantId), (scoped) =>
        readRecipientStatus(scoped, tenantId, memberId),
      );
    }
    return readRecipientStatus(tx, tenantId, memberId);
  },
};
