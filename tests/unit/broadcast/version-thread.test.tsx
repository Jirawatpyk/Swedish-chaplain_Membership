// @vitest-environment jsdom
/**
 * F119 T085 (FR-032, FR-007, FR-011) — the version thread both sides read.
 *
 *   - One ordered list with a heading per round, oldest → newest; inside a
 *     round the version comes first and its decisions after it, each decision
 *     attached to the version it concerns (not merely to a round number).
 *   - The PORTAL names authors only as "you" / "the chamber" — never a staff
 *     user (the F114 `organisation` precedent). The component enforces it on
 *     render, so a staff name that reaches it in portal mode still does not
 *     appear; the staff rendering of the same model DOES show the name, which
 *     is the positive control that the assertion can see a name at all.
 *   - An E-Blast approved as submitted shows the single "approved as
 *     submitted" entry instead of an empty list.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  VersionThread,
  hasThreadHistory,
  memberThreadModel,
  type VersionThreadModel,
} from '@/components/broadcast/approval/version-thread';

afterEach(cleanup);

const STAFF_NAME = 'Karin Lindqvist';
const at = (iso: string) => ({ iso, label: `L:${iso}` });

/** Two rounds: v1 (changes requested), v2 (approved). Authored by a NAMED staff user. */
const MODEL: VersionThreadModel = {
  original: {
    id: 'v0',
    versionNo: 0,
    subject: 'Original subject',
    note: null,
    author: { side: 'member' },
    at: at('2026-09-01T03:00:00.000Z'),
  },
  rounds: [
    {
      round: 1,
      version: {
        id: 'v1',
        versionNo: 1,
        subject: 'Formatted subject 1',
        note: 'We moved the date up top.',
        author: { side: 'organisation', name: STAFF_NAME },
        at: at('2026-09-02T03:00:00.000Z'),
      },
      decisions: [
        {
          id: 'd1',
          decision: 'changes_requested',
          reason: 'The date is wrong.',
          byMe: true,
          at: at('2026-09-03T03:00:00.000Z'),
        },
      ],
    },
    {
      round: 2,
      version: {
        id: 'v2',
        versionNo: 2,
        subject: 'Formatted subject 2',
        note: null,
        author: { side: 'organisation', name: STAFF_NAME },
        at: at('2026-09-04T03:00:00.000Z'),
      },
      decisions: [
        { id: 'd2', decision: 'approved', reason: null, byMe: true, at: at('2026-09-05T03:00:00.000Z') },
      ],
    },
  ],
  approvedAsSubmitted: null,
};

function renderThread(audience: 'member' | 'staff', model: VersionThreadModel = MODEL) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <VersionThread audience={audience} model={model} />
    </NextIntlClientProvider>,
  );
}

const tPortal = enMessages.portal.broadcasts.approval.thread;

describe('F119 T085 — the version thread', () => {
  it('no staff name appears in the portal rendering', () => {
    renderThread('member');
    const region = screen.getByRole('region', { name: tPortal.title });
    expect(region).not.toHaveTextContent(STAFF_NAME);
    // The chamber is named as the chamber, the member as "you".
    expect(region).toHaveTextContent(tPortal.versionSent.replace('{version}', '1'));
    expect(region).toHaveTextContent(tPortal.submittedByYou);
  });

  it('the staff rendering of the same thread does name the staff author (positive control)', () => {
    renderThread('staff');
    expect(screen.getByRole('region', { name: enMessages.admin.broadcasts.approval.thread.title })).toHaveTextContent(
      STAFF_NAME,
    );
  });

  it('is one ordered list with a heading per round, oldest first, each version before its decision', () => {
    renderThread('member');
    const region = screen.getByRole('region', { name: tPortal.title });
    const list = within(region).getByRole('list');
    expect(list.tagName).toBe('OL');
    const headings = within(list)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      tPortal.original,
      tPortal.round.replace('{round}', '1'),
      tPortal.round.replace('{round}', '2'),
    ]);

    const text = region.textContent ?? '';
    const v1 = text.indexOf(tPortal.versionSent.replace('{version}', '1'));
    const d1 = text.indexOf('The date is wrong.');
    const v2 = text.indexOf(tPortal.versionSent.replace('{version}', '2'));
    expect(v1).toBeGreaterThan(-1);
    expect(d1).toBeGreaterThan(v1);
    expect(v2).toBeGreaterThan(d1);
    // Each decision sits under the version it concerns, and ONLY there.
    const [, round1, round2] = within(list).getAllByRole('listitem');
    expect(round1).toHaveTextContent('The date is wrong.');
    expect(round2).not.toHaveTextContent('The date is wrong.');
    expect(round2).toHaveTextContent(tPortal.approvedByYou);
    expect(round1).not.toHaveTextContent(tPortal.approvedByYou);
    // Times are machine-readable for AT and the reader alike.
    expect(region.querySelector('time[datetime="2026-09-03T03:00:00.000Z"]')).not.toBeNull();
  });

  it('the member model attaches each decision to the version it concerns, rounds oldest first', () => {
    const d = (iso: string) => new Date(iso);
    const version = (n: number, sent: string | null) => ({
      id: `v${n}`,
      broadcastId: 'b',
      versionNo: n,
      authoredBy: n === 0 ? ('member' as const) : ('organisation' as const),
      subject: `Subject ${n}`,
      bodyHtml: '<p>x</p>',
      noteToMember: null,
      sentToMemberAt: sent === null ? null : d(sent),
      createdAt: d('2026-09-01T03:00:00.000Z'),
    });
    const decision = (id: string, versionId: string, kind: 'approved' | 'changes_requested' | 'approval_withdrawn') => ({
      id,
      broadcastId: 'b',
      versionId,
      round: Number(versionId.slice(1)),
      decision: kind,
      reason: `${id}-reason`,
      decidedAt: d('2026-09-10T03:00:00.000Z'),
      decidedByMe: true,
    });
    const model = memberThreadModel(
      {
        broadcastId: 'b' as never,
        summary: {} as never,
        // Out of order on purpose; v0 is the original, never a round.
        versions: [version(2, '2026-09-05T03:00:00.000Z'), version(0, null), version(1, '2026-09-02T03:00:00.000Z')],
        decisions: [
          decision('d1', 'v1', 'changes_requested'),
          decision('d2', 'v2', 'approved'),
          decision('d3', 'v2', 'approval_withdrawn'),
        ],
        approvedAsSubmitted: null,
      },
      (x) => x.toISOString(),
    );
    expect(model.original?.id).toBe('v0');
    expect(model.rounds.map((r) => [r.round, r.decisions.map((x) => x.id)])).toEqual([
      [1, ['d1']],
      [2, ['d2', 'd3']],
    ]);
    expect(hasThreadHistory(model)).toBe(true);
  });

  it('an E-Blast approved as submitted shows the single "approved as submitted" entry', () => {
    renderThread('member', {
      original: null,
      rounds: [],
      approvedAsSubmitted: { at: at('2026-09-06T03:00:00.000Z'), author: { side: 'organisation', name: STAFF_NAME } },
    });
    const region = screen.getByRole('region', { name: tPortal.title });
    expect(within(region).getAllByRole('listitem')).toHaveLength(1);
    expect(region).toHaveTextContent(tPortal.approvedAsSubmitted);
    expect(region).not.toHaveTextContent(STAFF_NAME);
  });
});
