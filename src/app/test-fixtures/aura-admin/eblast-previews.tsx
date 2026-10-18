/**
 * 122 US12a (T1208) — preview bodies for the E-Blast settings, template and
 * marketing-audience screens, rendered with fixtures in the staff frame.
 * Each mirrors its page's markup around the real components; the pages keep
 * the guards and the reads.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { FormContainer, TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shell/empty-state';
import { LayoutTemplate } from 'lucide-react';
import {
  AdminTemplateLibrary,
  type TemplateLibraryRow,
} from '@/components/broadcast/admin/template-library';
import { AdminTemplateForm } from '@/components/broadcast/admin/template-form';
import { AdminTemplateEditConfirmStarter } from '@/components/broadcast/admin/template-edit-confirm-starter';
import { AdminImageAllowlistEditor } from '@/components/broadcast/admin-image-allowlist-editor';
import { BrandSettingsForm } from '@/components/broadcast/brand/brand-settings-form';
import type { BrandSettingsView } from '@/modules/broadcasts';
import type { AudienceTableRow } from '@/app/(staff)/admin/marketing/audience/_components/audience-table';
import { AudienceFrame, AudienceResults } from '@/app/(staff)/admin/marketing/audience/_components/audience-view';

const TEMPLATE_ROWS: readonly TemplateLibraryRow[] = [
  { id: 't1', name: 'Monthly Newsletter', subjectPreview: '{{chamber_name}} Monthly Newsletter — [Month YYYY]', locale: 'en', startedFromCount: 11, isSeeded: true, updatedAtIso: '2026-03-02T03:00:00Z' },
  { id: 't2', name: 'จดหมายข่าวประจำเดือน', subjectPreview: 'จดหมายข่าวประจำเดือน {{chamber_name}} — [เดือน พ.ศ. YYYY]', locale: 'th', startedFromCount: 2, isSeeded: true, updatedAtIso: '2026-03-02T03:00:00Z' },
  { id: 't3', name: 'Månadsbrev', subjectPreview: '{{chamber_name}} Månadsbrev — [Månad ÅÅÅÅ]', locale: 'sv', startedFromCount: 0, isSeeded: true, updatedAtIso: '2026-03-02T03:00:00Z' },
  { id: 't4', name: 'Event Invitation', subjectPreview: "You're invited: [event name]", locale: 'en', startedFromCount: 14, isSeeded: true, updatedAtIso: '2026-03-02T03:00:00Z' },
  { id: 't5', name: 'Job opening', subjectPreview: 'We are hiring: [role], [city]', locale: 'en', startedFromCount: 5, isSeeded: false, updatedAtIso: '2026-08-18T03:00:00Z' },
  { id: 't6', name: 'Seminar invitation', subjectPreview: '{{chamber_name}} seminar: [topic]', locale: 'en', startedFromCount: 2, isSeeded: false, updatedAtIso: '2026-09-09T03:00:00Z' },
];

/** `?view=templates` (`state=empty` for none, `state=starters` for no admin-authored rows). */
export async function renderTemplatesPreview(state: string | undefined) {
  const t = await getTranslations('admin.broadcasts.templates');
  const rows = state === 'empty' ? [] : state === 'starters' ? TEMPLATE_ROWS.filter((r) => r.isSeeded) : TEMPLATE_ROWS;
  const newLink = (label: string) => (
    <Link href="/admin/broadcasts/templates/new" className={buttonClass({ variant: 'primary' })}>
      {label}
    </Link>
  );
  return (
    <TableContainer>
      <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} actions={newLink(t('newTemplateButton'))} />
      {rows.length === 0 ? (
        <EmptyState
          icon={LayoutTemplate}
          title={t('emptyState.title')}
          description={t('emptyState.body')}
          data-testid="broadcast-templates-empty"
          action={newLink(t('emptyState.cta'))}
        />
      ) : (
        <AdminTemplateLibrary rows={rows} />
      )}
    </TableContainer>
  );
}

/** `?view=template-new` and `?view=template-edit` (a starter, so the edit banner shows). */
export async function renderTemplateFormPreview(mode: 'new' | 'edit') {
  const t = await getTranslations('admin.broadcasts.templates');
  if (mode === 'new') {
    return (
      <FormContainer>
        <PageHeader title={t('newPageTitle')} subtitle={t('newPageDescription')} />
        <Card title={t('newPageTitle')} description={t('newPageDescription')} headingLevel={2}>
          <AdminTemplateForm mode="new" initial={{ name: '', subject: '', bodyHtml: '', locale: 'en' }} />
        </Card>
      </FormContainer>
    );
  }
  return (
    <FormContainer>
      <PageHeader title={t('editPageTitle')} subtitle={t('editPageDescription')} />
      <AdminTemplateEditConfirmStarter templateId="t1" templateName="Monthly Newsletter" />
      <Card title="Monthly Newsletter" description={t('editPageDescription')} headingLevel={2}>
        <AdminTemplateForm
          mode="edit"
          initial={{
            templateId: 't1',
            name: 'Monthly Newsletter',
            subject: '{{chamber_name}} Monthly Newsletter — [Month YYYY]',
            bodyHtml: '<h2>This month at the chamber</h2><p>Dear members, …</p>',
            locale: 'en',
            isSeeded: true,
          }}
        />
      </Card>
    </FormContainer>
  );
}

/** `?view=broadcast-settings` — the image source allowlist (one locked default, two custom). */
export async function renderBroadcastSettingsPreview() {
  const t = await getTranslations('admin.broadcasts.settings');
  const tAllowlist = await getTranslations('admin.broadcasts.settings.allowlist');
  return (
    <FormContainer>
      <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
      <Card title={tAllowlist('heading')} description={tAllowlist('description')} headingLevel={2}>
        <AdminImageAllowlistEditor
          initial={[
            { hostname: 'resend.com', isDefault: true },
            { hostname: 'cdn.swecham.com', isDefault: false },
            { hostname: 'images.lindqvist.example', isDefault: false },
          ]}
        />
      </Card>
    </FormContainer>
  );
}

const BRAND_VIEW: BrandSettingsView = {
  primaryColor: '#10487a',
  postalAddress: '399 Interchange 21, 23rd floor, Sukhumvit Road, Khlong Toei Nuea, Wattana, Bangkok 10110',
  addressMissing: false,
  logo: { url: '/brand/swecham-email-logo.png', source: 'invoice_settings', manageHref: '/admin/settings/invoicing' },
  defaults: { primaryColor: '#10487a' as BrandSettingsView['defaults']['primaryColor'] },
  updatedAt: '2026-09-01T03:00:00Z',
};

/** `?view=brand` (`state=contrast-fail` | `address-missing` | `read-only` — no logo link). */
export async function renderBrandPreview(state: string | undefined) {
  const t = await getTranslations('admin.settings.broadcasts.brand');
  const view: BrandSettingsView =
    state === 'contrast-fail'
      ? { ...BRAND_VIEW, primaryColor: '#f5f5f5' }
      : state === 'address-missing'
        ? { ...BRAND_VIEW, postalAddress: null, addressMissing: true }
        : state === 'read-only'
          ? { ...BRAND_VIEW, logo: { ...BRAND_VIEW.logo, manageHref: null } }
          : BRAND_VIEW;
  return (
    <FormContainer>
      <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
      <BrandSettingsForm initial={view} />
    </FormContainer>
  );
}

const AUDIENCE_ROWS: readonly AudienceTableRow[] = [
  { contactId: 'a1', memberId: 'm-1', companyName: 'Lindqvist & Partners Co., Ltd.', contactName: 'Anna Lindqvist', email: 'anna.lindqvist@lindqvist.example', isPrimary: true, memberStatus: 'active', memberHalted: false, memberErased: false, state: 'on', reasons: [], changedBy: null, changedAt: null },
  { contactId: 'a2', memberId: 'm-2', companyName: 'Siam Nordic Trading Co., Ltd.', contactName: 'Erik Johansson', email: 'erik@siamnordic.example', isPrimary: true, memberStatus: 'active', memberHalted: false, memberErased: false, state: 'on', reasons: [], changedBy: null, changedAt: null },
  { contactId: 'a3', memberId: 'm-2', companyName: 'Siam Nordic Trading Co., Ltd.', contactName: 'Sara Holm', email: 'sara.holm@siamnordic.example', isPrimary: false, memberStatus: 'active', memberHalted: false, memberErased: false, state: 'off_by_staff', reasons: ['off_by_staff'], changedBy: 'Johan Strand', changedAt: '18 Sep 2026, 14:05' },
  { contactId: 'a4', memberId: 'm-3', companyName: 'Andaman Marine Tech Co., Ltd.', contactName: 'Karin Lund', email: 'karin@andamanmarine.example', isPrimary: true, memberStatus: 'active', memberHalted: true, memberErased: false, state: 'on', reasons: ['member_halted'], changedBy: null, changedAt: null },
  { contactId: 'a5', memberId: 'm-4', companyName: 'Bangkok Freight Nordic Co., Ltd.', contactName: 'Somchai Prasert', email: 'somchai@bkkfreight.example', isPrimary: true, memberStatus: 'active', memberHalted: false, memberErased: false, state: 'off_by_contact', reasons: ['off_by_contact'], changedBy: 'The contact', changedAt: '9 Sep 2026, 08:40' },
  { contactId: 'a6', memberId: 'm-5', companyName: 'Scandia Health Partners Ltd.', contactName: 'Nida Thongchai', email: 'nida.t@scandiahealth.example', isPrimary: false, memberStatus: 'active', memberHalted: false, memberErased: false, state: 'unsubscribed', reasons: ['unsubscribed'], changedBy: null, changedAt: null },
];

/** `?view=audience` (`state=degraded` | `manager` | `empty` | `filtered`). */
export async function renderAudiencePreview(state: string | undefined) {
  const canMarketing = state !== 'manager';
  const empty = state === 'empty' || state === 'filtered';
  const rows = empty ? [] : AUDIENCE_ROWS;
  return (
    <TableContainer>
      <AudienceFrame canMarketing={canMarketing} presetActive={false}>
        <AudienceResults
          rows={rows}
          total={empty ? 0 : 164}
          page={1}
          pageSize={50}
          narrowed={state === 'filtered'}
          degraded={state === 'degraded'}
          canMarketing={canMarketing}
          leavesView={false}
        />
      </AudienceFrame>
    </TableContainer>
  );
}
