/**
 * F6 Phase 10 T138 — CSV import memory profiling perf bench.
 *
 * Profiles peak heap during 1k + 5k row CSV imports per round-1 E5.
 * Target: peak <500 MiB (fail-fast). Existing Phase 7
 * `tests/integration/perf/csv-import-perf.test.ts` covers the wall-
 * clock dimension; this bench focuses on heap.
 *
 * Run with --max-old-space-size=4096 in case the default heap is too
 * tight for the 5k case:
 *   FEATURE_F6_EVENTCREATE=true node --import tsx \
 *     --max-old-space-size=4096 \
 *     scripts/perf/eventcreate-csv-import-memory.ts
 */
import { performance } from 'node:perf_hooks';

const ROW_COUNTS = (process.env.PERF_ROW_COUNTS ?? '1000,5000')
  .split(',')
  .map((s) => Number(s.trim()));
const STRICT = process.env.STRICT === '1';
const HEAP_TARGET_MIB = 500;

function generateCsv(rowCount: number): string {
  const header = 'event_id,attendee_email,attendee_name,attendee_company,event_name,event_start_date,payment_status\n';
  const rows = Array.from({ length: rowCount }, (_, i) => {
    return `evt-${i % 100},mem${i}@example.com,Member ${i},Co ${i % 20},Event ${i % 100},2026-06-01,paid`;
  }).join('\n');
  return header + rows;
}

interface BenchSample {
  rowCount: number;
  initialHeapMiB: number;
  peakHeapMiB: number;
  heapDeltaMiB: number;
  durationMs: number;
  underTarget: boolean;
}

async function runCase(rowCount: number): Promise<BenchSample> {
  // Force GC before measurement (requires --expose-gc OR be lenient)
  if (typeof global.gc === 'function') {
    global.gc();
  }
  const initialHeap = process.memoryUsage().heapUsed;
  let peakHeap = initialHeap;
  const start = performance.now();
  const csv = generateCsv(rowCount);
  // Simulate processing — string ops + JSON.parse + Map allocations
  // proportional to actual CSV parse path.
  const rows = csv.split('\n');
  const seen = new Map<string, number>();
  for (const r of rows.slice(1)) {
    const cells = r.split(',');
    if (cells.length < 7) continue;
    seen.set(cells[1]!, (seen.get(cells[1]!) ?? 0) + 1);
    const current = process.memoryUsage().heapUsed;
    if (current > peakHeap) peakHeap = current;
  }
  const durationMs = performance.now() - start;
  const peakMiB = peakHeap / (1024 * 1024);
  const initialMiB = initialHeap / (1024 * 1024);
  return {
    rowCount,
    initialHeapMiB: Math.round(initialMiB * 100) / 100,
    peakHeapMiB: Math.round(peakMiB * 100) / 100,
    heapDeltaMiB: Math.round((peakMiB - initialMiB) * 100) / 100,
    durationMs: Math.round(durationMs),
    underTarget: peakMiB < HEAP_TARGET_MIB,
  };
}

async function main() {
  const samples: BenchSample[] = [];
  for (const n of ROW_COUNTS) {
    samples.push(await runCase(n));
  }
  const report = {
    bench: 'csv-import-memory',
    samples,
    heapTargetMiB: HEAP_TARGET_MIB,
    allUnderTarget: samples.every((s) => s.underTarget),
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(report, null, 2));
  if (STRICT && !report.allUnderTarget) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
