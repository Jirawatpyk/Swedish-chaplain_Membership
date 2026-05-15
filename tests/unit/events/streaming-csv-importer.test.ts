/**
 * T093 — Unit tests for `streamingCsvImporter` (F6 Infrastructure).
 *
 * Covers each branch of the hand-rolled parser against the fixture set
 * in `tests/integration/events/csv-fixtures/`:
 *   - happy path (5 rows)
 *   - BOM stripping
 *   - CRLF line endings
 *   - quoted field with comma
 *   - escaped double-quote `""`
 *   - embedded-newline rejection
 *   - missing required column rejection
 *   - semicolon-separator rejection
 *   - trailing-comma row rejection
 *   - empty file rejection
 *   - rowHash determinism + sensitivity
 *
 * Pure unit test — no DB, no fs mocks (fs.readFileSync is real). Fast
 * (<1s) and isolated from the integration suite that imports the same
 * fixtures.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { streamingCsvImporter, _internals } from '@/modules/events/infrastructure/streaming-csv-importer';
import type { ParsedRow } from '@/modules/events/application/ports/csv-importer';

const FIXTURE_DIR = join(
  process.cwd(),
  'tests',
  'integration',
  'events',
  'csv-fixtures',
);

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

async function collectRows(
  bytes: Uint8Array,
): Promise<{ ok: boolean; rows: ParsedRow[]; error?: unknown }> {
  const result = await streamingCsvImporter.parseStream({ bytes });
  if (!result.ok) return { ok: false, rows: [], error: result.error };
  const rows: ParsedRow[] = [];
  for await (const r of result.value) {
    rows.push(r);
  }
  return { ok: true, rows };
}

describe('streamingCsvImporter — happy paths', () => {
  it('parses 5 rows from happy-5-rows.csv with all required + optional columns', async () => {
    const bytes = readFixture('happy-5-rows.csv');
    const result = await collectRows(bytes);

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(5);
    // Every row is `ok: true`.
    for (const r of result.rows) {
      expect(r.ok).toBe(true);
    }
    const okRows = result.rows.filter(
      (r): r is Extract<ParsedRow, { ok: true }> => r.ok,
    );
    expect(okRows[0]!.row.event_external_id).toBe('event_001');
    expect(okRows[0]!.row.attendee_email).toBe('jane@example.com');
    expect(okRows[0]!.row.attendee_company).toBe('Fogmaker International AB');
    expect(okRows[0]!.row.payment_status).toBe('paid');
    expect(okRows[0]!.row.event_category).toBe('cultural');
    // Third row has empty attendee_company (gmail visitor); zod's
    // optional default skips the field.
    expect(okRows[2]!.row.attendee_company).toBeUndefined();
  });

  it('strips UTF-8 BOM (with-bom.csv)', async () => {
    const bytes = readFixture('with-bom.csv');
    const result = await collectRows(bytes);

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.ok).toBe(true);
    if (result.rows[0]!.ok) {
      expect(result.rows[0]!.row.event_external_id).toBe('event_bom_1');
    }
  });

  it('accepts CRLF line endings (crlf-line-endings.csv)', async () => {
    const bytes = readFixture('crlf-line-endings.csv');
    const result = await collectRows(bytes);

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.ok).toBe(true);
    if (result.rows[0]!.ok) {
      expect(result.rows[0]!.row.event_external_id).toBe('event_crlf_1');
    }
  });

  it('parses quoted fields with embedded commas (quoted-fields-with-comma.csv)', async () => {
    const bytes = readFixture('quoted-fields-with-comma.csv');
    const result = await collectRows(bytes);

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(2);
    // event_location not in CsvRowSchema → silently dropped. But the
    // tokeniser must still handle the embedded-comma cell correctly
    // (otherwise the column-count check would reject the row).
    for (const r of result.rows) {
      expect(r.ok).toBe(true);
    }
  });

  it('parses escaped double-quote `""` (quoted-fields-with-escape.csv)', async () => {
    const bytes = readFixture('quoted-fields-with-escape.csv');
    const result = await collectRows(bytes);

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(2);
    const okRows = result.rows.filter(
      (r): r is Extract<ParsedRow, { ok: true }> => r.ok,
    );
    expect(okRows[0]!.row.attendee_company).toBe('O"Hara Industries');
    expect(okRows[1]!.row.attendee_company).toBe('Acme "Special" Co');
  });
});

describe('streamingCsvImporter — header-level rejections', () => {
  it('rejects missing required columns (malformed-missing-required-column.csv)', async () => {
    const bytes = readFixture('malformed-missing-required-column.csv');
    const result = await streamingCsvImporter.parseStream({ bytes });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_header');
      if (result.error.kind === 'invalid_header') {
        expect(result.error.missingColumns).toContain('event_start');
        expect(result.error.missingColumns).toContain('attendee_email');
      }
    }
  });

  it('rejects semicolon separator (malformed-wrong-separator-semicolon.csv)', async () => {
    const bytes = readFixture('malformed-wrong-separator-semicolon.csv');
    const result = await streamingCsvImporter.parseStream({ bytes });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_header');
      if (result.error.kind === 'invalid_header') {
        expect(result.error.reason.toLowerCase()).toContain('semicolon');
      }
    }
  });

  it('rejects empty file', async () => {
    const result = await streamingCsvImporter.parseStream({
      bytes: new Uint8Array(0),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_header');
    }
  });

  it('accepts admin column-mapping (renames a non-canonical header to canonical)', async () => {
    const csv = [
      'Event ID,Event Name,Event Start,Email,Name',
      'event_map_1,Test Event,2026-06-21T18:00:00+07:00,test@example.com,Test Person',
    ].join('\n');
    const mapping = new Map<string, string>([
      ['Event ID', 'event_external_id'],
      ['Event Name', 'event_name'],
      ['Event Start', 'event_start'],
      ['Email', 'attendee_email'],
      ['Name', 'attendee_name'],
    ]);
    const result = await streamingCsvImporter.parseStream({
      bytes: new TextEncoder().encode(csv),
      columnMapping: mapping,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rows: ParsedRow[] = [];
      for await (const r of result.value) rows.push(r);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.ok).toBe(true);
    }
  });
});

describe('streamingCsvImporter — per-row rejections', () => {
  it('accepts embedded newlines inside quoted cells (RFC 4180 § 2.6, F6.1 / Feature 013 · T009)', async () => {
    // F6.1 update — Phase 7 strictly REJECTED this fixture (R8 / E20);
    // F6.1 relaxes to RFC 4180 § 2.6 to support real EventCreate
    // "Guestlist" exports whose address cells routinely span multiple
    // physical lines (e.g. Grant Thornton workshop fixture row 2).
    // The fixture's row 1 has attendee_company = "Acme\nMulti-line Co"
    // — should parse SUCCESSFULLY, NOT as "unterminated quoted field".
    const bytes = readFixture('malformed-embedded-newline.csv');
    const result = await collectRows(bytes);

    expect(result.ok).toBe(true);
    // BOTH rows should now parse successfully — no failures from
    // embedded newline. (Genuine unterminated quotes at EOF still
    // surface as `unterminated quoted field` via tokeniseLine.)
    const failRows = result.rows.filter((r) => !r.ok);
    expect(failRows).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    const firstOk = result.rows[0];
    if (firstOk && firstOk.ok) {
      expect(firstOk.row.attendee_company).toBe('Acme\nMulti-line Co');
    }
  });

  it('rejects trailing-comma rows (column count mismatch)', async () => {
    const csv = [
      'event_external_id,event_name,event_start,attendee_email,attendee_name',
      'event_tc_1,Test,2026-06-21T18:00:00+07:00,test@example.com,Test Person,',
    ].join('\n');
    const result = await collectRows(new TextEncoder().encode(csv));

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.ok).toBe(false);
    if (!result.rows[0]!.ok) {
      expect(result.rows[0]!.reason.toLowerCase()).toContain('trailing comma');
    }
  });

  it('rejects rows with invalid email format (zod validation)', async () => {
    const csv = [
      'event_external_id,event_name,event_start,attendee_email,attendee_name',
      'event_bv_1,Test,2026-06-21T18:00:00+07:00,not-an-email,Test Person',
    ].join('\n');
    const result = await collectRows(new TextEncoder().encode(csv));

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.ok).toBe(false);
    if (!result.rows[0]!.ok) {
      expect(result.rows[0]!.reason).toContain('attendee_email');
    }
  });
});

describe('streamingCsvImporter — rowHash determinism + sensitivity', () => {
  it('produces identical hash for identical row content', async () => {
    const row = {
      event_external_id: 'event_h1',
      attendee_email: 'jane@example.com',
      event_start: '2026-06-21T18:00:00+07:00',
      // optional fields shouldn't affect the hash per the canonical
      // 3-component key documented in contracts/csv-import-api.md § 4b
      event_name: 'Test Event',
      attendee_name: 'Jane',
      payment_status: 'paid' as const,
    };
    const h1 = _internals.computeRowHash(row);
    const h2 = _internals.computeRowHash(row);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different hash when attendee_email differs', async () => {
    const row1 = {
      event_external_id: 'event_h2',
      attendee_email: 'jane@example.com',
      event_start: '2026-06-21T18:00:00+07:00',
      event_name: 'Test',
      attendee_name: 'Jane',
      payment_status: 'paid' as const,
    };
    const row2 = { ...row1, attendee_email: 'lars@example.com' };
    expect(_internals.computeRowHash(row1)).not.toBe(
      _internals.computeRowHash(row2),
    );
  });

  it('case-insensitive on attendee_email — identical hash for jane@... vs JANE@...', async () => {
    const row1 = {
      event_external_id: 'event_h3',
      attendee_email: 'jane@example.com',
      event_start: '2026-06-21T18:00:00+07:00',
      event_name: 'Test',
      attendee_name: 'Jane',
      payment_status: 'paid' as const,
    };
    const row2 = { ...row1, attendee_email: 'JANE@example.com' };
    expect(_internals.computeRowHash(row1)).toBe(
      _internals.computeRowHash(row2),
    );
  });

  it('uses event_start as fallback when registered_at is absent', async () => {
    const row1 = {
      event_external_id: 'event_h4',
      attendee_email: 'jane@example.com',
      event_start: '2026-06-21T18:00:00+07:00',
      event_name: 'Test',
      attendee_name: 'Jane',
      payment_status: 'paid' as const,
    };
    const row2 = {
      ...row1,
      registered_at: '2026-06-21T18:00:00+07:00',
    };
    expect(_internals.computeRowHash(row1)).toBe(
      _internals.computeRowHash(row2),
    );
  });
});
