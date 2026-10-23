/**
 * 124 US1.6 — Needs attention: up to five counts. Rows with a zero count are
 * left out (D-n); when nothing is left the card says so. The draft rows exist
 * only for a viewer holding `invoicing.write` — the loader leaves them out of
 * a manager's result, so they are never in a manager's HTML (US4.2). The two
 * draft rows open the invoice list's own draft views under the active
 * filters; the receipt and refund rows have no list to open, so they are
 * plain rows. Under a Type / Plan / Origin filter the card says so
 * (US3.3); the fiscal year does not apply to it.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Badge, Card, type Tone } from '@jirawatpyk/aura-react/server';
import type { InvoiceDashboardAttention, InvoiceDashboardResult } from '@/modules/insights';
import { invoiceListHref, type InvoiceListQuery } from '../_lib/dashboard-links';
import { CardError } from './card-states';

type AttentionKey =
  | 'manualDrafts'
  | 'autoRenewalDrafts'
  | 'receiptPdfFailed'
  | 'refundsFailedAtStripe'
  | 'refundsPendingOverThreshold';

interface AttentionRow {
  readonly key: AttentionKey;
  readonly count: number;
  readonly tone: Tone;
  readonly href?: string;
}

const ROW =
  'flex min-h-11 items-center justify-between gap-3 rounded-[var(--aura-radius-sm)] px-2 py-1.5 text-sm';

export async function AttentionCard({
  result,
  filtered,
  listFilters,
}: {
  readonly result: Promise<InvoiceDashboardResult<InvoiceDashboardAttention>> | InvoiceDashboardResult<InvoiceDashboardAttention>;
  /** A Type, Plan or Origin filter is set. */
  readonly filtered: boolean;
  /** The active filters as invoice-list keys (`subject`, `plan`, `origin`). */
  readonly listFilters: Pick<InvoiceListQuery, 'subject' | 'plan' | 'origin'>;
}) {
  const t = await getTranslations('admin.invoiceDashboard');
  const loaded = await result;
  const title = t('attention.title');
  const description = filtered ? t('attention.underFilters') : undefined;
  const cardProps = { title, headingLevel: 2 as const, ...(description ? { description } : {}) };
  if (!loaded.ok) {
    return (
      <Card {...cardProps}>
        <CardError
          copy={{
            title: t('states.cardError', { card: title }),
            description: t('states.cardErrorDescription', { referenceId: loaded.error.referenceId }),
            tryAgain: t('states.tryAgain'),
          }}
        />
      </Card>
    );
  }
  const a = loaded.value;
  // A draft row only opens a draft view the active Origin filter allows.
  const draftHref = (origin: 'manual' | 'auto_renewal') =>
    invoiceListHref({ status: 'draft', ...listFilters, origin });
  const rows: AttentionRow[] = [
    ...('drafts' in a
      ? [
          { key: 'manualDrafts', count: a.drafts.manual, tone: 'accent', href: draftHref('manual') } as const,
          { key: 'autoRenewalDrafts', count: a.drafts.autoRenewal, tone: 'accent', href: draftHref('auto_renewal') } as const,
        ]
      : []),
    { key: 'receiptPdfFailed', count: a.receiptPdfFailed, tone: 'danger' },
    { key: 'refundsFailedAtStripe', count: a.refundsFailedAtStripe, tone: 'danger' },
    { key: 'refundsPendingOverThreshold', count: a.refundsPendingOverThreshold, tone: 'warning' },
  ];
  const visible = rows.filter((r) => r.count > 0);

  return (
    <Card {...cardProps}>
      {visible.length === 0 ? (
        <p data-testid="attention-nothing" className="m-0 py-[var(--aura-space-2)] text-sm text-[var(--aura-fg-secondary)]">
          {filtered ? t('attention.nothingFiltered') : t('attention.nothing')}
        </p>
      ) : (
        <ul className="-mx-2 m-0 list-none p-0" data-testid="attention-rows">
          {visible.map((row) => {
            const label = t(`attention.${row.key}`);
            const content = (
              <>
                <span>{label}</span>
                <Badge tone={row.tone}>{row.count}</Badge>
              </>
            );
            return (
              <li key={row.key} data-attention={row.key}>
                {row.href ? (
                  <Link
                    href={row.href}
                    aria-label={t('attention.rowName', { label, count: row.count })}
                    className={`${ROW} text-[var(--aura-fg-primary)] no-underline hover:bg-[var(--aura-bg-surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--aura-focus-ring)]`}
                  >
                    {content}
                  </Link>
                ) : (
                  <div className={ROW}>{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
