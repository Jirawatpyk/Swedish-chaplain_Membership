/**
 * Members Backup Export source port (design 2026-07-07).
 *
 * One method, one runInTenant tx: the adapter reads members (ALL statuses,
 * erased tombstones as stored), live contacts (`removed_at IS NULL`), and
 * every member-linked invoice — all RLS-scoped through the caller's `tx`.
 * `tx` is `unknown` here (Application stays ORM-free per Principle III);
 * the Drizzle adapter narrows it to `TenantTx`.
 *
 * Satang money fields stay raw numeric STRINGS (PG bigint over the wire) —
 * the CSV builder owns 2-dp baht formatting; nothing coerces through JS
 * floats.
 */

export interface MemberBackupRow {
  readonly memberNumber: string;          // formatted, e.g. 'SCCM-0042'
  readonly companyName: string;
  readonly legalEntityType: string | null;
  readonly taxId: string | null;
  readonly isHeadOffice: boolean;
  readonly website: string | null;
  readonly foundedYear: number | null;
  // 058 / PR-B — ทุนจดทะเบียน. A NEW field, NOT a rename of a turnover
  // column; this module has no turnoverThb column of its own to mirror.
  readonly registeredCapitalThb: number | null;
  readonly plan: string | null;           // plan display name (EN)
  readonly planYear: number;
  readonly registrationFeePaid: boolean;
  readonly status: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  // 058 / PR-B — แขวง/ตำบล. Sits between address_line2 and city, mirroring
  // the schema column order (schema-members.ts).
  readonly subDistrict: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly preferredLocale: string | null;
  readonly lastActivityAt: string | null; // ISO 8601 UTC
  readonly riskBand: string | null;
  readonly notes: string | null;
  readonly createdAt: string | null;      // ISO 8601 UTC
  readonly archivedAt: string | null;
  readonly erasedAt: string | null;
}

export interface ContactBackupRow {
  readonly memberNumber: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly roleTitle: string | null;
  readonly preferredLanguage: string | null;
  readonly isPrimary: boolean;
  readonly dateOfBirth: string | null;    // YYYY-MM-DD
  readonly createdAt: string | null;
}

export interface InvoiceBackupRow {
  readonly memberNumber: string;
  readonly documentNumber: string | null;   // bill-first (SC-… else legacy INV-…)
  readonly receiptNumber: string | null;    // §86/4 RC-…
  readonly invoiceSubject: string;          // 'membership' | 'event'
  readonly status: string;
  readonly currency: string;
  readonly subtotalSatang: string | null;   // numeric string from PG
  readonly vatSatang: string | null;
  readonly totalSatang: string | null;
  readonly issueDate: string | null;        // YYYY-MM-DD
  readonly dueDate: string | null;
  readonly paidAt: string | null;           // ISO 8601 UTC
  readonly onlineMethod: string | null;     // 'card' | 'promptpay' | null
}

export interface MembersBackupData {
  readonly members: readonly MemberBackupRow[];
  readonly contacts: readonly ContactBackupRow[];
  readonly invoices: readonly InvoiceBackupRow[];
}

export interface MembersBackupSource {
  /** All 3 datasets read through the SAME runInTenant tx (RLS-scoped). */
  gatherInTx(tx: unknown): Promise<MembersBackupData>;
}
