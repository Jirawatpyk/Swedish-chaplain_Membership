# Members Backup Export (ZIP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-only one-click ZIP download (`members.csv` + `contacts.csv` + `invoices.csv`) of the whole tenant member base for backup/migration, per the approved spec `docs/superpowers/specs/2026-07-07-members-backup-export-design.md`.

**Architecture:** New sync use-case `exportMembersBackup` in the `insights` module (owner of all export surfaces). One `runInTenant` transaction gathers 3 datasets via a `MembersBackupSource` port (raw-SQL infrastructure adapter), pure CSV builders render UTF-8-BOM CSVs through `toCsvField` (formula-injection-safe), an fflate `zipSync` adapter packs the ZIP, and the audit event `members_backup_exported` commits atomically inside the same transaction. Route `GET /api/admin/members/export.zip` guards with `requireAdminContext({ resource: 'members:bulk', action: 'write' })` (admin-only per `policies.ts:132/139`). A client button on `/admin/members` downloads via fetch→blob with sonner toasts.

**Tech Stack:** Next.js 16 App Router route handler (Node runtime) · Drizzle raw SQL via `runInTenant` tx · `fflate` (existing dep) · `src/lib/csv.ts` `toCsvField` · next-intl EN/TH/SV · Vitest + live-Neon integration tests.

## Global Constraints

- Package manager is **pnpm** (never npm). Dev server runs on port 3100 and is owned by the user — NEVER start/kill it.
- TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Run `pnpm typecheck` as the FINAL gate after the LAST edit before each commit.
- TDD: write the failing test, run it RED, implement, run GREEN, commit. Conventional Commits enforced by hook.
- Commit with explicit file paths only — **never `git add -A`** (stray OneDrive zip + docs/uat PII risk).
- A commit that adds a migration + code referencing the new enum value must run `pnpm db:migrate` (dev Neon branch) + the relevant integration test BEFORE committing.
- Application layer: no drizzle/next/react imports. `runInTenant` from `@/lib/db` IS allowed in insights use-cases (precedent: `generate-directory-export.ts:19`). Inside `runInTenant`, every query uses the `tx` handle, never the global `db`.
- Timestamps in data files: ISO 8601 UTC (Gregorian). Buddhist Era is display-only — never in the CSV.
- All i18n keys must land in `en.json` + `th.json` + `sv.json` in the same commit (`pnpm check:i18n`).
- Run `git branch --show-current` before each commit batch (expected: `main` unless the user says otherwise).
- If a pre-push per-module integration gate fires and fails on a KNOWN shared-Neon flake (cross-tenant probe when suites run in parallel), re-run the failing file alone before assuming a real failure.

---

### Task 1: Audit event type `members_backup_exported` (migration + enum + taxonomy + parity)

**Files:**
- Create: `drizzle/migrations/0237_members_backup_exported_event.sql`
- Modify: `drizzle/migrations/meta/_journal.json` (append entry)
- Modify: `src/modules/auth/infrastructure/db/schema.ts` (~line 296, after `'member_timeline_viewed',`)
- Modify: `src/modules/insights/application/ports/audit-port.ts` (tuple + payload map + retention map)
- Modify: `scripts/check-audit-event-count.ts` (~line 67, `F9_MIGRATIONS` array)
- Modify: `src/lib/audit-event-label.ts` (~line 63, F9 category arm)
- Test: `tests/unit/insights/audit-event-category.test.ts`

**Interfaces:**
- Produces: F9 event type `'members_backup_exported'` usable in `F9AuditEvent` with payload `{ member_count: number; contact_count: number; invoice_count: number }`, retention 5y. Task 3's use-case emits it.

- [ ] **Step 1: Write the failing category test entry**

In `tests/unit/insights/audit-event-category.test.ts`, add one row to the existing `it.each` table (after the `['insights_cross_tenant_probe', 'dashboard'],` row at line 28):

```ts
    ['members_backup_exported', 'dashboard'],
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/insights/audit-event-category.test.ts`
Expected: FAIL — `members_backup_exported → dashboard` gets `'other'` (no F9 arm match; note `'members_backup_exported'.startsWith('member_')` is FALSE because char 6 is `s`, so it falls through to `'other'`).

- [ ] **Step 3: Implement — category arm, migration, journal, pgEnum, taxonomy, parity script**

3a. `src/lib/audit-event-label.ts` — in `auditEventCategory`, add one line to the F9 arm (after the `eventType === 'member_timeline_viewed' ||` line):

```ts
    eventType === 'members_backup_exported' ||
```

3b. Create `drizzle/migrations/0237_members_backup_exported_event.sql`:

```sql
-- Members Backup Export (docs/superpowers/specs/2026-07-07-members-backup-export-design.md)
-- — add the `members_backup_exported` audit event type. An admin downloading
-- the full-tenant backup ZIP (members.csv + contacts.csv + invoices.csv) is a
-- bulk PII egress and MUST be attributable (Constitution Principle I audit
-- sub-clause). 5-year retention (F9 default; no tax-document overlap — the
-- ZIP bundles existing invoice rows, it does not create tax records).
--
-- Postgres requires ADD VALUE to commit before the value is used; the emit
-- site (exportMembersBackup) ships in the same release but the enum value
-- must exist first.
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'members_backup_exported';--> statement-breakpoint
```

3c. `drizzle/migrations/meta/_journal.json` — append after the final entry (idx 239, tag `0234_invoices_vat_treatment_zero_rate`, when `1798536500000`):

```json
		{
			"idx": 240,
			"version": "7",
			"when": 1798536600000,
			"tag": "0237_members_backup_exported_event",
			"breakpoints": true
		}
```

(Comma after the previous entry; keep tab indentation identical to neighbours.)

3d. `src/modules/auth/infrastructure/db/schema.ts` — in the `audit_event_type` pgEnum values list, directly after the `'member_timeline_viewed',` line (~296):

```ts
  'members_backup_exported',
```

3e. `src/modules/insights/application/ports/audit-port.ts` — three lockstep edits:

In `F9_AUDIT_EVENT_TYPES` (after `'insights_cross_tenant_probe',`, before `] as const`):

```ts
  // Admin full-tenant backup ZIP (members+contacts+invoices CSVs) — bulk PII
  // egress, always audited (2026-07-07 members-backup-export design).
  'members_backup_exported',
```

In `F9AuditPayloadByType` (after the `insights_cross_tenant_probe` member):

```ts
  members_backup_exported: {
    readonly member_count: number;
    readonly contact_count: number;
    readonly invoice_count: number;
  };
```

In `F9_AUDIT_RETENTION_YEARS` (after `insights_cross_tenant_probe: 5,`):

```ts
  members_backup_exported: 5,
```

3f. `scripts/check-audit-event-count.ts` — append to `F9_MIGRATIONS` (~line 67):

```ts
  resolve(ROOT, 'drizzle/migrations/0237_members_backup_exported_event.sql'),
```

- [ ] **Step 4: Apply the migration to the dev Neon branch**

Run: `pnpm db:migrate`
Expected: applies `0237_members_backup_exported_event` with no error. (`.env.local` points at the `dev` Neon branch — safe.)

- [ ] **Step 5: Run verification**

Run: `pnpm vitest run tests/unit/insights/audit-event-category.test.ts` → PASS
Run: `pnpm check:audit-events` → `OK — F9 enum ↔ taxonomy parity: 16 event types match` (15 + 1 new)
Run: `pnpm typecheck` → clean

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # expect main
git add drizzle/migrations/0237_members_backup_exported_event.sql drizzle/migrations/meta/_journal.json src/modules/auth/infrastructure/db/schema.ts src/modules/insights/application/ports/audit-port.ts scripts/check-audit-event-count.ts src/lib/audit-event-label.ts tests/unit/insights/audit-event-category.test.ts
git commit -m "feat(insights): add members_backup_exported audit event type"
```

---

### Task 2: MembersBackupSource port + pure CSV builders

**Files:**
- Create: `src/modules/insights/application/ports/members-backup-source.ts`
- Create: `src/modules/insights/application/members-backup-csv.ts`
- Test: `tests/unit/insights/members-backup-csv.test.ts`

**Interfaces:**
- Consumes: `toCsvField` from `@/lib/csv` (existing: RFC-4180 always-quote + formula-injection defang).
- Produces (Task 3 + 4 rely on these exact names):

```ts
// ports/members-backup-source.ts
export interface MemberBackupRow {
  readonly memberNumber: string;          // formatted, e.g. 'SCCM-0042'
  readonly companyName: string;
  readonly legalEntityType: string | null;
  readonly taxId: string | null;
  readonly isHeadOffice: boolean;
  readonly website: string | null;
  readonly foundedYear: number | null;
  readonly plan: string | null;           // plan display name (EN)
  readonly planYear: number;
  readonly registrationFeePaid: boolean;
  readonly status: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
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
```

```ts
// members-backup-csv.ts
export function buildMembersCsv(rows: readonly MemberBackupRow[]): string;
export function buildContactsCsv(rows: readonly ContactBackupRow[]): string;
export function buildInvoicesCsv(rows: readonly InvoiceBackupRow[]): string;
```

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/insights/members-backup-csv.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/insights/members-backup-csv.test.ts`
Expected: FAIL — `Cannot find module '@/modules/insights/application/members-backup-csv'`

- [ ] **Step 3: Implement port + builders**

Create `src/modules/insights/application/ports/members-backup-source.ts` with EXACTLY the interfaces from the **Interfaces** block above, prefixed with:

```ts
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
```

Create `src/modules/insights/application/members-backup-csv.ts`:

```ts
/**
 * Members Backup Export — pure CSV rendering (design 2026-07-07).
 *
 * All three files: UTF-8 BOM prefix (Excel-TH opens without the import
 * wizard), CRLF line endings, EVERY cell through `toCsvField` (RFC-4180
 * always-quote + spreadsheet formula-injection defang — company names and
 * notes are user-controlled). Null/undefined → empty cell. Timestamps are
 * ISO 8601 UTC strings produced by the source adapter (BE is display-only,
 * never in data files).
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
        cell(satangToBaht(i.subtotalSatang)), cell(satangToBaht(i.vatSatang)),
        cell(satangToBaht(i.totalSatang)), cell(i.issueDate),
        cell(i.dueDate), cell(i.paidAt), cell(method),
      ];
    }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/insights/members-backup-csv.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/modules/insights/application/ports/members-backup-source.ts src/modules/insights/application/members-backup-csv.ts tests/unit/insights/members-backup-csv.test.ts
git commit -m "feat(insights): members-backup source port + pure CSV builders"
```

---

### Task 3: `exportMembersBackup` use-case

**Files:**
- Create: `src/modules/insights/application/use-cases/export-members-backup.ts`
- Test: `tests/unit/insights/export-members-backup.test.ts`

**Interfaces:**
- Consumes: `MembersBackupSource` + row types (Task 2), `buildMembersCsv`/`buildContactsCsv`/`buildInvoicesCsv` (Task 2), `InsightsAuditPort` + `f9RetentionFor` (Task 1), `ClockPort` (existing `../ports/clock-port`), `runInTenant` from `@/lib/db`, `TenantContext` from `@/modules/tenants`.
- Produces (Task 4 wires deps; Task 5 route calls):

```ts
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
  readonly filename: string; // `${slug}-members-backup-YYYYMMDD-HHmm.zip` (Bangkok)
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
): Promise<Result<ExportMembersBackupOutput, ExportMembersBackupError>>;
```

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/insights/export-members-backup.test.ts`:

```ts
/**
 * `exportMembersBackup` use-case unit tests (design 2026-07-07).
 * Pins: admin-only gate (manager AND member → forbidden, no source touch),
 * ZIP receives exactly 3 named CSV files, audit recordInTx commits inside
 * the same tx with per-file counts, Bangkok-local filename stamp, and the
 * throw path (source throws → 'gather_failed', no audit emit).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ __fakeTx: true }),
  ),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { exportMembersBackup } from '@/modules/insights/application/use-cases/export-members-backup';
import type { MembersBackupData } from '@/modules/insights/application/ports/members-backup-source';
import type { TenantContext } from '@/modules/tenants';

const ctx = { slug: 'test-swecham' } as unknown as TenantContext;

const data: MembersBackupData = {
  members: [
    {
      memberNumber: 'SCCM-0001', companyName: 'ABC Co.', legalEntityType: null,
      taxId: null, isHeadOffice: true, website: null, foundedYear: null,
      plan: 'Gold', planYear: 2026, registrationFeePaid: true, status: 'active',
      addressLine1: null, addressLine2: null, city: null, province: null,
      postalCode: null, country: 'TH', preferredLocale: null,
      lastActivityAt: null, riskBand: null, notes: null,
      createdAt: '2026-01-01T00:00:00Z', archivedAt: null, erasedAt: null,
    },
  ],
  contacts: [
    {
      memberNumber: 'SCCM-0001', firstName: 'Anna', lastName: 'S',
      email: 'a@x.example', phone: null, roleTitle: null,
      preferredLanguage: null, isPrimary: true, dateOfBirth: null,
      createdAt: null,
    },
  ],
  invoices: [],
};

function makeDeps() {
  return {
    source: { gatherInTx: vi.fn().mockResolvedValue(data) },
    audit: { recordInTx: vi.fn().mockResolvedValue(undefined), record: vi.fn() },
    zip: vi.fn().mockReturnValue(new Uint8Array([80, 75])),
    clock: { now: () => new Date('2026-07-07T10:30:00Z') }, // BKK 17:30
  };
}

const meta = {
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  requestId: 'req-1',
};

describe('exportMembersBackup', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['manager', 'member'] as const)('%s → forbidden, source never touched', async (role) => {
    const deps = makeDeps();
    const res = await exportMembersBackup({ ...meta, actorRole: role }, ctx, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('forbidden');
    expect(deps.source.gatherInTx).not.toHaveBeenCalled();
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('admin: zips 3 named CSVs, audits counts in-tx, Bangkok filename', async () => {
    const deps = makeDeps();
    const res = await exportMembersBackup(meta, ctx, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(deps.zip).toHaveBeenCalledTimes(1);
    const files = deps.zip.mock.calls[0]![0] as ReadonlyArray<{ name: string; content: string }>;
    expect(files.map((f) => f.name)).toEqual(['members.csv', 'contacts.csv', 'invoices.csv']);
    expect(files[0]!.content.startsWith('﻿')).toBe(true);

    expect(deps.audit.recordInTx).toHaveBeenCalledWith(
      { __fakeTx: true },
      expect.objectContaining({
        eventType: 'members_backup_exported',
        actorUserId: 'admin-1',
        retentionYears: 5,
        payload: { member_count: 1, contact_count: 1, invoice_count: 0 },
      }),
    );

    // 2026-07-07T10:30Z = 17:30 Bangkok
    expect(res.value.filename).toBe('test-swecham-members-backup-20260707-1730.zip');
    expect(res.value.rowCounts).toEqual({ members: 1, contacts: 1, invoices: 0 });
  });

  it('source throws → gather_failed, no audit emit', async () => {
    const deps = makeDeps();
    deps.source.gatherInTx.mockRejectedValueOnce(new Error('neon transient'));
    const res = await exportMembersBackup(meta, ctx, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('gather_failed');
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
    expect(deps.zip).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/insights/export-members-backup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the use-case**

Create `src/modules/insights/application/use-cases/export-members-backup.ts`:

```ts
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
      { tenantSlug: ctx.slug, requestId: meta.requestId, err: e instanceof Error ? e.message : String(e) },
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
```

(`ClockPort` is confirmed as `{ now(): Date }` in `src/modules/insights/application/ports/clock-port.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/insights/export-members-backup.test.ts`
Expected: PASS. Then `pnpm typecheck` → clean (payload type from Task 1 must line up).

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/modules/insights/application/use-cases/export-members-backup.ts tests/unit/insights/export-members-backup.test.ts
git commit -m "feat(insights): exportMembersBackup use-case (admin-only, atomic audit)"
```

---

### Task 4: Infrastructure — SQL source adapter, fflate zip adapter, deps factory, barrel + integration test

**Files:**
- Create: `src/modules/insights/infrastructure/sources/members-backup-source-adapter.ts`
- Create: `src/modules/insights/infrastructure/zip/csv-zip-adapter.ts`
- Modify: `src/modules/insights/infrastructure/insights-deps.ts` (add factory)
- Modify: `src/modules/insights/index.ts` (barrel exports)
- Test: `tests/integration/insights/export-members-backup.test.ts`

**Interfaces:**
- Consumes: `MembersBackupSource` (Task 2), `exportMembersBackup` + `ExportMembersBackupDeps` (Task 3), `runInTenant`/`TenantTx` from `@/lib/db`, `formatMemberNumber` + `asMemberNumber` + `DEFAULT_MEMBER_NUMBER_PREFIX` from `@/modules/members` (public barrel; verify they are exported — if not, add them to the members barrel in this task), `zipSync`/`strToU8` from `fflate`, `insightsAuditAdapter`, `systemClock`.
- Produces: `membersBackupSourceAdapter: MembersBackupSource`; `zipCsvFiles: ZipFilesPort`; `makeExportMembersBackupDeps(): ExportMembersBackupDeps`; barrel exports `exportMembersBackup`, `makeExportMembersBackupDeps` (Task 5 route imports BOTH from `@/modules/insights`).

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/insights/export-members-backup.test.ts` (mirrors `directory-cross-tenant.test.ts` helpers):

```ts
/**
 * Members Backup Export — live-Neon integration (design 2026-07-07).
 *
 * Proves against real Postgres+RLS:
 *   1. gather returns the seeded member (ALL statuses incl. archived),
 *      live contact, and member-linked invoice with correct joins
 *      (member_number formatting, plan name, satang strings).
 *   2. soft-removed contacts are EXCLUDED.
 *   3. CROSS-TENANT (Principle I Review-Gate blocker): tenant B's rows
 *      never appear in tenant A's backup.
 *   4. the `members_backup_exported` audit row commits with row counts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  exportMembersBackup,
  makeExportMembersBackupDeps,
} from '@/modules/insights';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('exportMembersBackup — live Neon', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const memberA = randomUUID();
  const memberB = randomUUID();
  const invoiceA = randomUUID();
  let memberANumber: number;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    memberANumber = nextSeedMemberNumber();

    for (const [t, mid, num, name] of [
      [tenantA, memberA, memberANumber, 'Backup Acme A'],
      [tenantB, memberB, nextSeedMemberNumber(), 'Backup Beta B'],
    ] as const) {
      const planId = `bk-${randomUUID().slice(0, 8)}`;
      await runInTenant(t.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: t.ctx.slug,
          planId,
          planName: { en: 'Backup Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: admin.userId,
        });
        await tx.insert(members).values({
          tenantId: t.ctx.slug,
          memberId: mid,
          memberNumber: num,
          companyName: name,
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
          riskScore: null,
          riskScoreBand: null,
        });
        await tx.insert(contacts).values({
          tenantId: t.ctx.slug,
          contactId: randomUUID(),
          memberId: mid,
          firstName: 'Live',
          lastName: 'Contact',
          email: `bk-live-${mid.slice(0, 8)}@example.com`,
          isPrimary: true,
        });
        // soft-removed contact — must be EXCLUDED from the backup
        await tx.insert(contacts).values({
          tenantId: t.ctx.slug,
          contactId: randomUUID(),
          memberId: mid,
          firstName: 'Removed',
          lastName: 'Contact',
          email: `bk-gone-${mid.slice(0, 8)}@example.com`,
          isPrimary: false,
          removedAt: new Date(),
        });
        if (t === tenantA) {
          await tx.insert(invoices).values({
            tenantId: t.ctx.slug,
            invoiceId: invoiceA,
            memberId: mid,
            planId,
            planYear: 2026,
            invoiceSubject: 'membership',
            status: 'paid',
            documentNumber: `INV-BK-${mid.slice(0, 6)}`,
            issueDate: '2026-01-15',
            subtotalSatang: 1200000n,
            vatSatang: 84000n,
            totalSatang: 1284000n,
            paidAt: new Date('2026-01-20T04:00:00Z'),
          });
        }
      });
    }
  }, 180_000);

  afterAll(async () => {
    await db.delete(invoices).where(eq(invoices.tenantId, tenantA.ctx.slug)).catch(() => {});
    for (const t of [tenantA, tenantB]) await t.cleanup().catch(() => {});
  }, 120_000);

  it('gathers members + live contacts + member-linked invoices; excludes removed contacts and tenant B', async () => {
    const res = await exportMembersBackup(
      { actorUserId: admin.userId, actorRole: 'admin', requestId: `req-${randomUUID().slice(0, 8)}` },
      tenantA.ctx,
      makeExportMembersBackupDeps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.zip.length).toBeGreaterThan(0);
    expect(res.value.rowCounts.members).toBeGreaterThanOrEqual(1);
    expect(res.value.rowCounts.invoices).toBeGreaterThanOrEqual(1);
    expect(res.value.filename).toMatch(
      new RegExp(`^${tenantA.ctx.slug}-members-backup-\\d{8}-\\d{4}\\.zip$`),
    );

    // Assert on the CSVs via a direct gather (same adapter the deps use)
    const { membersBackupSourceAdapter } = await import(
      '@/modules/insights/infrastructure/sources/members-backup-source-adapter'
    );
    const data = await runInTenant(tenantA.ctx, (tx) =>
      membersBackupSourceAdapter.gatherInTx(tx),
    );
    const companies = data.members.map((m) => m.companyName);
    expect(companies).toContain('Backup Acme A');
    expect(companies).not.toContain('Backup Beta B');

    const seeded = data.members.find((m) => m.companyName === 'Backup Acme A')!;
    expect(seeded.memberNumber).toMatch(/^[A-Z][A-Z0-9]*-\d{4,}$/); // prefix + padded
    expect(seeded.plan).toBe('Backup Plan');
    expect(seeded.status).toBe('active');

    const contactEmails = data.contacts.map((c) => c.email);
    expect(contactEmails.some((e) => e.startsWith('bk-live-'))).toBe(true);
    expect(contactEmails.some((e) => e.startsWith('bk-gone-'))).toBe(false);

    const inv = data.invoices.find((i) => i.documentNumber === `INV-BK-${memberA.slice(0, 6)}`)!;
    expect(inv).toBeDefined();
    expect(inv.memberNumber).toBe(seeded.memberNumber);
    expect(inv.status).toBe('paid');
    expect(inv.totalSatang).toBe('1284000');
    expect(inv.onlineMethod).toBeNull(); // no F5 row → builder renders 'manual'
  });

  it('writes the members_backup_exported audit row with counts', async () => {
    const requestId = `req-audit-${randomUUID().slice(0, 8)}`;
    const res = await exportMembersBackup(
      { actorUserId: admin.userId, actorRole: 'admin', requestId },
      tenantA.ctx,
      makeExportMembersBackupDeps(),
    );
    expect(res.ok).toBe(true);

    const rows = (await db.execute(sql`
      SELECT event_type, payload, retention_years
        FROM audit_log
       WHERE tenant_id = ${tenantA.ctx.slug}
         AND event_type = 'members_backup_exported'
         AND request_id = ${requestId}
    `)) as unknown as Array<{ event_type: string; payload: Record<string, unknown>; retention_years: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.retention_years).toBe(5);
    expect(Number(rows[0]!.payload['member_count'])).toBeGreaterThanOrEqual(1);
  });

  it('CROSS-TENANT: tenant B backup never contains tenant A rows', async () => {
    const { membersBackupSourceAdapter } = await import(
      '@/modules/insights/infrastructure/sources/members-backup-source-adapter'
    );
    const dataB = await runInTenant(tenantB.ctx, (tx) =>
      membersBackupSourceAdapter.gatherInTx(tx),
    );
    expect(dataB.members.map((m) => m.companyName)).not.toContain('Backup Acme A');
    expect(dataB.invoices).toHaveLength(0);
    expect(dataB.contacts.every((c) => !c.email.includes(memberA.slice(0, 8)))).toBe(true);
  });
});
```

Helper imports mirror `tests/integration/insights/directory-cross-tenant.test.ts` (same directory, verified). The `audit_log` columns used (`tenant_id`, `event_type`, `request_id`, `payload`, `retention_years`) are CONFIRMED against `tests/integration/members/erase-route-attestation.test.ts:160-165`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config vitest.integration.config.ts tests/integration/insights/export-members-backup.test.ts`
Expected: FAIL — `makeExportMembersBackupDeps` not exported from `@/modules/insights`.

- [ ] **Step 3: Implement adapters + deps + barrel**

3a. Create `src/modules/insights/infrastructure/zip/csv-zip-adapter.ts`:

```ts
/**
 * Members Backup Export — in-memory ZIP packer (design 2026-07-07).
 *
 * Binds the use-case's `ZipFilesPort` to fflate `zipSync` (existing dep,
 * same engine as the F9 GDPR archive). CSVs compress well → level 6.
 * No fixed mtime: unlike the GDPR archive there is no byte-determinism
 * requirement (SC-008) on this artefact.
 */
import { strToU8, zipSync } from 'fflate';
import type { ZipFilesPort } from '../../application/use-cases/export-members-backup';

export const zipCsvFiles: ZipFilesPort = (files) => {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.name] = strToU8(f.content);
  return zipSync(entries, { level: 6 });
};
```

3b. Create `src/modules/insights/infrastructure/sources/members-backup-source-adapter.ts`:

```ts
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
 * DEFAULT_MEMBER_NUMBER_PREFIX). Timestamps → ISO 8601 UTC via to_char;
 * satang bigints stay TEXT strings end-to-end (no float coercion).
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
     WHERE tenant_id = current_setting('app.current_tenant')
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
           WHERE p.tenant_id = i.tenant_id AND p.invoice_id = i.invoice_id::text
             AND p.status = 'succeeded'
           ORDER BY p.created_at DESC LIMIT 1
        ) p ON true
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
```

Implementation notes for the engineer:
- Tenant scoping comes from RLS (`SET LOCAL app.current_tenant` inside `runInTenant`) — the queries deliberately carry NO `tenant_id = …` literal except via `current_setting` for the settings read; RLS filters every table. If the repo pattern in this codebase also adds explicit `tenant_id` predicates (check `drizzle-directory-repo.ts` — it passes `${tenantId}` explicitly), prefer matching that belt-and-braces style: make the adapter a factory `makeMembersBackupSourceAdapter(tenantId: string)` mirroring `makeDrizzleDirectoryRepo`, and add `WHERE m.tenant_id = ${tenantId}` etc. to every query. **Follow the existing style; explicit tenant filter + RLS is the house pattern.**
- `p.invoice_id = i.invoice_id::text` — payments.invoice_id is uuid at DB but text in Drizzle; in raw SQL both sides are uuid, so plain `p.invoice_id = i.invoice_id` is correct — drop the cast if the DB column is uuid (verify with the payments migration under `drizzle/migrations/0033–0050`).
- `formatMemberNumber`, `asMemberNumber`, `DEFAULT_MEMBER_NUMBER_PREFIX` are CONFIRMED exported from the members barrel (`src/modules/members/index.ts:92-96`) — import them exactly as written.

3c. `src/modules/insights/infrastructure/insights-deps.ts` — add imports + factory:

```ts
import { membersBackupSourceAdapter } from './sources/members-backup-source-adapter';
import { zipCsvFiles } from './zip/csv-zip-adapter';
import type { ExportMembersBackupDeps } from '../application/use-cases/export-members-backup';
```

and (near the other `make*Deps` factories):

```ts
/** Members Backup Export (design 2026-07-07) — dependency bundle. */
export function makeExportMembersBackupDeps(): ExportMembersBackupDeps {
  return {
    source: membersBackupSourceAdapter,
    audit: insightsAuditAdapter,
    zip: zipCsvFiles,
    clock: systemClock,
  };
}
```

3d. `src/modules/insights/index.ts` — add barrel exports (near the directory-export exports at ~line 190):

```ts
export {
  exportMembersBackup,
  type ExportMembersBackupDeps,
  type ExportMembersBackupError,
  type ExportMembersBackupMeta,
  type ExportMembersBackupOutput,
} from './application/use-cases/export-members-backup';
export { makeExportMembersBackupDeps } from './infrastructure/insights-deps';
```

(If the barrel already re-exports `makeGenerateDirectoryExportDeps` from `insights-deps`, put `makeExportMembersBackupDeps` in that same export block.)

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `pnpm vitest run --config vitest.integration.config.ts tests/integration/insights/export-members-backup.test.ts`
Expected: PASS (3 tests). If a cross-tenant probe fails while other suites run concurrently, re-run this file alone before debugging.

- [ ] **Step 5: Typecheck + unit suites still green**

Run: `pnpm typecheck && pnpm vitest run tests/unit/insights/`
Expected: clean + PASS.

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add src/modules/insights/infrastructure/sources/members-backup-source-adapter.ts src/modules/insights/infrastructure/zip/csv-zip-adapter.ts src/modules/insights/infrastructure/insights-deps.ts src/modules/insights/index.ts tests/integration/insights/export-members-backup.test.ts
git commit -m "feat(insights): members-backup SQL source + fflate zip adapter + deps wiring"
```

(If the members barrel needed the value-object exports, include `src/modules/members/index.ts` in the same commit.)

---

### Task 5: Route `GET /api/admin/members/export.zip`

**Files:**
- Create: `src/app/api/admin/members/export.zip/route.ts`
- Test: `tests/contract/admin-members-backup-export-route.test.ts`

**Interfaces:**
- Consumes: `exportMembersBackup` + `makeExportMembersBackupDeps` from `@/modules/insights` (Task 4 barrel), `requireAdminContext` from `@/lib/admin-context`, `resolveTenantFromRequest` from `@/lib/tenant-context`, `requestIdFromHeaders` from `@/lib/request-id`, `buildAttachmentContentDisposition` from `@/lib/content-disposition`.
- Produces: `GET /api/admin/members/export.zip` → 200 `application/zip` for admin; guard rejection forwarded for others; `forbidden` → 404; `gather_failed` → 500.

- [ ] **Step 1: Write the failing contract test**

Create `tests/contract/admin-members-backup-export-route.test.ts` (mirrors `admin-invoices-csv-export-route.test.ts`):

```ts
/**
 * Contract test — GET /api/admin/members/export.zip (design 2026-07-07).
 * Pins the route's wire-level concerns: RBAC guard forwarding, admin-only
 * policy args ('members:bulk' + 'write'), success headers (zip content-type,
 * attachment disposition, no-store, per-file row-count headers), forbidden →
 * 404 cloak, gather_failed → 500.
 *
 * Mock policy: vi.mock at the auth/infra/use-case seams only — the route's
 * own code (header construction, error mapping) runs unmodified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const requireAdminContextMock = vi.fn();
const exportMembersBackupMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-backup-1',
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/insights', () => ({
  exportMembersBackup: (...args: unknown[]) => exportMembersBackupMock(...args),
  makeExportMembersBackupDeps: () => ({}),
}));

const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'admin@swecham.test', role: 'admin', status: 'active', displayName: 'Admin' },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-backup-1',
};

async function callRoute(): Promise<Response> {
  const { GET } = await import('@/app/api/admin/members/export.zip/route');
  return GET(new NextRequest('http://localhost:3100/api/admin/members/export.zip', { method: 'GET' }));
}

describe('GET /api/admin/members/export.zip — route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminContextMock.mockResolvedValue(adminContext);
    exportMembersBackupMock.mockResolvedValue({
      ok: true,
      value: {
        zip: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        filename: 'test-swecham-members-backup-20260707-1730.zip',
        rowCounts: { members: 2, contacts: 3, invoices: 4 },
      },
    });
  });
  afterEach(() => vi.resetModules());

  it('guard rejection is forwarded verbatim (guard called with members:bulk/write)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    });
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(requireAdminContextMock).toHaveBeenCalledWith(
      expect.anything(),
      { resource: 'members:bulk', action: 'write' },
    );
    expect(exportMembersBackupMock).not.toHaveBeenCalled();
  });

  it('admin happy path → 200 zip with attachment headers + row counts', async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Disposition')).toContain(
      'test-swecham-members-backup-20260707-1730.zip',
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('X-Members-Count')).toBe('2');
    expect(res.headers.get('X-Contacts-Count')).toBe('3');
    expect(res.headers.get('X-Invoices-Count')).toBe('4');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]); // 'PK\x03\x04'
  });

  it("use-case 'forbidden' → 404 cloak", async () => {
    exportMembersBackupMock.mockResolvedValueOnce({ ok: false, error: 'forbidden' });
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it("use-case 'gather_failed' → 500 server_error", async () => {
    exportMembersBackupMock.mockResolvedValueOnce({ ok: false, error: 'gather_failed' });
    const res = await callRoute();
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('server_error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/contract/admin-members-backup-export-route.test.ts`
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement the route**

Create `src/app/api/admin/members/export.zip/route.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/contract/admin-members-backup-export-route.test.ts`
Expected: PASS (4 tests). Then `pnpm typecheck` → clean.

Note (Turbopack dev): a brand-new route file may 404 on the user's running dev server until it re-registers — do NOT restart their server; the contract test is the verification here.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/app/api/admin/members/export.zip/route.ts tests/contract/admin-members-backup-export-route.test.ts
git commit -m "feat(members): admin backup export.zip route (admin-only, cloaked)"
```

---

### Task 6: UI button on /admin/members + i18n (EN/TH/SV)

**Files:**
- Create: `src/app/(staff)/admin/members/_components/export-backup-button.tsx`
- Modify: `src/app/(staff)/admin/members/page.tsx` (~line 158, `actions` block)
- Modify: `src/i18n/messages/en.json`, `src/i18n/messages/th.json`, `src/i18n/messages/sv.json` (inside the existing `admin.members` object)
- Test: `tests/unit/components/export-backup-button.test.tsx`

**Interfaces:**
- Consumes: route from Task 5, `admin.members` i18n namespace, `buttonVariants` from `@/components/ui/button`, `toast` from `sonner`, `DownloadIcon` from `lucide-react`.
- Produces: `<ExportBackupButton />` client component rendered admin-only next to the New-member button.

- [ ] **Step 1: Add i18n keys (all 3 locales in one edit)**

In `src/i18n/messages/en.json`, inside the `admin.members` object (same level as `addMember`):

```json
"exportBackup": "Export backup",
"exportBackupSuccess": "Backup downloaded — {members} members, {contacts} contacts, {invoices} invoices",
"exportBackupError": "Backup export failed. Please try again."
```

In `th.json` (same position):

```json
"exportBackup": "ส่งออกข้อมูลสำรอง",
"exportBackupSuccess": "ดาวน์โหลดข้อมูลสำรองแล้ว — สมาชิก {members} ราย ผู้ติดต่อ {contacts} คน ใบแจ้งหนี้ {invoices} ใบ",
"exportBackupError": "ส่งออกข้อมูลสำรองไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"
```

In `sv.json` (same position):

```json
"exportBackup": "Exportera säkerhetskopia",
"exportBackupSuccess": "Säkerhetskopia hämtad — {members} medlemmar, {contacts} kontakter, {invoices} fakturor",
"exportBackupError": "Exporten misslyckades. Försök igen."
```

Run: `pnpm check:i18n` → PASS.

- [ ] **Step 2: Write the failing component test**

Create `tests/unit/components/export-backup-button.test.tsx` (follow the house pattern: real `en.json` messages + `NextIntlClientProvider`; check a neighbouring component test under `tests/unit/components/` for the exact provider setup and mirror it):

```tsx
/**
 * <ExportBackupButton /> — fetch→blob download with sonner toasts
 * (design 2026-07-07). Pins: fetch hits the route, success toast carries
 * row counts from X-*-Count headers, error toast on non-OK, button
 * disabled while in flight.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en.json';
import { ExportBackupButton } from '@/app/(staff)/admin/members/_components/export-backup-button';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

function renderButton() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ExportBackupButton />
    </NextIntlClientProvider>,
  );
}

describe('<ExportBackupButton />', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    // jsdom lacks these; the component calls them on success
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:x'),
      revokeObjectURL: vi.fn(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('downloads and shows the success toast with counts', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(new Blob([new Uint8Array([0x50, 0x4b])]), {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="t-members-backup-20260707-1730.zip"',
          'X-Members-Count': '2',
          'X-Contacts-Count': '3',
          'X-Invoices-Count': '4',
        },
      }),
    );
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith('/api/admin/members/export.zip');
    expect(String(toastSuccess.mock.calls[0]![0])).toContain('2 members');
  });

  it('shows the error toast on non-OK response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{}', { status: 500 }),
    );
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});
```

Run: `pnpm vitest run tests/unit/components/export-backup-button.test.tsx`
Expected: FAIL — component module not found.

- [ ] **Step 3: Implement the component + wire into the page**

Create `src/app/(staff)/admin/members/_components/export-backup-button.tsx`:

```tsx
/**
 * Members Backup Export button (design 2026-07-07). Admin-only (the page
 * renders it only for role==='admin'; the route enforces regardless).
 * fetch→blob→anchor download so failures surface as a sonner toast instead
 * of navigating the admin to a bare JSON error page. Row counts for the
 * success toast come from the route's X-*-Count headers.
 */
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { DownloadIcon, Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { buttonVariants } from '@/components/ui/button';

const FILENAME_FALLBACK = 'members-backup.zip';

function filenameFromDisposition(header: string | null): string {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? FILENAME_FALLBACK;
}

export function ExportBackupButton() {
  const t = useTranslations('admin.members');
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/members/export.zip');
      if (!res.ok) {
        toast.error(t('exportBackupError'));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filenameFromDisposition(res.headers.get('Content-Disposition'));
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(
        t('exportBackupSuccess', {
          members: res.headers.get('X-Members-Count') ?? '0',
          contacts: res.headers.get('X-Contacts-Count') ?? '0',
          invoices: res.headers.get('X-Invoices-Count') ?? '0',
        }),
      );
    } catch {
      toast.error(t('exportBackupError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className={buttonVariants({ variant: 'outline' })}
    >
      {busy ? (
        <Loader2Icon className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <DownloadIcon className="h-3.5 w-3.5" aria-hidden />
      )}
      {t('exportBackup')}
    </button>
  );
}
```

Modify `src/app/(staff)/admin/members/page.tsx` — replace the `actions` block (lines 158–168) with:

```tsx
        actions={
          currentUser.role === 'admin' ? (
            <div className="flex items-center gap-2">
              <ExportBackupButton />
              <Link
                href="/admin/members/new"
                className={buttonVariants()}
              >
                <PlusIcon className="h-3.5 w-3.5" />
                {t('addMember')}
              </Link>
            </div>
          ) : null
        }
```

and add the import next to the other `_components` imports:

```tsx
import { ExportBackupButton } from './_components/export-backup-button';
```

- [ ] **Step 4: Run tests to verify green**

Run: `pnpm vitest run tests/unit/components/export-backup-button.test.tsx` → PASS
Run: `pnpm check:i18n` → PASS
Run: `pnpm typecheck` → clean

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/app/\(staff\)/admin/members/_components/export-backup-button.tsx "src/app/(staff)/admin/members/page.tsx" src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json tests/unit/components/export-backup-button.test.tsx
git commit -m "feat(members): backup export button on /admin/members (EN/TH/SV)"
```

---

### Task 7: Full gates + browser verification

**Files:** none (verification only; fix-forward anything that fails)

- [ ] **Step 1: Run the full local gate set**

```bash
pnpm lint
pnpm typecheck
pnpm vitest run tests/unit/insights/ tests/contract/admin-members-backup-export-route.test.ts tests/unit/components/export-backup-button.test.tsx
pnpm check:i18n
pnpm check:audit-events
pnpm check:layout
pnpm vitest run --config vitest.integration.config.ts tests/integration/insights/export-members-backup.test.ts
```

Expected: every command exits 0. `pnpm lint` is mandatory here — typecheck+vitest miss lint-only rules (e.g. react-hooks). If `pnpm typecheck` behaves oddly while the user's dev server runs, use the repo's `tsconfig.tsccheck.json` temp-config approach instead of trusting `.next/dev` types.

- [ ] **Step 2: Verify in the real app (user's dev server on :3100)**

With the user's dev server already running (never start/kill it yourself): sign in as admin (`E2E_ADMIN_*` creds in `.env.local`), open `http://localhost:3100/admin/members`, click **Export backup**, confirm the ZIP downloads, open it, and check the 3 CSVs open in a spreadsheet with Thai text intact (BOM). If the new route 404s on the running dev server (Turbopack dynamic-route registration), `touch` the route file to re-register — do NOT delete `.next/dev` artifacts and do NOT restart the server.

- [ ] **Step 3: Report**

State precisely what passed/failed (X/Y gates, which browser steps were exercised). No "done" claims without command output. Remaining ship steps (push, PR/review per solo-maintainer flow, prod migration ride-along on next deploy via `vercel-build`) are the maintainer's call.

---

## Self-Review Notes (already applied)

- **Spec coverage:** every spec section maps to a task — decisions table → Tasks 3/5 (roles, sync), ZIP contents → Tasks 2/4 (columns from live schema), security/audit → Tasks 1/3/5, UI → Task 6, error handling → Tasks 3/5 (+ empty-tenant covered by header-only builders in Task 2 tests), testing → Tasks 2–6, out-of-scope untouched.
- **Type consistency:** row/port/deps names are defined once in Task 2/3 Interfaces blocks and repeated verbatim in Tasks 4–5.
- **Pre-verified during planning:** `ClockPort` = `{ now(): Date }`; member-number helpers exported from the members barrel (`index.ts:92-96`); `audit_log` column names match `erase-route-attestation.test.ts`; component tests under `tests/unit/components/members/` provide the provider pattern (e.g. `resend-verification-button.test.tsx`).
- **Remaining verify-points for the implementing engineer** (flagged inline): explicit-`tenant_id`-predicate house style in the source adapter + payments `invoice_id` cast (Task 4).
