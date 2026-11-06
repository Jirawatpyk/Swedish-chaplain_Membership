/**
 * PR P — `/admin/finance` answers a real 404 when FEATURE_INVOICE_DASHBOARD
 * is off (R136 follow-up).
 *
 * The page calls `notFound()` behind the flag, but the segment has a
 * `loading.tsx`, so without `force-dynamic` and a sibling `not-found.tsx`
 * Next streams the not-found page with HTTP 200 (the class
 * `tests/e2e/smoke-404-status-contract.spec.ts` guards; the fix pattern is
 * `admin/invoices/[invoiceId]/page.tsx`). The live status is checked on the
 * relay with the flag off; this pins the two pieces the status depends on.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SEGMENT = join(process.cwd(), 'src/app/(staff)/admin/finance');

describe('/admin/finance 404 status contract', () => {
  it('the page is force-dynamic, so notFound() can still set the status', () => {
    const page = readFileSync(join(SEGMENT, 'page.tsx'), 'utf8');
    expect(page).toMatch(/^export const dynamic = 'force-dynamic';\r?$/m);
  });

  it('the segment has its own not-found.tsx, re-using the admin not-found page', () => {
    const file = join(SEGMENT, 'not-found.tsx');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(/export \{ default \} from '\.\.\/not-found';/);
  });
});
