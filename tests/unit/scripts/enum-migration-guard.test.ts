import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALTER_TYPE_ADD_VALUE_RE,
  extractAlterTypeAddValueStatements,
  findMissingEnumValues,
  formatMissingEnumValuesError,
  REQUIRED_ENUM_VALUES,
  stripLineComments,
  type MissingEnumValues,
} from '../../../scripts/lib/enum-migration-guard';

describe('extractAlterTypeAddValueStatements', () => {
  it('extracts a single IF NOT EXISTS statement', () => {
    const sql = `ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'bill';`;
    expect(extractAlterTypeAddValueStatements(sql)).toEqual([
      `ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'bill';`,
    ]);
  });

  it('extracts multiple statements from one file, in order', () => {
    const sql = [
      `ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'bill';--> statement-breakpoint`,
      ``,
      `ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'receipt_105';--> statement-breakpoint`,
      ``,
      `ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tax_receipt_issued';`,
    ].join('\n');
    expect(extractAlterTypeAddValueStatements(sql)).toEqual([
      `ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'bill';`,
      `ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'receipt_105';`,
      `ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tax_receipt_issued';`,
    ]);
  });

  it('does NOT extract commented-out or prose ALTER TYPE lines', () => {
    const sql = [
      `-- ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'ghost';`,
      `--     • document_type += 'bill' — prose describing the change`,
      `   -- indented comment ALTER TYPE "x" ADD VALUE 'nope';`,
      `ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'bill';`,
    ].join('\n');
    expect(extractAlterTypeAddValueStatements(sql)).toEqual([
      `ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'bill';`,
    ]);
  });

  it('extracts the bare (non-IF-NOT-EXISTS) form and schema-qualified names', () => {
    const sql = [
      `ALTER TYPE "public"."audit_event_type" ADD VALUE 'plan_created';`,
      `ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'invoice' BEFORE 'receipt';`,
    ].join('\n');
    expect(extractAlterTypeAddValueStatements(sql)).toEqual([
      `ALTER TYPE "public"."audit_event_type" ADD VALUE 'plan_created';`,
      `ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'invoice' BEFORE 'receipt';`,
    ]);
  });

  it('returns [] for a migration with no enum-add statements', () => {
    const sql = `CREATE TABLE "foo" ("id" uuid PRIMARY KEY);\nALTER TABLE "foo" ADD COLUMN "bar" text;`;
    expect(extractAlterTypeAddValueStatements(sql)).toEqual([]);
  });

  it('does not match ALTER TABLE / CREATE TYPE statements', () => {
    const sql = [
      `CREATE TYPE "document_type" AS ENUM ('invoice', 'receipt', 'credit_note');`,
      `ALTER TABLE "invoices" ADD VALUE 'not a type';`,
    ].join('\n');
    expect(extractAlterTypeAddValueStatements(sql)).toEqual([]);
  });

  it('extracts exactly the three enum-adds from the real 0230 migration', () => {
    const file = resolve(
      process.cwd(),
      'drizzle/migrations/0230_document_type_add_bill.sql',
    );
    const statements = extractAlterTypeAddValueStatements(readFileSync(file, 'utf-8'));
    expect(statements).toEqual([
      `ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'bill';`,
      `ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'receipt_105';`,
      `ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tax_receipt_issued';`,
    ]);
  });

  it('ALTER_TYPE_ADD_VALUE_RE is declared global (reusable across match calls)', () => {
    expect(ALTER_TYPE_ADD_VALUE_RE.flags).toContain('g');
    // Two consecutive calls must yield identical results (no lastIndex leakage).
    const sql = `ALTER TYPE "t" ADD VALUE IF NOT EXISTS 'a';`;
    expect(extractAlterTypeAddValueStatements(sql)).toEqual(
      extractAlterTypeAddValueStatements(sql),
    );
  });
});

describe('stripLineComments', () => {
  it('drops full-line comments but keeps statements and inline trailing comments', () => {
    const sql = ['-- header', "SELECT 1; -- inline note", '  -- indented', 'SELECT 2;'].join(
      '\n',
    );
    expect(stripLineComments(sql)).toBe(['SELECT 1; -- inline note', 'SELECT 2;'].join('\n'));
  });
});

describe('findMissingEnumValues', () => {
  it('returns [] when every required value is present', () => {
    const present = new Map<string, Set<string>>([
      ['document_type', new Set(['invoice', 'receipt', 'credit_note', 'bill', 'receipt_105'])],
      [
        'audit_event_type',
        new Set([
          'sign_in_success',
          'tax_receipt_issued',
          'members_backup_exported',
          'renewal_cycle_reanchored',
          // 0245 (059-membership-suspension Task 8):
          'membership_suspended_action_blocked',
          'membership_access_fail_open',
          'broadcast_membership_suspended_blocked',
        ]),
      ],
    ]);
    expect(findMissingEnumValues(present)).toEqual([]);
  });

  it('reports the specific missing value(s) on an existing type (the prod bug shape)', () => {
    // document_type present but WITHOUT bill / receipt_105 — exactly the
    // confirmed prod-0230 non-persistence state. audit_event_type is fully
    // present (including the 0245 additions) so it does NOT show up here —
    // this test's whole point is isolating a SINGLE missing type.
    const present = new Map<string, Set<string>>([
      ['document_type', new Set(['invoice', 'receipt', 'credit_note'])],
      [
        'audit_event_type',
        new Set([
          'sign_in_success',
          'tax_receipt_issued',
          'members_backup_exported',
          'renewal_cycle_reanchored',
          'membership_suspended_action_blocked',
          'membership_access_fail_open',
          'broadcast_membership_suspended_blocked',
        ]),
      ],
    ]);
    expect(findMissingEnumValues(present)).toEqual<MissingEnumValues[]>([
      { enumType: 'document_type', typeExists: true, missing: ['bill', 'receipt_105'] },
    ]);
  });

  it('reports all required values with typeExists:false when the type is absent', () => {
    const present = new Map<string, Set<string>>([
      ['document_type', new Set(['invoice', 'receipt', 'credit_note', 'bill', 'receipt_105'])],
    ]);
    expect(findMissingEnumValues(present)).toEqual<MissingEnumValues[]>([
      {
        enumType: 'audit_event_type',
        typeExists: false,
        missing: [
          'tax_receipt_issued',
          'members_backup_exported',
          'renewal_cycle_reanchored',
          // 0245 (059-membership-suspension Task 8):
          'membership_suspended_action_blocked',
          'membership_access_fail_open',
          'broadcast_membership_suspended_blocked',
        ],
      },
    ]);
  });

  it('honours a caller-supplied required set', () => {
    const present = new Map<string, Set<string>>([['color', new Set(['red'])]]);
    expect(findMissingEnumValues(present, { color: ['red', 'blue'] })).toEqual<MissingEnumValues[]>(
      [{ enumType: 'color', typeExists: true, missing: ['blue'] }],
    );
  });

  it('the default REQUIRED_ENUM_VALUES set matches the code-critical enums', () => {
    expect(REQUIRED_ENUM_VALUES['document_type']).toContain('bill');
    expect(REQUIRED_ENUM_VALUES['document_type']).toContain('receipt_105');
    expect(REQUIRED_ENUM_VALUES['audit_event_type']).toContain('tax_receipt_issued');
    expect(REQUIRED_ENUM_VALUES['audit_event_type']).toContain('members_backup_exported');
    expect(REQUIRED_ENUM_VALUES['audit_event_type']).toContain('renewal_cycle_reanchored');
  });
});

describe('formatMissingEnumValuesError', () => {
  it('names the enum, the missing value, and the idempotent hand-fix', () => {
    const message = formatMissingEnumValuesError([
      { enumType: 'document_type', typeExists: true, missing: ['bill'] },
    ]);
    expect(message).toContain('document_type');
    expect(message).toContain('bill');
    expect(message).toContain(`ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'bill';`);
    expect(message).toContain('repair-enum-drift.ts');
  });

  it('distinguishes a missing type from a missing value', () => {
    const message = formatMissingEnumValuesError([
      { enumType: 'audit_event_type', typeExists: false, missing: ['tax_receipt_issued'] },
    ]);
    expect(message).toContain('does not exist');
  });
});
