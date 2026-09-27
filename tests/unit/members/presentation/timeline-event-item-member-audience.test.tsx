/**
 * Spec 122 US3 — the portal timeline names audit rows in the member's words.
 *
 * `audit.eventType.*` is the staff audit catalogue ("Member change request
 * submitted", "Risk band changed"); a member reading their own activity got
 * those raw staff names. Portal surfaces pass `audience="member"`, which reads
 * `timeline.memberAudit.*` first and falls back to the staff catalogue for a
 * type that has no member wording. Staff surfaces are unchanged.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';
import { TimelineEventItem, type TimelineItemProps } from '@/components/members/timeline-event-item';
import { TimelineStream } from '@/components/members/timeline-stream';
import { RecentActivityList } from '@/app/(member)/portal/_components/recent-activity-list';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const row = (eventType: string, id = eventType): TimelineItemProps => ({
  id,
  timestamp: '2026-06-01T03:00:00.000Z',
  source: 'audit',
  eventType,
  actorKind: 'staff',
  actorUserId: '',
  actorDisplayName: null,
  payload: null,
});

function withIntl(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  );
}

describe('<TimelineEventItem> audience', () => {
  afterEach(cleanup);

  it('names an audit row in the member wording when the audience is the member', () => {
    withIntl(<TimelineEventItem {...row('at_risk_score_threshold_crossed')} audience="member" />);
    expect(screen.getByText('Membership health status changed')).toBeInTheDocument();
    expect(screen.queryByText('Risk band changed')).toBeNull();
  });

  it('falls back to the staff catalogue for a type with no member wording', () => {
    withIntl(<TimelineEventItem {...row('cron_bearer_auth_rejected')} audience="member" />);
    expect(screen.getByText(enMessages.audit.eventType.cron_bearer_auth_rejected)).toBeInTheDocument();
  });

  it('keeps the staff catalogue by default', () => {
    withIntl(<TimelineEventItem {...row('member_change_request_submitted')} />);
    expect(screen.getByText('Member change request submitted')).toBeInTheDocument();
  });

  it('the portal stream and the recent-activity list both use the member wording', () => {
    withIntl(
      <>
        <TimelineStream
          fetchPath="/api/portal/timeline"
          initialEvents={[row('member_change_request_submitted', 'a')]}
          initialCursor={null}
          emptyLabel="Empty"
          listLabel="Activity"
          audience="member"
        />
        <RecentActivityList events={[row('invoice_voided', 'b')]} />
      </>,
    );
    expect(screen.getByText('Change request submitted')).toBeInTheDocument();
    expect(screen.getByText('Invoice cancelled')).toBeInTheDocument();
  });
});

describe('timeline.memberAudit catalogue', () => {
  it.each([
    ['en', enMessages],
    ['th', thMessages],
    ['sv', svMessages],
  ] as const)('%s: every member label names a real audit type', (_locale, messages) => {
    const staff = Object.keys(messages.audit.eventType);
    const member = Object.keys(messages.timeline.memberAudit);
    expect(member.length).toBeGreaterThan(0);
    expect(member.filter((k) => !staff.includes(k))).toEqual([]);
    expect(member.sort()).toEqual(Object.keys(enMessages.timeline.memberAudit).sort());
  });
});
