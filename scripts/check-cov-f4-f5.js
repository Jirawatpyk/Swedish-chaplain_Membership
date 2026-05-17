import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const c = JSON.parse(
  readFileSync(join(process.cwd(), 'coverage', 'coverage-summary.json'), 'utf-8'),
);
const targets = [
  'invoicing/domain',
  'payments/domain',
  'invoicing/application/use-cases/get-invoice-pdf',
  'invoicing/application/use-cases/get-receipt-pdf',
  'invoicing/application/use-cases/get-credit-note-pdf',
  'invoicing/application/use-cases/issue-invoice',
  'invoicing/application/use-cases/record-payment',
  'payments/application/use-cases/initiate-payment',
  'payments/application/use-cases/process-webhook-event',
  'payments/application/use-cases/confirm-payment',
];
console.log('\nF4/F5 critical paths — coverage % per file:\n');
for (const [k, v] of Object.entries(c)) {
  if (k === 'total') continue;
  const norm = k.replace(/\\/g, '/');
  if (!targets.some(t => norm.includes(t))) continue;
  const f = norm.split('modules/')[1] || norm.split('lib/')[1] || norm;
  const mark = v.lines.pct === 100 && v.branches.pct === 100 && v.functions.pct === 100 ? '✓' : '✗';
  console.log(`  ${mark} ${f.padEnd(70)} L:${v.lines.pct}% B:${v.branches.pct}% F:${v.functions.pct}%`);
}
