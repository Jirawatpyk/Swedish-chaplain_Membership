/**
 * `/admin/broadcasts/templates/[id]/edit` registers the template's name as
 * the breadcrumb label for the id segment, so the trail reads
 * "Broadcasts / Templates / <name> / Edit Template" instead of a raw UUID.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  BreadcrumbProvider,
  useBreadcrumbLabelMap,
} from '@/components/layout/breadcrumb-provider';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('@/lib/rbac', () => ({
  requirePagePermission: vi.fn().mockResolvedValue({
    user: { id: 'staff-1', email: 'staff@example.com', role: 'admin' },
  }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 't1' }),
}));
vi.mock('@/lib/db', () => ({
  runInTenant: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@/modules/broadcasts', () => ({
  isF71aUs7Enabled: () => true,
  f7AuditAdapter: {},
}));
vi.mock('@/modules/broadcasts/application/use-cases/_safe-audit-emit', () => ({
  safeAuditEmit: vi.fn(),
}));
vi.mock('@/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo', () => ({
  makeDrizzleBroadcastTemplatesRepo: () => ({
    findById: vi.fn().mockResolvedValue({
      id: TEMPLATE_ID,
      name: 'Welcome email',
      subject: 'Hello',
      bodyHtml: '<p>Hi</p>',
      locale: 'en',
      isSeeded: false,
    }),
  }),
}));
vi.mock('@/components/broadcast/admin/template-form', () => ({
  AdminTemplateForm: () => null,
}));
vi.mock('@/components/broadcast/admin/template-edit-confirm-starter', () => ({
  AdminTemplateEditConfirmStarter: () => null,
}));

const TEMPLATE_ID = vi.hoisted(() => '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a');

import AdminBroadcastEditTemplatePage from '@/app/(staff)/admin/broadcasts/templates/[id]/edit/page';

function LabelProbe(): React.JSX.Element {
  const labels = useBreadcrumbLabelMap();
  return <output data-testid="crumb-label">{labels.get(TEMPLATE_ID) ?? ''}</output>;
}

describe('Template editor page — breadcrumb label', () => {
  it('registers the template name for the id segment', async () => {
    const ui = await AdminBroadcastEditTemplatePage({
      params: Promise.resolve({ id: TEMPLATE_ID }),
    });
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BreadcrumbProvider>
          {ui}
          <LabelProbe />
        </BreadcrumbProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('crumb-label')).toHaveTextContent('Welcome email');
  });
});
