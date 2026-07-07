/**
 * Members Backup Export — Drizzle/raw-SQL source adapter (design 2026-07-07).
 *
 * Three reads, ONE caller-supplied `runInTenant` tx (RLS-scoped; a repo
 * method reaching for the pool-global `db` here would silently bypass RLS —
 * F7.1a US2 incident class):
 *   - members: EVERY status (active/inactive/archived); GDPR-erased rows
 *     come out as stored (already-redacted tombstone, `erased_at` set).
 *   - contacts: live only (`removed_at IS NULL`).
 *   - invoices: member-linked rows (membership + member-linked event fee);
 *     `member_id IS NULL` event-buyer invoices have no member_number to
 *     join on and are out of scope (design § invoices.csv).
 *
 * member_number renders `{prefix}-{0000}` via the members module's public
 * `formatMemberNumber` (prefix from tenant_member_settings, COALESCE to
 * DEFAULT_MEMBER_NUMBER_PREFIX). Timestamps → ISO 8601 UTC via to_char (a
 * plain `::text` cast on a timestamptz renders Postgres's own
 * `YYYY-MM-DD HH:MI:SS+00` shape, not `T`/`Z` ISO — the port's documented
 * contract requires true ISO 8601, so `to_char` is deliberate here); satang
 * bigints stay TEXT strings end-to-end (no float coercion).
 *
 * Tenant scoping — module-level singleton, NOT a `makeXxxRepo(tenantId)`
 * factory (2026-07-07 verify-point, see task-4-report.md):
 * `MembersBackupSource.gatherInTx(tx: unknown)` (Task 2, locked for this
 * task) carries no `ctx`/`tenantId` parameter — the use-case shares ONE
 * `runInTenant` transaction between the gather and the atomic
 * `members_backup_exported` audit write, so only `tx` is threaded through.
 * That rules out a constructor-bound `tenantId` (there is nothing to bind it
 * from at `makeExportMembersBackupDeps()` call time). This adapter instead
 * follows the sibling module-level-constant sources in this same directory
 * (`memberSourceAdapter`, `invoiceSourceAdapter`,
 * `benefitConsumptionAggregateAdapter`) which likewise add an EXPLICIT
 * tenant predicate alongside RLS as a second wall (Principle I) — here via
 * `current_setting('app.current_tenant', TRUE)`, the only tenant-identity
 * handle available inside a `tx`-only method (the same session GUC
 * `runInTenant`'s `SET LOCAL` established, and the same value every RLS
 * policy on these tables already compares against).
 */
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import {
  DEFAULT_MEMBER_NUMBER_PREFIX,
  asMemberNumber,
  formatMemberNumber,
} from '@/modules/members';
import type {
  ContactBackupRow,
  InvoiceBackupRow,
  MemberBackupRow,
  MembersBackupData,
  MembersBackupSource,
} from '../../application/ports/members-backup-source';

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;
const CURRENT_TENANT = sql`current_setting('app.current_tenant', TRUE)`;

interface MemberRaw {
  member_number: number;
  company_name: string;
  legal_entity_type: string | null;
  tax_id: string | null;
  is_head_office: boolean;
  website: string | null;
  founded_year: number | null;
  plan: string | null;
  plan_year: number;
  registration_fee_paid: boolean;
  status: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  country: string | null;
  preferred_locale: string | null;
  last_activity_at: string | null;
  risk_score_band: string | null;
  notes: string | null;
  created_at: string | null;
  archived_at: string | null;
  erased_at: string | null;
}

interface ContactRaw {
  member_number: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  role_title: string | null;
  preferred_language: string | null;
  is_primary: boolean;
  date_of_birth: string | null;
  created_at: string | null;
}

interface InvoiceRaw {
  member_number: number;
  document_number: string | null;
  receipt_number: string | null;
  invoice_subject: string;
  status: string;
  currency: string;
  subtotal_satang: string | null;
  vat_satang: string | null;
  total_satang: string | null;
  issue_date: string | null;
  due_date: string | null;
  paid_at: string | null;
  online_method: string | null;
}

async function tenantPrefix(tx: TenantTx): Promise<string> {
  const rows = (await tx.execute(sql`
    SELECT member_number_prefix FROM tenant_member_settings
     WHERE tenant_id = ${CURRENT_TENANT}
  `)) as unknown as Array<{ member_number_prefix: string }>;
  return rows[0]?.member_number_prefix ?? DEFAULT_MEMBER_NUMBER_PREFIX;
}

export const membersBackupSourceAdapter: MembersBackupSource = {
  async gatherInTx(txUnknown: unknown): Promise<MembersBackupData> {
    const tx = txUnknown as TenantTx;
    const prefix = await tenantPrefix(tx);
    const fmt = (n: number): string => formatMemberNumber(prefix, asMemberNumber(n));

    const memberRows = (await tx.execute(sql`
      SELECT m.member_number, m.company_name, m.legal_entity_type, m.tax_id,
             m.is_head_office, m.website, m.founded_year,
             (mp.plan_name->>'en') AS plan, m.plan_year,
             m.registration_fee_paid, m.status,
             m.address_line1, m.address_line2, m.city, m.province,
             m.postal_code, m.country, m.preferred_locale,
             to_char(m.last_activity_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS last_activity_at,
             m.risk_score_band, m.notes,
             to_char(m.created_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS created_at,
             to_char(m.archived_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS archived_at,
             to_char(m.erased_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS erased_at
        FROM members m
        LEFT JOIN membership_plans mp
          ON mp.tenant_id = m.tenant_id AND mp.plan_id = m.plan_id AND mp.plan_year = m.plan_year
       WHERE m.tenant_id = ${CURRENT_TENANT}
       ORDER BY m.member_number ASC
    `)) as unknown as MemberRaw[];

    const contactRows = (await tx.execute(sql`
      SELECT m.member_number, c.first_name, c.last_name, c.email, c.phone,
             c.role_title, c.preferred_language, c.is_primary,
             c.date_of_birth::text AS date_of_birth,
             to_char(c.created_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS created_at
        FROM contacts c
        JOIN members m ON m.tenant_id = c.tenant_id AND m.member_id = c.member_id
       WHERE c.removed_at IS NULL
         AND c.tenant_id = ${CURRENT_TENANT}
       ORDER BY m.member_number ASC, c.is_primary DESC, c.last_name ASC
    `)) as unknown as ContactRaw[];

    const invoiceRows = (await tx.execute(sql`
      SELECT m.member_number,
             COALESCE(i.bill_document_number_raw, i.document_number) AS document_number,
             i.receipt_document_number_raw AS receipt_number,
             i.invoice_subject, i.status, i.currency,
             i.subtotal_satang::text AS subtotal_satang,
             i.vat_satang::text      AS vat_satang,
             i.total_satang::text    AS total_satang,
             i.issue_date::text      AS issue_date,
             i.due_date::text        AS due_date,
             to_char(i.paid_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS paid_at,
             p.method AS online_method
        FROM invoices i
        JOIN members m ON m.tenant_id = i.tenant_id AND m.member_id = i.member_id
        LEFT JOIN LATERAL (
          SELECT method FROM payments p
           WHERE p.tenant_id = i.tenant_id AND p.invoice_id = i.invoice_id
             AND p.status = 'succeeded'
           ORDER BY p.created_at DESC LIMIT 1
        ) p ON true
       WHERE i.tenant_id = ${CURRENT_TENANT}
       ORDER BY m.member_number ASC, i.issue_date ASC NULLS LAST
    `)) as unknown as InvoiceRaw[];

    const membersOut: MemberBackupRow[] = memberRows.map((r) => ({
      memberNumber: fmt(r.member_number),
      companyName: r.company_name,
      legalEntityType: r.legal_entity_type,
      taxId: r.tax_id,
      isHeadOffice: r.is_head_office,
      website: r.website,
      foundedYear: r.founded_year,
      plan: r.plan,
      planYear: r.plan_year,
      registrationFeePaid: r.registration_fee_paid,
      status: r.status,
      addressLine1: r.address_line1,
      addressLine2: r.address_line2,
      city: r.city,
      province: r.province,
      postalCode: r.postal_code,
      country: r.country,
      preferredLocale: r.preferred_locale,
      lastActivityAt: r.last_activity_at,
      riskBand: r.risk_score_band,
      notes: r.notes,
      createdAt: r.created_at,
      archivedAt: r.archived_at,
      erasedAt: r.erased_at,
    }));

    const contactsOut: ContactBackupRow[] = contactRows.map((r) => ({
      memberNumber: fmt(r.member_number),
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.email,
      phone: r.phone,
      roleTitle: r.role_title,
      preferredLanguage: r.preferred_language,
      isPrimary: r.is_primary,
      dateOfBirth: r.date_of_birth,
      createdAt: r.created_at,
    }));

    const invoicesOut: InvoiceBackupRow[] = invoiceRows.map((r) => ({
      memberNumber: fmt(r.member_number),
      documentNumber: r.document_number,
      receiptNumber: r.receipt_number,
      invoiceSubject: r.invoice_subject,
      status: r.status,
      currency: r.currency,
      subtotalSatang: r.subtotal_satang,
      vatSatang: r.vat_satang,
      totalSatang: r.total_satang,
      issueDate: r.issue_date,
      dueDate: r.due_date,
      paidAt: r.paid_at,
      onlineMethod: r.online_method,
    }));

    return { members: membersOut, contacts: contactsOut, invoices: invoicesOut };
  },
};
