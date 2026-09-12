/**
 * F114 review round 1 (P-4) — an ERASED address group renders as the sentinel,
 * not as "(empty)". The scrub writes the `[erased]` string for every key (an
 * address group included) and the row parser accepts it; the two value
 * renderers must show it as text instead of treating a non-object under an
 * address key as an empty address — otherwise the queue / history read as
 * "the member proposed to clear the address".
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { ChangeRequestFieldView } from '@/lib/change-request-portal-view';
import { ChangeRequestDiffTable } from '@/components/members/change-requests/change-request-diff-table';
import { ProposedValueDisplay } from '@/components/members/change-requests/proposed-value-display';

const ERASED = '[erased]';

function erasedField(key: ChangeRequestFieldView['key'], target: ChangeRequestFieldView['target']): ChangeRequestFieldView {
  return { key, target, seen: ERASED, proposed: ERASED, affectsTaxDocuments: false, outcome: 'rejected', appliedAt: null };
}

describe('erased values render as the sentinel (F114 FR-030, review P-4)', () => {
  it('the diff table shows [erased] for a scalar AND for an address group — never "(empty)"', () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ChangeRequestDiffTable fields={[erasedField('phone', 'contact'), erasedField('billing_address', 'member'), erasedField('registered_address', 'member')]} showOutcome />
      </NextIntlClientProvider>,
    );
    const text = container.textContent ?? '';
    expect((text.match(/\[erased\]/g) ?? []).length).toBe(6);
    expect(text).not.toContain(enMessages.portal.changeRequests.diff.empty);
  });

  it('the staff value display shows [erased] for an address group too', () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProposedValueDisplay fieldKey="billing_address" value={ERASED} />
      </NextIntlClientProvider>,
    );
    expect(container.textContent).toContain(ERASED);
    expect(container.textContent).not.toContain(enMessages.portal.changeRequests.diff.empty);
  });
});
