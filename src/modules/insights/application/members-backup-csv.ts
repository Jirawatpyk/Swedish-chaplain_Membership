/**
 * Members Backup Export — pure CSV rendering (design 2026-07-07).
 *
 * All three files: UTF-8 BOM prefix (Excel-TH opens without the import
 * wizard), CRLF line endings. User-controlled string cells (company names,
 * notes, contact names, etc.) go through `toCsvField` (RFC-4180 always-quote
 * + spreadsheet formula-injection defang); machine-generated satang→baht
 * money cells (invoices.csv subtotal/vat/total) go through `quoteNumeric`
 * instead — RFC-4180 quoting only, no defang, because the output shape is
 * always `-?\d+\.\d{2}` (no injection surface). Null/undefined → empty cell.
 * Timestamps are ISO 8601 UTC strings produced by the source adapter (BE is
 * display-only, never in data files).
 *
 * Application layer: pure string transforms, zero framework imports.
 */
import { toCsvField } from '@/lib/csv';
import type {
  ContactBackupRow,
  InvoiceBackupRow,
  MemberBackupRow,
} from './ports/members-backup-source';

const BOM = '﻿';

const MEMBERS_HEADERS = [
  'member_number', 'company_name', 'legal_entity_type', 'tax_id',
  'is_head_office', 'website', 'founded_year', 'plan', 'plan_year',
  'registration_fee_paid', 'status', 'address_line1', 'address_line2',
  'city', 'province', 'postal_code', 'country', 'preferred_locale',
  'last_activity_at', 'risk_band', 'notes', 'created_at', 'archived_at',
  'erased_at',
] as const;

const CONTACTS_HEADERS = [
  'member_number', 'first_name', 'last_name', 'email', 'phone',
  'role_title', 'preferred_language', 'is_primary', 'date_of_birth',
  'created_at',
] as const;

const INVOICES_HEADERS = [
  'member_number', 'document_number', 'receipt_number', 'invoice_subject',
  'status', 'currency', 'subtotal', 'vat', 'total', 'issue_date',
  'due_date', 'paid_at', 'payment_method',
] as const;

/** null/undefined → '', booleans → 'true'/'false', numbers stringified. */
function cell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return toCsvField('');
  return toCsvField(typeof v === 'string' ? v : String(v));
}

/** Quote a numeric string without formula-injection defang (numeric values are not user-controlled). */
function quoteNumeric(v: string | null): string {
  if (v === null || v === '') return toCsvField('');
  return `"${v.replace(/"/g, '""')}"`;
}

function render(headers: readonly string[], rows: readonly string[][]): string {
  const lines = [headers.map((h) => toCsvField(h)).join(',')];
  for (const r of rows) lines.push(r.join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

/**
 * Satang numeric string (PG bigint) → `"1234.56"` 2-dp baht string.
 * BigInt split (never float) — mirrors F4 `formatMoney`
 * (`export-paid-invoices-csv.ts`), duplicated here because that helper is
 * module-private to invoicing and this module must not deep-import it.
 */
export function satangToBaht(satang: string | null): string | null {
  if (satang === null || satang === '') return null;
  const n = BigInt(satang);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  return `${negative ? '-' : ''}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export function buildMembersCsv(rows: readonly MemberBackupRow[]): string {
  return render(
    MEMBERS_HEADERS,
    rows.map((m) => [
      cell(m.memberNumber), cell(m.companyName), cell(m.legalEntityType),
      cell(m.taxId), cell(m.isHeadOffice), cell(m.website),
      cell(m.foundedYear), cell(m.plan), cell(m.planYear),
      cell(m.registrationFeePaid), cell(m.status), cell(m.addressLine1),
      cell(m.addressLine2), cell(m.city), cell(m.province),
      cell(m.postalCode), cell(m.country), cell(m.preferredLocale),
      cell(m.lastActivityAt), cell(m.riskBand), cell(m.notes),
      cell(m.createdAt), cell(m.archivedAt), cell(m.erasedAt),
    ]),
  );
}

export function buildContactsCsv(rows: readonly ContactBackupRow[]): string {
  return render(
    CONTACTS_HEADERS,
    rows.map((c) => [
      cell(c.memberNumber), cell(c.firstName), cell(c.lastName),
      cell(c.email), cell(c.phone), cell(c.roleTitle),
      cell(c.preferredLanguage), cell(c.isPrimary), cell(c.dateOfBirth),
      cell(c.createdAt),
    ]),
  );
}

/**
 * `payment_method` derivation: a paid invoice with a succeeded F5 payment
 * shows that method ('card' | 'promptpay'); a paid invoice with no F5 row
 * was recorded in-band by staff → 'manual'; an unpaid/void/credited row
 * has no payment → ''.
 */
export function buildInvoicesCsv(rows: readonly InvoiceBackupRow[]): string {
  return render(
    INVOICES_HEADERS,
    rows.map((i) => {
      const method =
        i.status === 'paid' || i.paidAt !== null
          ? (i.onlineMethod ?? 'manual')
          : null;
      return [
        cell(i.memberNumber), cell(i.documentNumber), cell(i.receiptNumber),
        cell(i.invoiceSubject), cell(i.status), cell(i.currency),
        quoteNumeric(satangToBaht(i.subtotalSatang)), quoteNumeric(satangToBaht(i.vatSatang)),
        quoteNumeric(satangToBaht(i.totalSatang)), cell(i.issueDate),
        cell(i.dueDate), cell(i.paidAt), cell(method),
      ];
    }),
  );
}
