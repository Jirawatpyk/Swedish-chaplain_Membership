'use client';

/**
 * 108 PR-D (FR-035, FR-035a, FR-035c, FR-031b) — the Marketing audience
 * table.
 *
 * Column allow-list is exactly FR-035: contact (name + email), marketing
 * state, the switch (only for `contacts.marketing` holders — a read-only
 * viewer gets the badge and NO disabled control), member (link), primary /
 * secondary, member status, changed by / at. No DoB, phone or any other
 * `pii_sensitive` field, no download (FR-035a).
 *
 * Responsive (FR-035c): the `Table` primitive scrolls horizontally inside
 * its own wrapper, the table carries a min-width so columns keep their
 * shape, and contact + state (+ switch) are the FIRST columns so they stay in
 * view at 320 px. Long SV/TH labels wrap (`whitespace-normal`).
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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

export function AudienceTable({
  rows,
  canMarketing,
}: {
  readonly rows: readonly AudienceTableRow[];
  readonly canMarketing: boolean;
}) {
  const t = useTranslations('admin.marketing.audience');
  const tReason = useTranslations('shared.marketing.reason');

  return (
    <Table className="min-w-[960px]" data-testid="marketing-audience-table">
      <caption className="sr-only">{t('tableCaption')}</caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="w-[220px]">{t('columns.contact')}</TableHead>
          <TableHead scope="col" className="w-[180px]">{t('columns.state')}</TableHead>
          {canMarketing && (
            <TableHead scope="col" className="w-[72px]">{t('columns.switch')}</TableHead>
          )}
          <TableHead scope="col" className="w-[200px]">{t('columns.member')}</TableHead>
          <TableHead scope="col" className="w-[110px]">{t('columns.kind')}</TableHead>
          <TableHead scope="col" className="w-[140px]">{t('columns.memberStatus')}</TableHead>
          <TableHead scope="col" className="w-[160px]">{t('columns.changedBy')}</TableHead>
          <TableHead scope="col" className="w-[170px]">{t('columns.changedAt')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.contactId} data-contact-id={row.contactId} data-marketing-state={row.state}>
            <TableCell className="whitespace-normal align-top">
              <div className="font-medium">{row.contactName}</div>
              <div className="text-xs text-muted-foreground break-all">{row.email}</div>
            </TableCell>
            <TableCell className="whitespace-normal align-top">
              <div className="flex flex-col gap-1">
                <MarketingStateBadge state={row.state} />
                {row.reasons.length > 0 && (
                  <ul className="text-xs text-muted-foreground">
                    {row.reasons.map((reason) => (
                      <li key={reason}>{tReason(reason)}</li>
                    ))}
                  </ul>
                )}
              </div>
            </TableCell>
            {canMarketing && (
              <TableCell className="align-top">
                <MarketingSwitch
                  contactId={row.contactId}
                  contactName={row.contactName}
                  state={row.state}
                />
              </TableCell>
            )}
            <TableCell className="whitespace-normal align-top">
              <Link
                href={`/admin/members/${encodeURIComponent(row.memberId)}`}
                className="underline-offset-4 hover:underline"
              >
                {row.companyName}
              </Link>
            </TableCell>
            <TableCell className="align-top">
              <Badge variant={row.isPrimary ? 'default' : 'outline'}>
                {row.isPrimary ? t('kind.primary') : t('kind.secondary')}
              </Badge>
            </TableCell>
            <TableCell className="whitespace-normal align-top">
              <div className="flex flex-wrap gap-1">
                <Badge variant="outline">{t(`memberStatus.${row.memberStatus}`)}</Badge>
                {row.memberHalted && <Badge variant="outline">{t('memberStatus.halted')}</Badge>}
                {row.memberErased && <Badge variant="outline">{t('memberStatus.erased')}</Badge>}
              </div>
            </TableCell>
            <TableCell className="whitespace-normal align-top">{row.changedBy ?? '—'}</TableCell>
            <TableCell className="whitespace-normal align-top">{row.changedAt ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
