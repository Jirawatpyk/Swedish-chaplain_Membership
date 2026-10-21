/**
 * Spec 122 (AURA 5.52, #164) — the users and audit lists draw AURA's static
 * `Table`, so their loading skeleton is AURA's own `TableSkeleton` (the loading
 * Table for Server Components): the same frame, cards below 640px, and each
 * column's share of the real table. The app's stand-in is gone.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => {
    const t = (key: string) => key;
    return Object.assign(t, { rich: t, raw: t, has: () => true });
  }),
}));

import UsersLoading from '@/app/(staff)/admin/users/loading';
import AuditLoading from '@/app/(staff)/admin/audit/loading';

afterEach(cleanup);

const LOADERS: ReadonlyArray<readonly [string, () => Promise<ReactElement>, number]> = [
  ['users', UsersLoading, 5],
  ['audit', AuditLoading, 6],
];

describe('static-table list skeletons are AURA TableSkeleton', () => {
  it.each(LOADERS)('%s: one AURA skeleton table, stacked into cards below 640px, inert', async (_name, Loading, columns) => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        {await Loading()}
      </NextIntlClientProvider>,
    );
    const tables = container.querySelectorAll('.aura-tbl--skeleton');
    expect(tables).toHaveLength(1);
    const wrap = tables[0]!.closest('[aria-hidden="true"]');
    expect(wrap).not.toBeNull();
    expect(container.querySelector('.aura-tbl--stack-sm')).not.toBeNull();
    expect(tables[0]!.querySelectorAll('col')).toHaveLength(columns);
    expect(container.querySelectorAll('.aura-tbl__row--skeleton')).toHaveLength(8);
  });

  it('the app stand-in is gone', () => {
    expect(existsSync(resolve(__dirname, '../../../../src/components/shell/static-table-skeleton.tsx'))).toBe(false);
  });
});
