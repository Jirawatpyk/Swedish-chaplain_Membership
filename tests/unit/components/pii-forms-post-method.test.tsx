/**
 * Security regression guard (CWE-598) — PII / financial forms MUST declare
 * `method="post"` on their <form>, same root cause + fix as the four
 * password forms (see tests/unit/auth/auth-forms-post-method.test.tsx).
 *
 * These forms submit via a client `onSubmit` → `fetch()` handler that only
 * runs after hydration. A pre-hydration native submit on a `method="get"`
 * form serialises every field into the URL query string — leaking email /
 * member PII / customer + invoice data into browser history, server access
 * logs, and Referer headers. `method="post"` moves any native fallback into
 * the request body (discarded by the GET-only page route → 405). Inert once
 * hydrated (RHF/handler calls preventDefault).
 *
 * Lower severity than the password forms (no credential is leaked), so the
 * cheap-to-render forms get a real render assertion and the fixture-heavy
 * admin financial forms (invoice / credit-note / event-fee / settings) get
 * a source-level invariant assertion — the attribute IS the security
 * control, so a literal-source check is a faithful regression guard and
 * avoids 200+ lines of brittle prop fixtures. Mirrors the repo's existing
 * `check:*` source-invariant gates.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { InviteColleagueForm } from '@/components/members/invite-colleague-form';
import { MemberForm } from '@/components/members/member-form';
import { PaymentForm } from '@/app/(staff)/admin/invoices/_components/payment-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// tests/setup.ts installs global fake timers; RHF + RTL effects need real.
beforeEach(() => {
  vi.useRealTimers();
});

function formMethodOf(ui: React.ReactElement): string | null {
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
  const form = container.querySelector('form');
  if (!form) throw new Error('form did not render');
  return form.getAttribute('method');
}

describe('PII forms declare method="post" — rendered (CWE-598)', () => {
  it('ForgotPasswordForm posts (keeps the email out of the URL)', () => {
    expect(formMethodOf(<ForgotPasswordForm />)).toBe('post');
  });

  it('InviteColleagueForm posts (keeps colleague email/name out of the URL)', () => {
    expect(formMethodOf(<InviteColleagueForm />)).toBe('post');
  });

  it('MemberForm posts (keeps member PII out of the URL)', () => {
    expect(
      formMethodOf(
        <MemberForm
          plans={[]}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
        />,
      ),
    ).toBe('post');
  });

  it('PaymentForm posts (keeps invoice/payment data out of the URL)', () => {
    expect(
      formMethodOf(
        <PaymentForm
          invoiceId="11111111-1111-4111-8111-111111111111"
          documentNumber="SC-2026-000048"
          issueDate={null}
          todayIso="2026-06-22"
        />,
      ),
    ).toBe('post');
  });
});

/**
 * Fixture-heavy admin financial forms — assert the source declares the
 * `method="post"` attribute. We strip `//`-comment lines first so the
 * doc-comments that mention the attribute can't produce a false positive,
 * and so we avoid a `<form ...>` tag regex (which breaks on an arrow
 * function `onSubmit={(e) => …}` — the `>` ends the match early).
 */
function hasPostAttribute(relPath: string): boolean {
  const src = readFileSync(resolve(process.cwd(), relPath), 'utf8');
  const codeOnly = src
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return codeOnly.includes('method="post"');
}
const SOURCE_INVARIANT_FORMS: ReadonlyArray<readonly [string, string]> = [
  ['PortalEditForm', 'src/components/members/portal-edit-form.tsx'],
  // Renders its <form> behind a DialogTrigger, so a source-level check is the
  // faithful guard (audit XF-03 — it collects contact name/email/phone PII).
  ['ContactFormDialog', 'src/components/members/contact-form-dialog.tsx'],
  ['InvoiceSettingsForm', 'src/components/invoices/invoice-settings-form.tsx'],
  [
    'InvoiceForm',
    'src/app/(staff)/admin/invoices/_components/invoice-form.tsx',
  ],
  [
    'EventFeeForm',
    'src/app/(staff)/admin/invoices/new/_components/event-fee-form.tsx',
  ],
  [
    'CreditNoteForm',
    'src/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/_components/credit-note-form.tsx',
  ],
];

describe('PII/financial forms declare method="post" — source invariant (CWE-598)', () => {
  it.each(SOURCE_INVARIANT_FORMS)(
    '%s <form> declares method="post"',
    (_name, relPath) => {
      expect(
        hasPostAttribute(relPath),
        `expected a method="post" attribute in ${relPath}`,
      ).toBe(true);
    },
  );
});
