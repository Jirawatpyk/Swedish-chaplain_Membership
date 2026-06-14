/**
 * Stage-3 importer — report builder unit tests (spec § 7). The critical
 * assertion: a serialized report carries ZERO PII (no company names / emails),
 * only counts + row indices + field/code + histogram.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const { buildReportDocument, renderReportText, writeReportFile } = await import(
  '@/../scripts/import-members/report'
);
const { validateRows } = await import('@/../scripts/import-members/validate');
const { buildTierResolver } = await import('@/../scripts/import-members/tier-resolution');

const RESOLVER = buildTierResolver([
  { planId: 'premium', nameEn: 'Premium Corporate', memberTypeScope: 'company' },
]);

// A row carrying obvious PII (company + email) + one error (bad email on row 3).
const report = validateRows(
  [
    {
      rowIndex: 2, companyName: 'Secret Holdings Ltd', country: 'SE', taxId: 'SE99887766',
      tier: 'Premium', turnover: '', registrationDate: '2026-01-01', memberLocale: '',
      city: '', province: '', postalCode: '',
      contactFirstName: 'Top', contactLastName: 'Secret', contactEmail: 'ceo@secret-holdings.test',
      contactPhone: '', contactRole: '', contactLanguage: '', isPrimary: 'yes',
    },
    {
      rowIndex: 3, companyName: 'Bad Email Co', country: 'SE', taxId: 'SE111',
      tier: 'Premium', turnover: '', registrationDate: '2026-01-01', memberLocale: '',
      city: '', province: '', postalCode: '',
      contactFirstName: 'A', contactLastName: 'B', contactEmail: 'NOT-AN-EMAIL',
      contactPhone: '', contactRole: '', contactLanguage: '', isPrimary: 'yes',
    },
  ],
  RESOLVER,
);

describe('report builder (spec § 7 — no PII)', () => {
  const doc = buildReportDocument({
    report,
    mode: 'dry-run',
    planYear: 2026,
    generatedAt: '2026-06-03T00:00:00.000Z',
  });

  it('carries stats + histogram + issues, but NOT the members list', () => {
    expect(doc.stats.totalRows).toBe(2);
    expect(doc.stats.errorCount).toBeGreaterThan(0);
    expect(doc.tierHistogram['premium']).toBe(1); // only the valid member counted
    expect((doc as unknown as Record<string, unknown>)['members']).toBeUndefined();
    expect(doc.issues.some((i) => i.rowIndex === 3 && i.field === 'contactEmail')).toBe(true);
  });

  it('serialized JSON contains ZERO PII (no company name / email)', () => {
    const json = JSON.stringify(doc);
    expect(json).not.toContain('Secret Holdings');
    expect(json).not.toContain('ceo@secret-holdings.test');
    expect(json).not.toContain('Bad Email Co');
    expect(json).not.toContain('NOT-AN-EMAIL');
  });

  it('writeReportFile round-trips a PII-free JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-report-'));
    try {
      const path = writeReportFile(doc, dir);
      const onDisk = readFileSync(path, 'utf8');
      expect(onDisk).not.toContain('Secret Holdings');
      expect(onDisk).not.toContain('@secret-holdings');
      expect(JSON.parse(onDisk).stats.totalRows).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renderReportText is a PII-free human summary', () => {
    const text = renderReportText(doc);
    expect(text).toContain('dry-run');
    expect(text).toContain('premium: 1');
    expect(text).not.toContain('Secret Holdings');
    expect(text).not.toContain('@secret-holdings');
  });

  it('renders a committed outcome with the skip-row lists (rowIndex only, no PII)', () => {
    const committedDoc = buildReportDocument({
      report,
      mode: 'commit',
      planYear: 2026,
      generatedAt: '2026-06-03T00:00:00.000Z',
      committed: {
        membersCreated: 5,
        contactsCreated: 8,
        cyclesCreated: 5,
        skippedExistingMembers: 2,
        skippedPartialOverlapMembers: 1,
        skippedSoftDeletedContacts: 1,
        skippedPrimaryCollisionMembers: 1,
        partialOverlapRows: [7, 12],
        primaryCollisionRows: [19],
      },
    });
    const text = renderReportText(committedDoc);
    expect(text).toContain(
      'Committed: 5 members + 8 contacts + 5 initial renewal cycles.',
    );
    // R4 #12: the 4-count Skipped: summary line must carry every bucket, correctly labelled,
    // so a regression that drops or mislabels a count is caught.
    expect(text).toContain(
      'Skipped: 2 already-imported members, 1 partial-overlap members, 1 soft-deleted contacts, 1 primary-collision members',
    );
    expect(text).toContain('partial-overlap rows (resolve manually): 7, 12');
    expect(text).toContain('primary-collision rows (resolve manually): 19');
    expect(text).not.toContain('Secret Holdings'); // still no PII
    expect(JSON.stringify(committedDoc)).not.toContain('Secret Holdings');
  });
});
