/**
 * F119 PR-A R7 — every F7 notification email is addressed to a MEMBER, so every
 * link in it must land in the member portal.
 *
 * The recipients, from their enqueue sites: approved / rejected / cancelled go
 * to `broadcast.replyToEmail` (`enqueueBroadcastMemberNotification`), the
 * dispatch failure to the requesting member's primary contact
 * (`enqueueDispatchFailureNotification`), the delivery summary to the member
 * (`enqueueDeliverySummaryEmail`). No F7 notification goes to staff. The
 * detail CTA was built as `/admin/broadcasts/{id}`, which sent a member to the
 * staff area (a 403 / sign-in bounce, never their E-Blast).
 */
import { describe, expect, it } from 'vitest';

import {
  buildBroadcastApprovedEmail,
  buildBroadcastCancelledEmail,
  buildBroadcastDeliveredEmail,
  buildBroadcastFailedToDispatchEmail,
  buildBroadcastRejectedEmail,
  type BuiltEmail,
} from '@/modules/broadcasts/infrastructure/email/broadcast-notification-emails';

const ID = '11111111-1111-4111-8111-111111111111';

const BUILT: ReadonlyArray<readonly [string, BuiltEmail, string | null]> = [
  [
    'failed_to_dispatch',
    buildBroadcastFailedToDispatchEmail({
      toEmail: 'member@example.test',
      broadcastId: ID,
      broadcastSubject: 'Chamber news',
      tenantDisplayName: 'Test Chamber',
      scheduledFor: '2026-09-07T09:00:00.000Z',
      reason: 'member_halted',
      locale: 'en',
    }),
    `/portal/broadcasts/${ID}`,
  ],
  [
    'approved',
    buildBroadcastApprovedEmail({
      toEmail: 'member@example.test',
      broadcastId: ID,
      broadcastSubject: 'Chamber news',
      memberDisplayName: 'Acme',
      scheduledForIso: '2026-09-07T09:00:00.000Z',
      locale: 'en',
    }),
    `/portal/broadcasts/${ID}`,
  ],
  [
    'rejected',
    buildBroadcastRejectedEmail({
      toEmail: 'member@example.test',
      broadcastId: ID,
      broadcastSubject: 'Chamber news',
      memberDisplayName: 'Acme',
      rejectionReason: 'Off-topic',
      locale: 'en',
    }),
    `/portal/broadcasts/${ID}`,
  ],
  [
    'delivered',
    buildBroadcastDeliveredEmail({
      toEmail: 'member@example.test',
      broadcastId: ID,
      broadcastSubject: 'Chamber news',
      delivered: 9,
      bounced: 1,
      complained: 0,
      total: 10,
      deliveryRate: 90,
      locale: 'en',
    }),
    '/portal/benefits',
  ],
  [
    'cancelled',
    buildBroadcastCancelledEmail({
      toEmail: 'member@example.test',
      broadcastId: ID,
      broadcastSubject: 'Chamber news',
      memberDisplayName: 'Acme',
      cancellationReason: null,
      locale: 'en',
    }),
    null,
  ],
];

describe('F7 notification emails link members to the PORTAL, never to /admin', () => {
  it.each(BUILT)('%s: the CTA lands in the member portal', (_name, mail, path) => {
    const hrefs = [...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    if (path === null) {
      expect(hrefs).toEqual([]);
    } else {
      expect(hrefs).toHaveLength(1);
      expect(new URL(hrefs[0] as string).pathname).toBe(path);
      expect(mail.text).toContain(hrefs[0] as string);
    }
    expect(mail.html).not.toContain('/admin/');
    expect(mail.text).not.toContain('/admin/');
  });
});
