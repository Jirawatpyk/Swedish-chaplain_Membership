/**
 * `AtRiskWidget` × RBAC — the per-row Snooze action posts to
 * `/api/admin/renewals/at-risk/[memberId]/snooze`, gated on
 * `renewals.write`. The widget used to decide from a role literal the page
 * projected (`role === 'manager' ? 'manager' : 'admin'`), which answers
 * wrongly for any role that is neither — a future read-only role would have
 * been handed the admin variant. The gate is now the evaluated permission.
 *
 * `vi.useRealTimers()` — the shared harness installs fake timers that hang
 * React rendering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { AtRiskWidget } from '@/app/(staff)/admin/renewals/_components/at-risk-widget';
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';

const RESPONSE = {
  items: [
    {
      member_id: '00000000-0000-4000-8000-000000000001',
      company_name: 'Acme AB',
      risk_score: 72,
      risk_score_band: 'at-risk',
      risk_score_last_computed_at: '2026-09-01T00:00:00.000Z',
      risk_snoozed_until: null,
    },
  ],
  next_cursor: null,
  summary: { warning: 0, 'at-risk': 1, critical: 0, f6_active: true, active_max: 100 },
};

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(RESPONSE), { status: 200 })),
  );
});

afterEach(() => vi.unstubAllGlobals());

type Role = 'manager' | 'admin' | 'super_admin';

function renderAs(role: Role) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AtRiskWidget canSnooze={hasPermission(role, 'renewals.write')} />
    </NextIntlClientProvider>,
  );
}

const snoozeLabel = 'Snooze Acme AB';

describe('AtRiskWidget snooze × renewals.write', () => {
  it('manager: the row renders without a Snooze action', async () => {
    renderAs('manager');
    expect(await screen.findByText('Acme AB')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: snoozeLabel })).toBeNull();
  });

  it.each<Role>(['admin', 'super_admin'])(
    '%s: the row carries the Snooze action',
    async (role) => {
      renderAs(role);
      expect(
        await screen.findByRole('button', { name: snoozeLabel }),
      ).toBeInTheDocument();
    },
  );
});
