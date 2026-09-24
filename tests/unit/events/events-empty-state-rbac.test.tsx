/**
 * `EventsEmptyState` × RBAC — the "no integration" and "no deliveries yet"
 * variants link to `/admin/settings/integrations/eventcreate`, which is
 * gated on `settings.integrations`. Manager and marketing both read the
 * events list (`events.read`) but lack that key, so they hit a 404. The
 * CTAs must follow the SAME evaluated permission as their target page and
 * fall back to a plain hint otherwise.
 *
 * The permission comes from the evaluator, never from `ROLE_BUNDLES`.
 *
 * `vi.useRealTimers()` — the shared harness installs fake timers that hang
 * React rendering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { EventsEmptyState } from '@/app/(staff)/admin/events/_components/events-empty-state';
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';

beforeEach(() => vi.useRealTimers());

const copy = en.admin.events.list.emptyState;

type Role = 'manager' | 'marketing' | 'admin';

function renderAs(
  role: Role,
  emptyContext: { integrationConfigured: boolean; everReceivedDelivery: boolean },
) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <EventsEmptyState
        emptyContext={{ ...emptyContext, totalArchived: 0 }}
        hasFilters={false}
        canManageIntegration={hasPermission(role, 'settings.integrations')}
      />
    </NextIntlClientProvider>,
  );
}

const NO_INTEGRATION = { integrationConfigured: false, everReceivedDelivery: false };
const NO_DELIVERIES = { integrationConfigured: true, everReceivedDelivery: false };

describe('EventsEmptyState × settings.integrations — no integration configured', () => {
  it.each<Role>(['manager', 'marketing'])(
    '%s: no "Set up EventCreate integration" link — shows the admin-only hint',
    (role) => {
      renderAs(role, NO_INTEGRATION);
      expect(
        screen.queryByRole('link', { name: copy.noIntegration.cta }),
      ).toBeNull();
      expect(
        screen.getByText(copy.noIntegration.adminOnlyHint),
      ).toBeInTheDocument();
    },
  );

  it('admin: the CTA links to the EventCreate settings and no hint is shown', () => {
    renderAs('admin', NO_INTEGRATION);
    expect(
      screen.getByRole('link', { name: copy.noIntegration.cta }),
    ).toHaveAttribute('href', '/admin/settings/integrations/eventcreate');
    expect(screen.queryByText(copy.noIntegration.adminOnlyHint)).toBeNull();
  });
});

describe('EventsEmptyState × settings.integrations — waiting for first delivery', () => {
  it.each<Role>(['manager', 'marketing'])(
    '%s: neither integration link renders — shows the admin-only hint',
    (role) => {
      renderAs(role, NO_DELIVERIES);
      expect(
        screen.queryByRole('link', { name: copy.noDeliveries.primaryCta }),
      ).toBeNull();
      expect(
        screen.queryByRole('link', { name: copy.noDeliveries.cta }),
      ).toBeNull();
      expect(
        screen.getByText(copy.noDeliveries.adminOnlyHint),
      ).toBeInTheDocument();
    },
  );

  it('admin: both integration links render and no hint is shown', () => {
    renderAs('admin', NO_DELIVERIES);
    expect(
      screen.getByRole('link', { name: copy.noDeliveries.primaryCta }),
    ).toHaveAttribute('href', '/admin/settings/integrations/eventcreate#test');
    expect(
      screen.getByRole('link', { name: copy.noDeliveries.cta }),
    ).toHaveAttribute('href', '/admin/settings/integrations/eventcreate');
    expect(screen.queryByText(copy.noDeliveries.adminOnlyHint)).toBeNull();
  });
});
