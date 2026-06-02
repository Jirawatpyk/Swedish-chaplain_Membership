/**
 * Stage-3 importer — report builder + writer (spec § 7).
 *
 * The report contains ONLY counts, the tier histogram, and per-row issues keyed
 * by { rowIndex, field, code } — **never** company names, emails, or any other
 * PII (spec § 7). `buildReportDocument` deliberately drops `ValidationReport.members`
 * (which carries PII for the commit phase) so a serialized report is PII-free by
 * construction — asserted by the unit test.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RowIssue, ValidationReport } from './validate';

export interface CommitOutcome {
  readonly membersCreated: number;
  readonly contactsCreated: number;
  readonly skippedExistingContacts: number;
  readonly skippedSoftDeletedContacts: number;
}

export interface ReportDocument {
  readonly generatedAt: string;
  readonly mode: 'dry-run' | 'commit';
  readonly planYear: number;
  readonly stats: ValidationReport['stats'];
  readonly tierHistogram: Readonly<Record<string, number>>;
  readonly issues: readonly RowIssue[];
  readonly committed: CommitOutcome | null;
}

export function buildReportDocument(args: {
  readonly report: ValidationReport;
  readonly mode: 'dry-run' | 'commit';
  readonly planYear: number;
  readonly generatedAt: string;
  readonly committed?: CommitOutcome | null;
}): ReportDocument {
  return {
    generatedAt: args.generatedAt,
    mode: args.mode,
    planYear: args.planYear,
    stats: args.report.stats,
    tierHistogram: args.report.tierHistogram,
    issues: args.report.issues, // {rowIndex, field, code, severity} — no PII
    committed: args.committed ?? null,
  };
}

/** Console-friendly summary (counts + histogram + first issues). No PII. */
export function renderReportText(doc: ReportDocument): string {
  const lines: string[] = [];
  lines.push(`Member import report — ${doc.mode} — plan year ${doc.planYear}`);
  lines.push(`Generated: ${doc.generatedAt}`);
  lines.push('');
  lines.push(
    `Rows: ${doc.stats.totalRows} · member groups: ${doc.stats.memberGroups} · ` +
      `valid members: ${doc.stats.validMembers} · valid contacts: ${doc.stats.validContacts}`,
  );
  lines.push(`Errors: ${doc.stats.errorCount} · Warnings: ${doc.stats.warningCount}`);
  lines.push('');
  lines.push('Tier histogram (valid members):');
  for (const [planId, n] of Object.entries(doc.tierHistogram).sort()) {
    lines.push(`  ${planId}: ${n}`);
  }
  if (doc.issues.length > 0) {
    lines.push('');
    lines.push('Issues (rowIndex · severity · field · code):');
    for (const i of doc.issues.slice(0, 200)) {
      lines.push(`  row ${i.rowIndex} · ${i.severity} · ${i.field} · ${i.code}`);
    }
    if (doc.issues.length > 200) lines.push(`  … +${doc.issues.length - 200} more`);
  }
  if (doc.committed) {
    lines.push('');
    lines.push(
      `Committed: ${doc.committed.membersCreated} members + ${doc.committed.contactsCreated} contacts; ` +
        `skipped ${doc.committed.skippedExistingContacts} existing + ` +
        `${doc.committed.skippedSoftDeletedContacts} soft-deleted contacts`,
    );
  }
  return lines.join('\n');
}

/** Write the report JSON to `dir`; returns the file path. Filename is timestamped + filesystem-safe. */
export function writeReportFile(doc: ReportDocument, dir: string): string {
  const safeTs = doc.generatedAt.replace(/[:.]/g, '-');
  const path = join(dir, `member-import-report-${doc.mode}-${safeTs}.json`);
  writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8');
  return path;
}
