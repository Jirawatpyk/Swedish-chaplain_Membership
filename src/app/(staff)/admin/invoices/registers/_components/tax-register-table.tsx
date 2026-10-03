/**
 * Spec 122 US8c (T846) — the register itself: one AURA `DataTable` that stacks
 * into cards below 640px (board `Admin-invoice-registers-mobile`).
 *
 * R1 — a VOIDED (cancelled) receipt stays LISTED (RD: cancelled tax invoices
 * appear in the sales report) but must NOT read as a live sale: the number is
 * struck through and tagged "Cancelled", the row muted. Its VAT is already
 * excluded from the totals and the output VAT.
 *
 * The rows arrive as plain values from the server view, each figure already
 * formatted with the page's own `formatSatangThb`, so nothing here computes.
 */
'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, DataTable, type DataTableColumn } from '@jirawatpyk/aura-react';
import { TAX_REGISTER_COLUMN_LAYOUT } from './tax-register-table-columns';

export interface TaxRegisterRowView {
  readonly invoiceId: string;
  readonly isVoid: boolean;
  readonly receiptNo: string;
  readonly paymentDate: string;
  readonly buyer: string;
  readonly taxId: string;
  readonly subtotal: string;
  readonly vat: string;
  readonly total: string;
  readonly zeroRated: boolean;
  readonly certNo: string;
}

export function TaxRegisterTable({ rows }: { readonly rows: readonly TaxRegisterRowView[] }) {
  const t = useTranslations('admin.invoices.registers');

  const columns = useMemo<DataTableColumn<TaxRegisterRowView>[]>(
    () => [
      {
        key: 'receiptNo',
        label: t('columns.receiptNo'),
        ...TAX_REGISTER_COLUMN_LAYOUT.receiptNo,
        render: (r) => (
          <span
            className="inline-flex flex-wrap items-center gap-[var(--aura-space-2)] font-medium tabular-nums"
            data-testid={r.isVoid ? 'register-row-void' : undefined}
          >
            <span className={r.isVoid ? 'line-through text-[var(--aura-fg-secondary)]' : undefined}>{r.receiptNo}</span>
            {r.isVoid ? (
              <Badge tone="danger" variant="solid" icon="ban">
                {t('cancelled')}
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        key: 'paymentDate',
        label: t('columns.paymentDate'),
        ...TAX_REGISTER_COLUMN_LAYOUT.paymentDate,
        render: (r) => <Muted on={r.isVoid}>{r.paymentDate}</Muted>,
      },
      {
        key: 'buyer',
        label: t('columns.buyer'),
        ...TAX_REGISTER_COLUMN_LAYOUT.buyer,
        render: (r) => (
          <Muted on={r.isVoid} className="whitespace-normal break-words">
            {r.buyer}
          </Muted>
        ),
      },
      {
        key: 'taxId',
        label: t('columns.taxId'),
        ...TAX_REGISTER_COLUMN_LAYOUT.taxId,
        render: (r) => <Muted on={r.isVoid}>{r.taxId}</Muted>,
      },
      {
        key: 'subtotal',
        label: t('columns.subtotal'),
        ...TAX_REGISTER_COLUMN_LAYOUT.subtotal,
        render: (r) => <Muted on={r.isVoid}>{r.subtotal}</Muted>,
      },
      {
        key: 'vat',
        label: t('columns.vat'),
        ...TAX_REGISTER_COLUMN_LAYOUT.vat,
        render: (r) => <Muted on={r.isVoid}>{r.vat}</Muted>,
      },
      {
        key: 'total',
        label: t('columns.total'),
        ...TAX_REGISTER_COLUMN_LAYOUT.total,
        render: (r) => (
          <Muted on={r.isVoid} className="font-medium">
            {r.total}
          </Muted>
        ),
      },
      {
        key: 'vatTreatment',
        label: t('columns.vatTreatment'),
        ...TAX_REGISTER_COLUMN_LAYOUT.vatTreatment,
        render: (r) => (
          <Muted on={r.isVoid}>{r.zeroRated ? t('vatTreatment.zeroRated') : t('vatTreatment.standard')}</Muted>
        ),
      },
      {
        key: 'certNo',
        label: t('columns.certNo'),
        ...TAX_REGISTER_COLUMN_LAYOUT.certNo,
        render: (r) => <Muted on={r.isVoid}>{r.certNo}</Muted>,
      },
    ],
    [t],
  );

  return (
    <DataTable<TaxRegisterRowView>
      label={t('title')}
      rows={rows}
      columns={columns}
      rowKey="invoiceId"
      rowHeight="auto"
      stackBelow={640}
    />
  );
}

function Muted({
  on,
  className,
  children,
}: {
  readonly on: boolean;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <span className={['tabular-nums', on ? 'text-[var(--aura-fg-secondary)]' : '', className ?? ''].join(' ').trim()}>
      {children}
    </span>
  );
}
