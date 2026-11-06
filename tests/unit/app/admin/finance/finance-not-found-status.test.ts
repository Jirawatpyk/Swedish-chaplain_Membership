/**
 * PR P / #78 — `/admin/finance` with FEATURE_INVOICE_DASHBOARD off.
 *
 * The not-found page is the segment's own `not-found.tsx` (the admin one).
 * The HTTP status is NOT set by the page: its `notFound()` runs inside the
 * segment's `loading.tsx` boundary, after the stream has started with 200
 * (production build, R141 relay rev 70). The status-bearing gate is
 * `layout.tsx` (finance-layout-gate.test.tsx); the relay checks the live 404.
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
