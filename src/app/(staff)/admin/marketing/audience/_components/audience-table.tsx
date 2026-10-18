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
 * Responsive (FR-035c, amended by spec 122 US12a): below 640 px each contact
 * is an AURA stacked card, as the board draws it — contact as the title, the
 * switch as the action, every other column a labelled field — so nothing
 * scrolls sideways on a phone. From 640 px it is the table: `table-fixed` + an
 * explicit <colgroup> pin the column widths to the header (so the header does
 * not shift every time a filter changes the rows — same recipe as the members
 * table; review M3), the table's min-width is the column total (under
 * `table-fixed` the browser would otherwise SHRINK columns to fit), and the
 * box (the `<table>`'s parent, which the e2e measures) scrolls only if it
 * must. Both apply from `sm` up only. Long SV/TH labels wrap
 * (`whitespace-normal`).
 *
 * Width budget: at a 1440-px viewport the staff content box is ~1,072 px
 * (256 sidebar, 2×24 page and 2×24 card gutters, a scrollbar). The old fixed
 * columns totalled 1,332 px and scrolled sideways there, so Contact now has
 * NO fixed width — it takes whatever is left, never less than its minimum —
 * and Member, the reason lines and the last change wrap instead of widening
 * their columns.
 */
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

/**
 * px — the skeleton mirrors these (audience-table-skeleton.tsx). `contact` is
 * a MINIMUM: its <col> carries no width, so it flexes into the space the
 * fixed columns leave.
 */
export const AUDIENCE_COLUMN_WIDTHS = {
  contact: 184,
  // Sized for the LONGEST locale (FR-050a): SV "Status ej tillgänglig" badge,
  // SV "REGLAGE" header, EN "Broadcasts halted" badge, TH "ผู้ติดต่อรอง" role
  // badge — badges are atomic (`whitespace-nowrap overflow-hidden`), so the
  // column, not the badge, wraps.
  state: 184,
  switch: 112,
  member: 168,
  kind: 112,
  memberStatus: 152,
  lastChange: 136,
} as const;

type ColumnKey = keyof typeof AUDIENCE_COLUMN_WIDTHS;

const COLUMNS_WITH_SWITCH: readonly ColumnKey[] = [
  'contact', 'state', 'switch', 'member', 'kind', 'memberStatus', 'lastChange',
];
const COLUMNS_READ_ONLY: readonly ColumnKey[] = COLUMNS_WITH_SWITCH.filter((k) => k !== 'switch');

const sumWidths = (columns: readonly ColumnKey[]): number =>
  columns.reduce((sum, key) => sum + AUDIENCE_COLUMN_WIDTHS[key], 0);

/** The table's min-width per shape — the skeleton must land on the same box. */
export const AUDIENCE_MIN_WIDTH = {
  withSwitch: sumWidths(COLUMNS_WITH_SWITCH),
  readOnly: sumWidths(COLUMNS_READ_ONLY),
} as const;

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

  const columns = canMarketing ? COLUMNS_WITH_SWITCH : COLUMNS_READ_ONLY;
  const minWidth = canMarketing ? AUDIENCE_MIN_WIDTH.withSwitch : AUDIENCE_MIN_WIDTH.readOnly;

  return (
    <Table
      caption={t('tableCaption')}
      captionHidden
      aria-label={t('tableCaption')}
      stackBelow="sm"
      stackStyle="cards"
      className="sm:table-fixed sm:min-w-[var(--audience-min-w)]"
      style={{ '--audience-min-w': `${minWidth}px` } as CSSProperties}
      data-testid="marketing-audience-table"
    >
      <colgroup>
        {columns.map((key) =>
          key === 'contact' ? (
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
            <Td card="title" className="whitespace-normal">
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
              <Td card="action" className="whitespace-normal">
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
  );
}
