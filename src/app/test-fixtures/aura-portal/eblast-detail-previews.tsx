/**
 * 122 US12c-2 (T1246) — preview bodies for the member's E-Blast detail
 * (boards `Portal-broadcast-detail`, `Portal-broadcast-cancel`,
 * `Portal-eblast-approval`, `-approved`, `-scheduled`, `-expired`, each with
 * `-mobile` where drawn), rendered with fixtures through the page's own view.
 * The page keeps the guards and the reads; the decision flags below mirror its
 * rules for each stage, so the preview shows what a member would get.
 */
import {
  PortalBroadcastDetailView,
  type PortalBroadcastDetailViewProps,
} from '@/app/(member)/portal/broadcasts/[id]/_components/portal-broadcast-detail-view';
import type { VersionThreadModel } from '@/components/broadcast/approval/version-thread';
import type { PreviewState } from '@/components/broadcast/use-preview-html';
import type { BroadcastStatus } from '@/modules/broadcasts';

const ID = '7d3e2a10-5b4c-4f1e-9a8d-2c6b0e4f1a90';
const NOW = Date.now();
const ago = (hours: number) => new Date(NOW - hours * 3_600_000);
const ahead = (hours: number) => new Date(NOW + hours * 3_600_000);

const DOC = (heading: string, time: string) =>
  `<!doctype html><html><body style="margin:0;font-family:Arial,sans-serif;background:#fff;color:#18181b"><div style="padding:16px;border-bottom:1px solid #e4e4e7"><strong style="font-size:14px;color:#666">Thai-Swedish Chamber of Commerce</strong></div><div style="padding:20px 16px;font-size:14px;line-height:1.6"><h2 style="margin:0 0 8px;color:#10487a">${heading}</h2><p>Dear members,</p><p>Join us for the <strong>Nordic Leadership Breakfast</strong> at the Anantara Siam, ${time}. Three Swedish CEOs share how they built their Thai teams.</p><p><span style="display:inline-block;padding:8px 16px;border-radius:6px;background:#10487a;color:#fff;font-weight:600">Reserve your seat</span></p></div><div style="padding:14px 16px;border-top:1px solid #e4e4e7;font-size:11px;color:#52525b">You are receiving this email because you are a contact at a member of SweCham. Unsubscribe from these broadcasts at any time.</div></body></html>`;
const ready = (heading: string, time = '07:30–09:30'): PreviewState =>
  ({ status: 'ready', html: DOC(heading, time) }) as PreviewState;

const SUBJECT = 'Nordic Leadership Breakfast — 15 October';
const FORMATTED = 'Nordic Leadership Breakfast — Wednesday 15 October';

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
          subject: FORMATTED,
          note: 'We added the time and venue to the heading and moved the button up. Please check the date.',
          author: { side: 'organisation', name: null },
          at: at(ago(26), fmt),
        },
        decisions:
          decision === 'none'
            ? []
            : [
                {
                  id: 'd1',
                  decision: decision === 'changes' ? 'changes_requested' : 'approved',
                  reason:
                    decision === 'changes'
                      ? 'The breakfast starts at 07:00, not 07:30 — please fix the time. Otherwise it looks great.'
                      : 'Thanks — perfect.',
                  byMe: true,
                  byName: null,
                  at: at(ago(5), fmt),
                },
              ],
      },
    ],
    approvedAsSubmitted: null,
  } as VersionThreadModel;
}

/**
 * `?view=broadcast-detail&state=awaiting|changes-requested|approved|scheduled|sent|expired|submitted|thread-unavailable`.
 */
export async function renderPortalBroadcastDetailPreview(state: string | undefined): Promise<React.ReactElement> {
  const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  const f = (d: Date) => fmt.format(d);

  const stage = state ?? 'awaiting';
  const status: BroadcastStatus = (
    {
      awaiting: 'awaiting_member_approval',
      'changes-requested': 'changes_requested',
      approved: 'member_approved',
      scheduled: 'approved',
      sent: 'sent',
      expired: 'expired_no_member_response',
      submitted: 'submitted',
      'thread-unavailable': 'awaiting_member_approval',
    } as const
  )[stage as 'awaiting'] ?? 'awaiting_member_approval';

  const round = stage === 'submitted' || stage === 'sent' || stage === 'thread-unavailable' ? 0 : 1;
  const decision = stage === 'changes-requested' ? 'changes' : stage === 'approved' || stage === 'scheduled' ? 'approved' : 'none';
  const awaiting = stage === 'awaiting';
  const canWithdrawEblast = ['awaiting', 'changes-requested', 'approved', 'scheduled', 'submitted'].includes(stage);

  const props: PortalBroadcastDetailViewProps = {
    back: { href: '/portal/benefits?tab=broadcasts', toDashboard: false },
    status,
    turn: awaiting ? { kind: 'member', version: 1 } : stage === 'changes-requested' || stage === 'approved' || stage === 'submitted' ? { kind: 'marketing' } : null,
    expiresAt: awaiting ? f(ahead(24 * 29)) : null,
    threadUnavailable: stage === 'thread-unavailable',
    subject: stage === 'sent' ? 'New office on Wireless Road' : SUBJECT,
    fields: {
      recipients: stage === 'sent' ? 126 : 130,
      submittedAt: f(ago(48)),
      sentAt: stage === 'sent' ? f(ago(2)) : null,
      sendTimes:
        stage === 'thread-unavailable'
          ? null
          : { proposed: stage === 'sent' ? null : f(ahead(72)), confirmed: stage === 'scheduled' || stage === 'sent' ? f(ahead(stage === 'sent' ? -2 : 71)) : null },
    },
    compare:
      round >= 1
        ? {
            formatted: {
              versionNo: 1,
              noteToMember: 'We added the time and venue to the heading and moved the button up. Please check the date.',
              subject: FORMATTED,
              preview: ready(FORMATTED),
            },
            original: { subject: SUBJECT, preview: ready(SUBJECT, 'on 15 October') },
          }
        : null,
    body: round >= 1 || stage === 'thread-unavailable' ? null : ready(stage === 'sent' ? 'We have moved' : SUBJECT, 'on 15 October'),
    signOff:
      awaiting || stage === 'approved' || stage === 'scheduled' || canWithdrawEblast
        ? {
            broadcastId: ID,
            subject: SUBJECT,
            version: round >= 1 ? { id: 'v1', versionNo: 1 } : null,
            canDecide: awaiting,
            canWithdrawApproval: stage === 'approved' || stage === 'scheduled',
            canWithdrawEblast,
          }
        : null,
    thread:
      round >= 1
        ? thread(fmt, decision)
        : stage === 'sent'
          ? // Approved as submitted, as board `Portal-broadcast-detail` draws it.
            { original: null, rounds: [], approvedAsSubmitted: { at: at(ago(30), fmt), author: { side: 'organisation', name: null } } }
          : null,
    delivery:
      stage === 'sent' ? { delivered: 121, bounced: 3, softBounced: 2, complained: 0, sent: 0, total: 126 } : null,
  };

  return PortalBroadcastDetailView(props);
}
