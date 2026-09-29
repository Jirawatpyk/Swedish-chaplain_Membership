/**
 * 122 US5b-1 (T552) — the member-detail figures strip (board
 * `Admin-member-detail`; Clarifications, Sessions 2026-09-28 and 2026-09-29).
 *
 * Four figures, each a label, a value and a note, in one named group:
 * Outstanding, Membership expires, Primary contact, Engagement. The page
 * decides what may show: `outstanding` is `null` for a role that may not read
 * invoices and `engagement` is `null` while the F9 flag is off, and the strip
 * leaves those cells out rather than showing an empty one. On a phone the
 * cells sit two by two and the long labels take the board's short form (the
 * other form is `display: none`, so a screen reader hears one).
 *
 * Presentation only, so the no-DB preview route renders the same markup; the
 * reads live in `MemberSummaryStripSection`.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { formatSatangThb } from '@/lib/format-thb';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { formatRelativeTime } from '@/lib/relative-time';
import type { EngagementBand } from '@/modules/insights';
import type { MemberOutstanding } from '../_lib/member-outstanding';

/** Static class names, so Tailwind sees each one. */
const SM_COLUMNS: Record<number, string> = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4' };

export type SummaryPortalState = 'linked' | 'invited' | 'expired' | 'not_invited';

export interface MemberSummaryStripProps {
  /** `null` — the viewer may not read invoices, so the cell is left out. */
  readonly outstanding: MemberOutstanding | null;
  readonly expiry:
    | { readonly state: 'ok'; readonly expiryIso: string | null; readonly daysRemaining: number | null }
    | { readonly state: 'unavailable' };
  readonly primaryContact: { readonly name: string; readonly portal: SummaryPortalState } | null;
  /** `null` — the F9 flag is off, so the cell is left out. */
  readonly engagement: { readonly band: EngagementBand | null; readonly lastActivityIso: string | null } | null;
  /** One instant per render, for "N days ago". */
  readonly now: Date;
}

function Cell({
  id,
  label,
  value,
  note,
}: {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly note?: ReactNode;
}) {
  return (
    <div
      data-summary-cell={id}
      className="flex min-w-0 flex-col gap-0.5 border-[var(--aura-border-default)] px-5 py-3.5 max-sm:[&:nth-child(even)]:border-s max-sm:[&:nth-child(n+3)]:border-t sm:[&:not(:first-child)]:border-s"
    >
      <dt className="text-xs text-[var(--aura-fg-secondary)]">{label}</dt>
      <dd className="truncate font-semibold tabular-nums">{value}</dd>
      {note ? <dd className="text-xs text-[var(--aura-fg-secondary)]">{note}</dd> : null}
    </div>
  );
}

/** Long label from `sm` up, the board's short one below it. */
function Responsive({ long, short }: { readonly long: string; readonly short: string }) {
  return (
    <>
      <span className="max-sm:hidden">{long}</span>
      <span className="sm:hidden">{short}</span>
    </>
  );
}

export async function MemberSummaryStrip({
  outstanding,
  expiry,
  primaryContact,
  engagement,
  now,
}: MemberSummaryStripProps) {
  const t = await getTranslations('admin.members.detail.summary');
  const tDetail = await getTranslations('admin.members.detail');
  const tDir = await getTranslations('admin.members.directory');
  const locale = await getLocale();
  const date = (iso: string) => formatLocalisedDate(iso, locale, { dateStyle: 'medium' });

  const cells: ReactNode[] = [];

  if (outstanding !== null) {
    const note =
      outstanding.state === 'unavailable'
        ? null
        : outstanding.count === 0
          ? t('outstandingNone')
          : outstanding.partial
            ? t('outstandingPartial')
            : outstanding.earliestDueIso !== null
              ? t('outstandingNote', { count: outstanding.count, date: date(outstanding.earliestDueIso) })
              : t('outstandingCount', { count: outstanding.count });
    cells.push(
      <Cell
        key="outstanding"
        id="outstanding"
        label={t('outstanding')}
        value={outstanding.state === 'unavailable' ? t('unavailable') : formatSatangThb(outstanding.sumSatang, locale)}
        note={note}
      />,
    );
  }

  {
    let value: ReactNode = '—';
    let note: ReactNode = null;
    if (expiry.state === 'unavailable') {
      value = t('unavailable');
    } else if (expiry.expiryIso === null) {
      note = tDetail('renewalHealth.empty');
    } else {
      value = date(expiry.expiryIso);
      if (expiry.daysRemaining !== null) {
        note =
          expiry.daysRemaining < 0 ? (
            tDetail('renewalHealth.overdueDays', { days: Math.abs(expiry.daysRemaining) })
          ) : (
            <Responsive
              long={tDetail('renewalHealth.daysRemaining', { days: expiry.daysRemaining })}
              short={t('daysLeft', { days: expiry.daysRemaining })}
            />
          );
      }
    }
    cells.push(
      <Cell
        key="expiry"
        id="expiry"
        label={<Responsive long={t('expires')} short={t('expiresShort')} />}
        value={value}
        note={note}
      />,
    );
  }

  {
    const portalNote: Record<SummaryPortalState, string> = {
      linked: tDetail('portal.linked'),
      invited: tDir('portal.invited'),
      expired: tDetail('pendingInvitations.expired'),
      not_invited: tDir('portal.notInvited'),
    };
    cells.push(
      <Cell
        key="primary-contact"
        id="primary-contact"
        label={t('primaryContact')}
        value={primaryContact ? primaryContact.name : tDir('noPrimary')}
        note={primaryContact ? portalNote[primaryContact.portal] : null}
      />,
    );
  }

  if (engagement !== null) {
    const when = engagement.lastActivityIso ? formatRelativeTime(engagement.lastActivityIso, locale, now) : null;
    cells.push(
      <Cell
        key="engagement"
        id="engagement"
        label={t('engagement')}
        value={engagement.band ? tDir(`engagementBand.${engagement.band}`) : tDir('riskNotComputed')}
        note={
          when ? <Responsive long={t('lastActivity', { when })} short={t('lastActivityShort', { when })} /> : null
        }
      />,
    );
  }

  return (
    <div role="group" aria-label={t('label')}>
      <dl
        className={`grid grid-cols-2 rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] ${SM_COLUMNS[cells.length] ?? 'sm:grid-cols-4'}`}
      >
        {cells}
      </dl>
    </div>
  );
}
