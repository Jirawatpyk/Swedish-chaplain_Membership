/**
 * 122 US12a (T1208) — preview bodies for the E-Blast settings, template and
 * marketing-audience screens (US12b, T1219: and the review queue), rendered with fixtures in the staff frame.
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
import { keepTermTogether } from '@/components/broadcast/keep-term-together';
import { QueueTable } from '@/components/broadcast/admin/queue-table';
import { QueueFilters } from '@/components/broadcast/admin/queue-filters';
import { SlaBanner, type SlaStats } from '@/components/broadcast/admin/sla-banner';
import { OverdueBanner } from '@/components/broadcast/admin/overdue-banner';
import { HaltStateBanner } from '@/components/broadcast/admin/halt-state-banner';
import { HaltStateUnavailableBanner } from '@/components/broadcast/admin/halt-state-unavailable-banner';
import { ManagerReadonlyBanner } from '@/components/broadcast/admin/manager-readonly-banner';
import type { AdminQueueItem } from '@/lib/admin-broadcast-queue';
import type { BroadcastStatus } from '@/modules/broadcasts';

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
      <FormContainer align="start">
        <PageHeader title={t('newPageTitle')} subtitle={t('newPageDescription')} />
        <Card>
          <AdminTemplateForm mode="new" initial={{ name: '', subject: '', bodyHtml: '', locale: 'en' }} />
        </Card>
      </FormContainer>
    );
  }
  return (
    <FormContainer align="start">
      <PageHeader title={t('editPageTitle')} subtitle={t('editPageDescription')} />
      <AdminTemplateEditConfirmStarter templateId="t1" templateName="Monthly Newsletter" />
      <Card title="Monthly Newsletter" headingLevel={2}>
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
    <FormContainer align="start">
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
    <FormContainer align="start">
      <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
      <BrandSettingsForm initial={view} tenantDisplayName="Thai-Swedish Chamber of Commerce" />
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

/** 122 US12b (T1219) — the review queue's fixture rows, ages relative to now. */
function queueRows(): readonly AdminQueueItem[] {
  const HOUR = 3_600_000;
  const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
  const row = (over: Partial<AdminQueueItem> & Pick<AdminQueueItem, 'broadcastId' | 'subject' | 'status'>): AdminQueueItem => ({
    stage: 'awaiting_marketing_review',
    whoseTurn: 'marketing',
    requestedByMemberId: 'm1',
    requestedByMemberDisplayName: 'Scandinavian Design Co., Ltd.',
    actorRole: 'member_self_service',
    segmentType: 'all_members',
    estimatedRecipientCount: 412,
    submittedAt: ago(3),
    createdAt: ago(30),
    stageEnteredAt: ago(3),
    currentRound: 0,
    proposedSendAt: null,
    confirmedSendAt: null,
    delivery: null,
    ...over,
  });
  return [
    row({ broadcastId: 'b1', subject: 'Midsommar networking evening — save the date', status: 'submitted', stageEnteredAt: ago(52), submittedAt: ago(52) }),
    row({ broadcastId: 'b2', subject: 'New office in Chiang Mai: open house 14 November', status: 'submitted', requestedByMemberDisplayName: 'Nordic Timber (Thailand) Ltd.', segmentType: 'tier', estimatedRecipientCount: 88, stageEnteredAt: ago(30), submittedAt: ago(30) }),
    row({ broadcastId: 'b3', subject: 'Sustainability seminar recap and slides', status: 'submitted', requestedByMemberDisplayName: 'Thai-Swedish Chamber of Commerce', actorRole: 'admin_proxy', estimatedRecipientCount: 1042, stageEnteredAt: ago(4), submittedAt: ago(4) }),
    row({ broadcastId: 'b4', subject: 'Job opening: logistics coordinator, Bangkok', status: 'awaiting_member_approval', stage: 'awaiting_member_approval', whoseTurn: 'member', requestedByMemberDisplayName: 'Volvo Cars (Thailand) Co., Ltd.', segmentType: 'event_attendees_last_90d', estimatedRecipientCount: 156, stageEnteredAt: ago(20), currentRound: 1 }),
    row({ broadcastId: 'b5', subject: 'Lucia concert tickets now on sale', status: 'approved', stage: 'scheduled', whoseTurn: null, estimatedRecipientCount: 980, stageEnteredAt: ago(10), confirmedSendAt: ago(-48) }),
    row({ broadcastId: 'b6', subject: 'September member newsletter', status: 'sent', stage: 'sent', whoseTurn: null, estimatedRecipientCount: 40, stageEnteredAt: ago(200), delivery: { recipients: 40, delivered: 37, bounced: 2, complained: 1 } }),
  ];
}

const QUEUE_MEMBERS = [
  { memberId: 'm1', displayName: 'Nordic Timber (Thailand) Ltd.' },
  { memberId: 'm2', displayName: 'Scandinavian Design Co., Ltd.' },
  { memberId: 'm3', displayName: 'Volvo Cars (Thailand) Co., Ltd.' },
];

const QUEUE_STAGE_COUNTS = {
  draft: 0, submitted: 3, approved: 1, sending: 0, sent: 12, rejected: 2, cancelled: 1,
  failed_to_dispatch: 0, partially_sent: 0, partial_delivery_accepted: 0, in_design: 1,
  awaiting_member_approval: 1, changes_requested: 0, member_approved: 0, expired_no_member_response: 0,
} as const satisfies Record<BroadcastStatus, number>;

/**
 * `?view=broadcasts` — the review queue (boards `Admin-broadcasts` +
 * `-mobile`). `state=empty` (`Admin-state-broadcasts-empty`), `manager`
 * (`-manager`, read-only), `halted` (a halted member), `halt-unavailable`,
 * `overdue` (the overdue count and a red SLA). Mirrors the page's markup
 * around the real components; the page keeps the guards and the reads.
 */
export async function renderQueuePreview(state: string | undefined) {
  const t = await getTranslations('admin.broadcasts.queue');
  const tBroadcasts = await getTranslations('admin.broadcasts');
  const readOnly = state === 'manager';
  const rows = state === 'empty' ? [] : queueRows();
  const overdue = state === 'overdue' ? 2 : 0;
  const slaStats: SlaStats =
    state === 'overdue'
      ? { targetSlaHours: 48, medianTimeToDecisionHours: 31, p95TimeToDecisionHours: 61, decisionCount: 14, bannerSeverity: 'red' }
      : { targetSlaHours: 48, medianTimeToDecisionHours: 9, p95TimeToDecisionHours: 30, decisionCount: 14, bannerSeverity: 'green' };
  const halted =
    state === 'halted'
      ? [{ memberId: 'm2', displayName: 'Scandinavian Design Co., Ltd.', haltedSinceAt: new Date('2026-10-12T02:00:00Z') }]
      : [];
  const pending = rows.filter((r) => r.status === 'submitted').length;
  return (
    <TableContainer>
      <PageHeader
        title={keepTermTogether(t('title'))}
        subtitle={pending > 0 ? `${t('subtitle')} · ${t('totalPending', { count: pending })}` : t('subtitle')}
        actions={
          <>
            <Link href="/admin/broadcasts/templates" className={buttonClass({ variant: 'secondary', touchHeight: true })}>
              {t('templatesEntryButton')}
            </Link>
            {!readOnly ? (
              <Link href="/admin/broadcasts/new" className={buttonClass({ variant: 'primary', touchHeight: true })}>
                {tBroadcasts('proxySubmitButton')}
              </Link>
            ) : null}
          </>
        }
      />
      <OverdueBanner count={overdue} />
      <SlaBanner stats={slaStats} compact={overdue > 0} />
      {state === 'halt-unavailable' ? <HaltStateUnavailableBanner /> : <HaltStateBanner halted={halted} readOnly={readOnly} />}
      {readOnly ? <ManagerReadonlyBanner /> : null}
      <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
        <div className="flex flex-col gap-[var(--aura-space-4)]">
          <QueueFilters memberOptions={QUEUE_MEMBERS} stageCounts={QUEUE_STAGE_COUNTS} approvalRoundEnabled />
          <QueueTable
            rows={rows}
            readOnly={readOnly}
            haltUnknown={state === 'halt-unavailable'}
            order="longest_in_stage"
            viewTotal={rows.length}
            viewKey={state ?? 'default'}
          />
        </div>
      </Card>
    </TableContainer>
  );
}
