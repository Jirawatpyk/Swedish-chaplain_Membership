/**
 * Stage-3 importer — workbook round-trip (spec § 8 fixture). Generates a small
 * ANONYMIZED .xlsx (no real PII), then exercises the full parse → map → validate
 * chain (readWorkbook + columns + validate). No DB.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Importing the CLI module is safe: its direct-run guard (process.argv[1] ends
// with import-members.ts) is false under vitest, so main() does not run.
const { readWorkbook } = await import('@/../scripts/import-members');
const { buildColumnMap, mapDataRows } = await import('@/../scripts/import-members/columns');
const { validateRows } = await import('@/../scripts/import-members/validate');
const { buildTierResolver } = await import('@/../scripts/import-members/tier-resolution');

const RESOLVER = buildTierResolver([
  { planId: 'premium', nameEn: 'Premium Corporate', memberTypeScope: 'company' },
  { planId: 'thai-alumni', nameEn: 'Thai Alumni/Student', memberTypeScope: 'individual' },
]);

function writeFixture(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'import-fixture-'));
  const aoa = [
    ['Company Name', 'Country', 'Tax ID', 'Membership Tier', 'Registration Date', 'First Name', 'Last Name', 'Email', 'Primary'],
    ['Anon Co A', 'SE', 'SE556677889900', 'Premium', '2026-01-15', 'Anna', 'Andersson', 'anna@anon-a.test', 'yes'],
    ['Anon Co A', 'SE', 'SE556677889900', 'Premium', '2026-01-15', 'Bo', 'Berg', 'bo@anon-a.test', ''],
    ['Anon Co B', 'Thailand', '', 'Thai Alumni', '2026-02-01', 'Boon', 'Jai', 'boon@anon-b.test', 'yes'],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Members');
  const file = join(dir, 'fixture.xlsx');
  XLSX.writeFile(wb, file);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('member importer — workbook round-trip (spec § 8)', () => {
  it('parses a generated fixture and validates 2 members (one with 2 contacts)', () => {
    const { file, cleanup } = writeFixture();
    try {
      const { headers, dataRows } = readWorkbook(file);
      const map = buildColumnMap(headers);
      expect(map.missingRequired).toEqual([]);

      const rows = mapDataRows(dataRows, map, 2);
      expect(rows).toHaveLength(3);

      const report = validateRows(rows, RESOLVER);
      expect(report.stats.errorCount).toBe(0);
      expect(report.members).toHaveLength(2);

      const a = report.members.find((m) => m.companyName === 'Anon Co A')!;
      expect(a.planId).toBe('premium');
      expect(a.country).toBe('SE');
      expect(a.contacts).toHaveLength(2);
      expect(a.contacts.filter((c) => c.isPrimary)).toHaveLength(1);

      const b = report.members.find((m) => m.companyName === 'Anon Co B')!;
      expect(b.planId).toBe('thai-alumni');
      expect(b.country).toBe('TH'); // "Thailand" → TH
      expect(b.taxId).toBeNull(); // individual scope, no tax_id needed
    } finally {
      cleanup();
    }
  });

  it('reads a NAMED sheet when a sheet name is given (not just the first)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-sheet-'));
    const file = join(dir, 'two-sheets.xlsx');
    try {
      const wb = XLSX.utils.book_new();
      // Real workbook keeps member data on a later sheet, NOT sheet[0].
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ignore'], ['x']]), 'First');
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([['Company', 'Email'], ['Acme', 'a@b.test']]),
        'Member Data New',
      );
      XLSX.writeFile(wb, file);
      const { headers } = readWorkbook(file, 'Member Data New');
      expect(headers).toEqual(['Company', 'Email']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a clear error naming available sheets when the sheet is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-sheet-missing-'));
    const file = join(dir, 'one-sheet.xlsx');
    try {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a'], ['1']]), 'Only');
      XLSX.writeFile(wb, file);
      expect(() => readWorkbook(file, 'Nope')).toThrow(/not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
