/**
 * F9 US6 (staff-review R2-2) — DataExportPanel view-model builders.
 *
 * Pins the shared projection logic both panel callers (member page + admin card)
 * depend on: the status-label map (requested+processing → Preparing), the
 * downloadable flag (ready|delivered only), locale date formatting, and the full
 * label set. A regression here would silently affect both surfaces.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDataExportLabels,
  buildDataExportRows,
  type DataExportJobView,
} from '@/components/data-export/data-export-view-model';

// Identity translator — returns the key so assertions read the mapping directly.
const t = (k: string): string => k;

const at = new Date('2026-05-29T08:30:00.000Z');
const job = (status: DataExportJobView['status']): DataExportJobView => ({
  id: `job-${status}`,
  status,
  createdAt: at,
});

describe('buildDataExportRows', () => {
  it('maps requested + processing to the same "Preparing" label', () => {
    const rows = buildDataExportRows([job('requested'), job('processing')], t, 'en');
    expect(rows.map((r) => r.statusLabel)).toEqual(['statusPending', 'statusPending']);
  });

  it('maps each terminal status to its own label', () => {
    const rows = buildDataExportRows(
      [job('ready'), job('delivered'), job('expired'), job('failed')],
      t,
      'en',
    );
    expect(rows.map((r) => r.statusLabel)).toEqual([
      'statusReady',
      'statusDelivered',
      'statusExpired',
      'statusFailed',
    ]);
  });

  it('marks ONLY ready + delivered as downloadable', () => {
    const rows = buildDataExportRows(
      [job('requested'), job('processing'), job('ready'), job('delivered'), job('expired'), job('failed')],
      t,
      'en',
    );
    expect(rows.map((r) => r.downloadable)).toEqual([false, false, true, true, false, false]);
  });

  it('carries the jobId and a formatted requestedAt', () => {
    const [row] = buildDataExportRows([job('ready')], t, 'en');
    expect(row!.jobId).toBe('job-ready');
    expect(row!.requestedAt).toMatch(/2026/); // locale-formatted date present
  });

  it('renders BE year for the Thai locale (FR-034)', () => {
    const [row] = buildDataExportRows([job('ready')], t, 'th');
    // 2026 CE → 2569 BE under th-TH-u-ca-buddhist.
    expect(row!.requestedAt).toMatch(/2569/);
  });
});

describe('buildDataExportLabels', () => {
  it('includes every key the panel consumes (incl. alreadyPending)', () => {
    const labels = buildDataExportLabels(t);
    expect(Object.keys(labels).sort()).toEqual(
      [
        'alreadyPending',
        'caption',
        'colRequested',
        'colStatus',
        'download',
        'empty',
        'errorBody',
        'errorTitle',
        'expiresHint',
        'requestButton',
        'requestedBody',
        'requestedTitle',
        'requesting',
        'statusHeading',
      ].sort(),
    );
  });

  it('uses statusHeading for the (sr-only) table caption', () => {
    expect(buildDataExportLabels(t).caption).toBe('statusHeading');
  });
});
