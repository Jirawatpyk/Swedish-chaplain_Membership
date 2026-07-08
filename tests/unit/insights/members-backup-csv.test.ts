/**
 * Members Backup Export — pure CSV builder tests (design 2026-07-07).
 * Pins: UTF-8 BOM, CRLF line endings, exact header rows, formula-injection
 * defang via toCsvField, null → empty cell, satang → 2-dp baht string,
 * payment_method derivation (paid+online → method, paid+no-F5 → 'manual',
 * unpaid → ''), and empty input → header-only file.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMembersCsv,
  buildContactsCsv,
  buildInvoicesCsv,
} from '@/modules/insights/application/members-backup-csv';
import type {
  MemberBackupRow,
  ContactBackupRow,
  InvoiceBackupRow,
} from '@/modules/insights/application/ports/members-backup-source';

const BOM = '﻿';

const member: MemberBackupRow = {
  memberNumber: 'SCCM-0001',
  companyName: '=HYPERLINK("evil") Co.',
  legalEntityType: 'co_ltd',
  taxId: '0105551234567',
  isHeadOffice: true,
  website: null,
  foundedYear: 1999,
  plan: 'Gold',
  planYear: 2026,
  registrationFeePaid: true,
  status: 'active',
  addressLine1: '1 Road, "Suite 2"',
  addressLine2: null,
  city: 'Bangkok',
  province: null,
  postalCode: '10110',
  country: 'TH',
  preferredLocale: 'th',
  lastActivityAt: '2026-07-01T03:00:00Z',
  riskBand: 'healthy',
  notes: 'line1\nline2',
  createdAt: '2026-01-01T00:00:00Z',
  archivedAt: null,
  erasedAt: null,
};

describe('buildMembersCsv', () => {
  it('starts with BOM + exact header row, CRLF endings', () => {
    const csv = buildMembersCsv([]);
    expect(csv.startsWith(BOM)).toBe(true);
    const firstLine = csv.slice(1).split('\r\n')[0];
    expect(firstLine).toBe(
      '"member_number","company_name","legal_entity_type","tax_id","is_head_office","website","founded_year","plan","plan_year","registration_fee_paid","status","address_line1","address_line2","city","province","postal_code","country","preferred_locale","last_activity_at","risk_band","notes","created_at","archived_at","erased_at"',
    );
    // header-only file still ends with one CRLF
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.slice(1).split('\r\n').filter((l) => l !== '')).toHaveLength(1);
  });

  it('defangs a leading formula trigger and escapes quotes/newlines', () => {
    const csv = buildMembersCsv([member]);
    // toCsvField prefixes ' before = and always double-quotes
    expect(csv).toContain('"\'=HYPERLINK(""evil"") Co."');
    // embedded quotes doubled, embedded \n survives inside the quoted cell
    expect(csv).toContain('"1 Road, ""Suite 2"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it('renders null as empty quoted cell and booleans as true/false', () => {
    const csv = buildMembersCsv([member]);
    const dataLine = csv.slice(1).split('\r\n')[1]!;
    expect(dataLine).toContain('""'); // website null
    expect(dataLine).toContain('"true"');
  });
});

describe('buildContactsCsv', () => {
  it('exact header row', () => {
    const firstLine = buildContactsCsv([]).slice(1).split('\r\n')[0];
    expect(firstLine).toBe(
      '"member_number","first_name","last_name","email","phone","role_title","preferred_language","is_primary","date_of_birth","created_at"',
    );
  });

  it('renders a row joined by member_number', () => {
    const row: ContactBackupRow = {
      memberNumber: 'SCCM-0001',
      firstName: 'Anna',
      lastName: 'Svensson',
      email: 'anna@abc.example',
      phone: '+66812345678',
      roleTitle: 'CEO',
      preferredLanguage: 'sv',
      isPrimary: true,
      dateOfBirth: null,
      createdAt: '2026-01-02T00:00:00Z',
    };
    const csv = buildContactsCsv([row]);
    expect(csv).toContain('"SCCM-0001","Anna","Svensson","anna@abc.example"');
  });
});

describe('buildInvoicesCsv', () => {
  const base: InvoiceBackupRow = {
    memberNumber: 'SCCM-0001',
    documentNumber: 'SC-2026-000022',
    receiptNumber: 'RC-2026-000010',
    invoiceSubject: 'membership',
    status: 'paid',
    currency: 'THB',
    subtotalSatang: '1200000',
    vatSatang: '84000',
    totalSatang: '1284000',
    issueDate: '2026-01-15',
    dueDate: '2026-02-15',
    paidAt: '2026-01-20T04:00:00Z',
    onlineMethod: null,
  };

  it('exact header row', () => {
    const firstLine = buildInvoicesCsv([]).slice(1).split('\r\n')[0];
    expect(firstLine).toBe(
      '"member_number","document_number","receipt_number","invoice_subject","status","currency","subtotal","vat","total","issue_date","due_date","paid_at","payment_method"',
    );
  });

  it('satang strings render as 2-dp baht', () => {
    const csv = buildInvoicesCsv([base]);
    expect(csv).toContain('"12000.00","840.00","12840.00"');
  });

  it('payment_method: paid + no F5 row → manual; paid + card → card; unpaid → empty', () => {
    const paidManual = buildInvoicesCsv([base]);
    expect(paidManual).toContain('"manual"');
    const paidCard = buildInvoicesCsv([{ ...base, onlineMethod: 'card' }]);
    expect(paidCard).toContain('"card"');
    const unpaid = buildInvoicesCsv([
      { ...base, status: 'issued', paidAt: null, onlineMethod: null },
    ]);
    const dataLine = unpaid.slice(1).split('\r\n')[1]!;
    expect(dataLine.endsWith('""')).toBe(true);
  });

  it('negative satang renders with sign', () => {
    const csv = buildInvoicesCsv([{ ...base, totalSatang: '-50' }]);
    expect(csv).toContain('"-0.50"');
  });
});
