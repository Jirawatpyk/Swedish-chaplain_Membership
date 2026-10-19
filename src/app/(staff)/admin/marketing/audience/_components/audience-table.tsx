'use client';

/**
 * 108 PR-D (FR-035, FR-035a, FR-035c, FR-031b) — the Marketing audience
 * table.
 *
 * Column allow-list is exactly FR-035: contact (name + email), marketing
 * state, the switch (only for `contacts.marketing` holders — a read-only
 * viewer gets the badge and NO disabled control), member (link), primary /
 * secondary, member status, last change (who, then when — one two-line
 * column). No DoB, phone or any other `pii_sensitive` field, no download
 * (FR-035a).
 *
 * Responsive (FR-035c, amended by spec 122 US12a): below 640 px a list of
 * contact cards replaces the table, as board `Admin-marketing-audience-mobile`
 * draws it — name with the role pill, email, member link, state and reason,
 * the last change, then a "Receives E-Blasts" row with the switch — so nothing
 * scrolls sideways on a phone. From 640 px it is the table: `table-fixed` + an
 * explicit <colgroup> pin the column widths to the header (so the header does
 * not shift every time a filter changes the rows — same recipe as the members
 * table; review M3), the table's min-width is the column total (under
 * `table-fixed` the browser would otherwise SHRINK columns to fit), and the
 * box (the `<table>`'s parent, which the e2e measures) scrolls only if it
 * must. Long SV/TH labels wrap (`whitespace-normal`).
 *
 * Width budget: at a 1440-px viewport the staff content box is ~1,072 px
 * (256 sidebar, 2×24 page and 2×24 card gutters, a scrollbar). The old fixed
 * columns totalled 1,332 px and scrolled sideways there, so Contact now has
 * NO fixed width — it takes whatever is left, never less than its minimum —
 * and Member, the reason lines and the last change wrap instead of widening
 * their columns.
 */
import {
  AUDIENCE_COLUMN_WIDTHS,
  AUDIENCE_COLUMNS_READ_ONLY,
  AUDIENCE_COLUMNS_WITH_SWITCH,
  AUDIENCE_MIN_WIDTH,
  isSharedColumn,
} from './audience-table-layout';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, Table, TBody, Td, Th, THead, Tr } from '@jirawatpyk/aura-react';
import { MarketingStateBadge } from '@/components/members/marketing-state-badge';
import { MarketingSwitch } from '@/components/members/marketing-switch';
import type { MarketingReason, MarketingState } from '@/modules/members';

export type AudienceTableRow = {
  readonly contactId: string;
  readonly memberId: string;
  readonly companyName: string;
  readonly contactName: string;
  readonly email: string;
  readonly isPrimary: boolean;
  readonly memberStatus: 'active' | 'inactive' | 'archived';
  readonly memberHalted: boolean;
  readonly memberErased: boolean;
  readonly state: MarketingState;
  readonly reasons: readonly MarketingReason[];
  /** Already resolved to a display name (staff) or "the contact"; null = receiving. */
  readonly changedBy: string | null;
  /** Already formatted in the viewer's locale; null = receiving. */
  readonly changedAt: string | null;
};

export { AUDIENCE_COLUMN_WIDTHS, AUDIENCE_MIN_WIDTH } from './audience-table-layout';

export function AudienceTable({
  rows,
  canMarketing,
  leavesView = false,
}: {
  readonly rows: readonly AudienceTableRow[];
  readonly canMarketing: boolean;
  /**
   * True when the view is filtered by marketing state: a successful switch
   * removes the row on refresh, so the switch hands focus on first (H4).
   */
  readonly leavesView?: boolean;
}) {
  const t = useTranslations('admin.marketing.audience');
  const tReason = useTranslations('shared.marketing.reason');

  const columns = canMarketing ? AUDIENCE_COLUMNS_WITH_SWITCH : AUDIENCE_COLUMNS_READ_ONLY;
  const minWidth = canMarketing ? AUDIENCE_MIN_WIDTH.withSwitch : AUDIENCE_MIN_WIDTH.readOnly;

  return (
    <>
    <AudienceCards rows={rows} canMarketing={canMarketing} leavesView={leavesView} />
    <div data-audience-table-wrap="" className="max-sm:hidden">
    <Table
      bleed
      caption={t('tableCaption')}
      captionHidden
      aria-label={t('tableCaption')}
      className="table-fixed min-w-[var(--audience-min-w)]"
      style={{ '--audience-min-w': `${minWidth}px` } as CSSProperties}
      data-testid="marketing-audience-table"
    >
      <colgroup>
        {columns.map((key) =>
          isSharedColumn(key) ? (
            <col key={key} />
          ) : (
            <col key={key} style={{ width: `${AUDIENCE_COLUMN_WIDTHS[key]}px` }} />
          ),
        )}
      </colgroup>
      <THead>
        <Tr>
          <Th scope="col" className="whitespace-normal">{t('columns.contact')}</Th>
          <Th scope="col" className="whitespace-normal">{t('columns.state')}</Th>
          {canMarketing && <Th scope="col" className="whitespace-normal">{t('columns.switch')}</Th>}
          <Th scope="col" className="whitespace-normal">{t('columns.member')}</Th>
          <Th scope="col" className="whitespace-normal">{t('columns.kind')}</Th>
          <Th scope="col" className="whitespace-normal">{t('columns.memberStatus')}</Th>
          <Th scope="col" className="whitespace-normal">{t('columns.lastChange')}</Th>
        </Tr>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.contactId} data-contact-id={row.contactId} data-marketing-state={row.state}>
            <Td className="whitespace-normal">
              <div className="font-medium">{row.contactName}</div>
              <div className="aura-text-caption text-[var(--aura-fg-secondary)] [overflow-wrap:anywhere]">{row.email}</div>
            </Td>
            <Td className="whitespace-normal">
              <div className="flex flex-col gap-1">
                <MarketingStateBadge state={row.state} />
                {row.reasons.length > 0 && (
                  // `role="list"` — Tailwind preflight strips list-style, and
                  // Safari/VoiceOver drop list semantics with it (a11y 12).
                  <ul role="list" className="aura-text-caption text-[var(--aura-fg-secondary)] [overflow-wrap:anywhere]">
                    {row.reasons.map((reason) => (
                      <li key={reason}>{tReason(reason)}</li>
                    ))}
                  </ul>
                )}
              </div>
            </Td>
            {canMarketing && (
              // `whitespace-normal`: for a contact-owned opt-out the cell holds
              // a short note instead of a switch, and it must wrap.
              <Td className="whitespace-normal">
                <MarketingSwitch
                  contactId={row.contactId}
                  contactName={row.contactName}
                  state={row.state}
                  leavesView={leavesView}
                />
              </Td>
            )}
            <Td className="whitespace-normal">
              <Link
                href={`/admin/members/${encodeURIComponent(row.memberId)}`}
                className="font-medium text-[var(--aura-fg-accent)] underline-offset-4 [overflow-wrap:anywhere] hover:underline"
              >
                {row.companyName}
              </Link>
            </Td>
            <Td>
              {/* The board's role pills: Primary solid, Secondary outline. */}
              <Badge tone="neutral" variant={row.isPrimary ? 'solid' : 'outline'}>
                {row.isPrimary ? t('kind.primary') : t('kind.secondary')}
              </Badge>
            </Td>
            <Td className="whitespace-normal">
              <div className="flex flex-wrap gap-1">
                <Badge tone="neutral" variant="outline">{t(`memberStatus.${row.memberStatus}`)}</Badge>
                {row.memberHalted && <Badge tone="neutral" variant="outline">{t('memberStatus.halted')}</Badge>}
                {row.memberErased && <Badge tone="neutral" variant="outline">{t('memberStatus.erased')}</Badge>}
              </div>
            </Td>
            <Td className="whitespace-normal">
              <div className="[overflow-wrap:anywhere]">{row.changedBy ?? '—'}</div>
              {row.changedAt !== null && (
                <div className="aura-text-caption text-[var(--aura-fg-secondary)]">{row.changedAt}</div>
              )}
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
    </div>
    </>
  );
}

/**
 * The phone list (board `Admin-marketing-audience-mobile`): one card per
 * contact. The same rows, badges, link and switch as the table; the active
 * member status is not repeated (the board drops it), while "Broadcasts
 * halted" and "Erased" still show beside the state.
 */
function AudienceCards({
  rows,
  canMarketing,
  leavesView,
}: {
  readonly rows: readonly AudienceTableRow[];
  readonly canMarketing: boolean;
  readonly leavesView: boolean;
}) {
  const t = useTranslations('admin.marketing.audience');
  const tReason = useTranslations('shared.marketing.reason');
  return (
    <ul
      role="list"
      aria-label={t('tableCaption')}
      data-audience-cards=""
      data-testid="marketing-audience-cards"
      className="flex flex-col gap-[var(--aura-space-3)] sm:hidden"
    >
      {rows.map((row) => (
        <li
          key={row.contactId}
          data-card-contact-id={row.contactId}
          data-marketing-state={row.state}
          className="flex flex-col gap-2 rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-[var(--aura-space-4)]"
        >
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{row.contactName}</span>
            <Badge tone="neutral" variant={row.isPrimary ? 'solid' : 'outline'}>
              {row.isPrimary ? t('kind.primary') : t('kind.secondary')}
            </Badge>
          </div>
          <span className="aura-text-body [overflow-wrap:anywhere]">{row.email}</span>
          <Link
            href={`/admin/members/${encodeURIComponent(row.memberId)}`}
            className="text-[var(--aura-fg-accent)] underline-offset-4 [overflow-wrap:anywhere] hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
          >
            {row.companyName}
          </Link>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <MarketingStateBadge state={row.state} />
            {row.memberHalted && <Badge tone="neutral" variant="outline">{t('memberStatus.halted')}</Badge>}
            {row.memberErased && <Badge tone="neutral" variant="outline">{t('memberStatus.erased')}</Badge>}
            {row.memberStatus !== 'active' && (
              <Badge tone="neutral" variant="outline">{t(`memberStatus.${row.memberStatus}`)}</Badge>
            )}
          </div>
          {row.reasons.length > 0 && (
            <ul role="list" className="aura-text-caption text-[var(--aura-fg-secondary)] [overflow-wrap:anywhere]">
              {row.reasons.map((reason) => (
                <li key={reason}>{tReason(reason)}</li>
              ))}
            </ul>
          )}
          {row.changedBy !== null && (
            <span className="aura-text-caption text-[var(--aura-fg-secondary)] [overflow-wrap:anywhere]">
              {`${t('columns.lastChange')}: ${row.changedBy}${row.changedAt !== null ? ` · ${row.changedAt}` : ''}`}
            </span>
          )}
          {canMarketing && (
            <div className="mt-1 flex items-center justify-between gap-3 border-t border-[var(--aura-border-default)] pt-3">
              {row.state !== 'off_by_contact' && row.state !== 'unsubscribed' && row.state !== 'unavailable' ? (
                <span aria-hidden="true" className="aura-text-body">{t('card.receives')}</span>
              ) : null}
              <MarketingSwitch
                contactId={row.contactId}
                contactName={row.contactName}
                state={row.state}
                leavesView={leavesView}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
