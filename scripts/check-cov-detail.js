import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const c = JSON.parse(
  readFileSync(join(__dirname, '..', 'coverage', 'coverage-summary.json'), 'utf-8'),
);
for (const [k, v] of Object.entries(c)) {
  if (k === 'total') continue;
  if (!k.includes('invoicing') && !k.includes('payments')) continue;
  const m = k.match(/(invoicing|payments)\\(?:domain|application)\\(?:.+\\)?([\w.-]+)/);
  const f = m ? m[0] : k;
  if (v.lines.pct < 100 || v.branches.pct < 100 || v.functions.pct < 100) {
    console.log(`${f.padEnd(70)} L:${v.lines.pct}% B:${v.branches.pct}% F:${v.functions.pct}% (${v.lines.covered}/${v.lines.total} L)`);
  }
}
