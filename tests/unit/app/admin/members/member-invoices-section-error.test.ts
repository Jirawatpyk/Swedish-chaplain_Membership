/**
 * #739 B3b — the member invoices card throws to its error boundary when the
 * invoice read fails. The thrown message reaches the Vercel runtime log, so it
 * names the failure's class, never the repo cause's text: a drizzle error's
 * message quotes the statement's bound parameters.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Bangkok' }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/members/m-1',
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/modules/invoicing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/invoicing')>()),
  listInvoicesByMember: async () => ({
    ok: false,
    error: { type: 'repo_error', cause: new Error('Failed query: select … params: a@b.example') },
  }),
  makeListInvoicesByMemberDeps: () => ({}),
}));

const { MemberInvoicesSection } = await import(
  '@/app/(staff)/admin/members/[memberId]/_components/member-invoices-section'
);

describe('member invoices card — a failed read (#739 B3b)', () => {
  it('throws a message that names the class, never the cause text', async () => {
    const thrown = await MemberInvoicesSection({
      tenant: { slug: 't1' } as never,
      memberId: 'm-1',
      role: 'admin',
      page: 1,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).not.toContain('a@b.example');
    expect(thrown!.message).toContain('Error');
  });
});
