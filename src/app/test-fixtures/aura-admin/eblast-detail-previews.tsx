/**
 * 122 US12c-1 (T1228) — preview bodies for the staff E-Blast approval-round
 * detail (boards `Admin-broadcast-review`, `Admin-eblast-start`, `-design`,
 * `-awaiting-member`, `-changes-requested`, `-member-approved`, `-schedule`,
 * `-held`, `-failed`, `Admin-broadcast-sent`, each with `-mobile` where drawn),
 * rendered with fixtures through the page's own view. The page keeps the
 * guards and the reads; the affordance decisions below mirror its rules for
 * each stage, so the preview shows what an admin (or a manager) would get.
 */
import { detailActions } from '@/app/(staff)/admin/broadcasts/[id]/_components/detail-actions';
import { getTranslations } from 'next-intl/server';
import { BroadcastDetailView, type BroadcastDetailViewProps } from '@/app/(staff)/admin/broadcasts/[id]/_components/broadcast-detail-view';
import { AuditTimelineView } from '@/components/broadcast/admin/audit-timeline';
import type { VersionThreadModel } from '@/components/broadcast/approval/version-thread';
import type { PreviewState } from '@/components/broadcast/use-preview-html';
import type { BroadcastStatus, BroadcastVersion } from '@/modules/broadcasts';

const ID = '7d3e2a10-5b4c-4f1e-9a8d-2c6b0e4f1a90';
const NOW = Date.now();
const ago = (hours: number) => new Date(NOW - hours * 3_600_000);
const ahead = (hours: number) => new Date(NOW + hours * 3_600_000);

const DOC = (heading: string) =>
  `<!doctype html><html><body style="margin:0;font-family:Arial,sans-serif;background:#fff;color:#18181b"><div style="padding:16px;border-bottom:1px solid #e4e4e7"><strong style="font-size:14px;color:#666">Thai-Swedish Chamber of Commerce</strong></div><div style="padding:20px 16px;font-size:14px;line-height:1.6"><h2 style="margin:0 0 8px;color:#10487a">${heading}</h2><p>Dear members,</p><p>Join us for the <strong>Nordic Leadership Breakfast</strong> on 15 October at the Anantara Siam. Three Swedish CEOs share how they built their Thai teams.</p></div><div style="padding:14px 16px;border-top:1px solid #e4e4e7;font-size:11px;color:#52525b">You are receiving this email because you are a contact at a member of SweCham. Unsubscribe at any time.</div></body></html>`;
const ready = (heading: string): PreviewState => ({ status: 'ready', html: DOC(heading) }) as PreviewState;

const SUBJECT = 'Nordic Leadership Breakfast — 15 October';

function version(no: number, subject: string, sent: Date | null, note: string | null = null): BroadcastVersion {
  return {
    id: `00000000-0000-4000-8000-00000000000${no}` as never,
    tenantId: 'swecham',
    broadcastId: ID as never,
    versionNo: no,
    subject,
    bodyHtml: '<h2>Nordic Leadership Breakfast</h2><p>Dear members,</p>',
    bodySource: 'formatted',
    noteToMember: note,
    authoredByUserId: 'u1',
    authoredByRole: (no === 0 ? 'member' : 'admin') as never,
    sentToMemberAt: sent,
    createdAt: ago(30),
    updatedAt: ago(2),
  };
}

const at = (d: Date, fmt: Intl.DateTimeFormat) => ({ iso: d.toISOString(), label: fmt.format(d) });

function thread(fmt: Intl.DateTimeFormat, decision: 'none' | 'changes' | 'approved'): VersionThreadModel {
  return {
    original: { id: 'v0', versionNo: 0, subject: SUBJECT, note: null, author: { side: 'member' }, at: at(ago(48), fmt) },
    rounds: [
      {
        round: 1,
        version: {
          id: 'v1',
          versionNo: 1,
          subject: `${SUBJECT} — breakfast at the Anantara`,
          note: 'We moved the date into the heading and shortened the intro.',
          author: { side: 'organisation', name: 'Karin Lindqvist' },
          at: at(ago(26), fmt),
        },
        decisions:
          decision === 'none'
            ? []
            : [
                {
                  id: 'd1',
                  decision: decision === 'changes' ? 'changes_requested' : 'approved',
                  reason: decision === 'changes' ? 'Please add the registration deadline (10 October).' : null,
                  byMe: false,
                  byName: 'Anna Lindqvist',
                  at: at(ago(5), fmt),
                },
              ],
      },
    ],
    approvedAsSubmitted: null,
  } as VersionThreadModel;
}

/** `?view=broadcast-detail&state=review|design|awaiting-member|changes-requested|member-approved|held|failed|sent|manager`. */
export async function renderBroadcastDetailPreview(state: string | undefined) {
  const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  const key = state ?? 'review';
  const manager = key === 'manager';
  const status: BroadcastStatus = (
    {
      review: 'submitted',
      manager: 'in_design',
      design: 'in_design',
      'awaiting-member': 'awaiting_member_approval',
      'changes-requested': 'changes_requested',
      'member-approved': 'member_approved',
      held: 'approved',
      failed: 'failed_to_dispatch',
      sent: 'sent',
    } as Record<string, BroadcastStatus>
  )[key] ?? 'submitted';
  const round = status === 'submitted' || status === 'in_design' ? 0 : 1;
  const v0 = version(0, SUBJECT, null);
  const v1 = version(1, `${SUBJECT} — breakfast at the Anantara`, ago(26), 'We moved the date into the heading and shortened the intro.');
  const working = status === 'in_design' ? version(1, SUBJECT, null) : null;
  const versioned = ['in_design', 'awaiting_member_approval', 'changes_requested', 'member_approved'].includes(status);
  const showWorkspace = !manager && working !== null;
  const shownVersion = working ?? (round >= 1 ? v1 : null);
  const canWrite = !manager;
  // The page's own rules (`detail-actions.ts`), so the preview shows what the page shows.
  const actions = detailActions({ status, round, canWrite, canSend: canWrite, memberApprovalOn: true, bodyRenderFailed: false });

  const props: BroadcastDetailViewProps = {
    broadcastId: ID,
    broadcast: {
      subject: SUBJECT,
      stageEnteredAt: ago(key === 'held' ? 30 : 2),
      proposedSendAt: ahead(36),
      scheduledFor: status === 'approved' ? ago(1) : status === 'sent' ? ago(20) : null,
      submittedAt: ago(48),
      actorRole: 'member_self_service',
      segmentType: 'all_members',
      estimatedRecipientCount: 130,
    },
    status,
    round,
    memberDisplayName: 'Lindqvist & Partners Co., Ltd.',
    fmt,
    isReadOnlyManager: manager,
    failure: status === 'failed_to_dispatch' ? { tone: 'danger', text: 'The email service refused the send. Nothing reached the recipients.' } : null,
    dispatchHeld: key === 'held',
    threadUnavailable: false,
    versionedStage: versioned,
    showNoPortalUser: false,
    unsafeImages: [],
    turn: status === 'awaiting_member_approval' ? 'member' : ['submitted', 'in_design', 'changes_requested', 'member_approved'].includes(status) ? 'marketing' : null,
    memberApprovalOn: true,
    memberFeedback:
      status === 'changes_requested'
        ? { title: 'Anna Lindqvist asked for changes to version 1', reason: 'Please add the registration deadline (10 October).' }
        : null,
    showWorkspace,
    workingCopy: working,
    original: round >= 1 || working !== null ? v0 : null,
    originalPreview: round >= 1 || working !== null ? ready('Nordic Leadership Breakfast') : null,
    shownVersion,
    shownPreview: shownVersion !== null && !showWorkspace ? ready('Nordic Leadership Breakfast — 15 October') : null,
    previewState: ready('Nordic Leadership Breakfast'),
    bodyRenderFailed: false,
    delivery:
      status === 'sent'
        ? { delivered: 121, bounced: 3, softBounced: 2, complained: 0, recipients: 126 }
        : status === 'failed_to_dispatch'
          ? { delivered: 0, bounced: 0, softBounced: 0, complained: 0, recipients: 0 }
          : null,
    imagesEnabled: true,
    threadModel: round >= 1 ? thread(fmt, status === 'changes_requested' ? 'changes' : status === 'awaiting_member_approval' ? 'none' : 'approved') : null,
    audit: await auditFixture(status, round, fmt),
    ...actions,
  };
  return BroadcastDetailView(props);
}

/** The lifecycle rows the audit log would hold for each stage (the real page reads them). */
async function auditFixture(status: BroadcastStatus, round: number, fmt: Intl.DateTimeFormat): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.review.audit');
  const member = t('actorBy', { actor: 'anna.lindqvist@lindqvist.example' });
  const staff = t('actorBy', { actor: 'malin.berg@swecham.example' });
  const system = t('actorBy', { actor: t('actorSystem') });
  const rows: Array<[string, number, string]> = [
    ['drafted', 50, member],
    ['submitted', 48, member],
  ];
  // A round never logs "Approved" (approve-as-submitted only): the member's
  // approval and marketing's send-time confirmation are its steps, timed
  // after the thread fixture's member approval (5 h ago).
  if (status === 'sent' || status === 'sending' || status === 'failed_to_dispatch') {
    if (round >= 1) rows.push(['memberApproved', 5, member], ['scheduleConfirmed', 3, staff]);
    else rows.push(['approved', 20, staff]);
    rows.push(['sendStarted', 1, system]);
  }
  if (status === 'sent') rows.push(['sent', 0.9, system]);
  if (status === 'failed_to_dispatch') rows.push(['failedToDispatch', 0.9, system]);
  return (
    <AuditTimelineView
      title={t('title')}
      events={rows.map(([key, hours, actor]) => {
        const at = ago(hours);
        return { key, label: t(key), instant: at.toISOString(), when: fmt.format(at), actor, actorId: 'u1' };
      })}
    />
  );
}
