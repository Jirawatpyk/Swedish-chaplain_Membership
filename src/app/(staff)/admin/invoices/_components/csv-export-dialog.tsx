'use client';

/**
 * Phase 3 of the F4 receipt-surface plan — CSV export trigger dialog.
 *
 * Opens from the admin invoice list PageHeader "Export CSV" button.
 * Collects an inclusive date range (default = this Bangkok-local
 * month) + dispatches the export by opening the API in a new tab so
 * the browser's native "Save as…" UI handles the file write. The
 * dialog stays open until the user clicks Cancel — this lets a
 * bookkeeper repeat exports across multiple months in one session.
 */
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Button, Dialog, TextField } from '@jirawatpyk/aura-react';

const MAX_DAYS = 366;

function todayBangkokYmd(): string {
  const now = new Date();
  // Bangkok is UTC+7 (no DST). Add the offset before extracting Y/M/D.
  const ms = now.getTime() + 7 * 60 * 60 * 1000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function firstOfMonthBangkokYmd(): string {
  const today = todayBangkokYmd();
  return `${today.slice(0, 8)}01`;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T12:00:00Z`);
  const to = Date.parse(`${toYmd}T12:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.NaN;
  return Math.round((to - from) / 86_400_000) + 1;
}

export function CsvExportDialog(): React.JSX.Element {
  const t = useTranslations('admin.invoices.csvExport');
  const [open, setOpen] = React.useState(false);
  const [from, setFrom] = React.useState<string>(firstOfMonthBangkokYmd);
  const [to, setTo] = React.useState<string>(todayBangkokYmd);
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = React.useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);

      const days = daysBetween(from, to);
      if (Number.isNaN(days)) {
        setError(t('errors.invalidDate'));
        return;
      }
      if (from > to) {
        setError(t('errors.rangeInverted'));
        return;
      }
      if (days > MAX_DAYS) {
        setError(t('errors.rangeTooWide'));
        return;
      }

      // Build the URL + open in a new tab. The browser's native
      // download UI handles the byte stream; we don't keep state
      // about the in-flight request here.
      const params = new URLSearchParams({ from, to });
      window.open(
        `/api/admin/invoices/export.csv?${params.toString()}`,
        '_blank',
        'noopener,noreferrer',
      );
    },
    [from, to, t],
  );

  const invalid = error !== null;
  return (
    // Spec 122 US8 (T805) — AURA's dialog (a bottom sheet on phones). The
    // footer buttons submit the form through its id, so Enter in a field
    // still exports.
    <Dialog
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      trigger={
        <Button variant="secondary" icon="download" type="button">
          {t('trigger')}
        </Button>
      }
      title={t('dialog.title')}
      description={t('dialog.description')}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" variant="primary" form="csv-export-form">
            {t('actions.download')}
          </Button>
        </>
      }
    >
      <form id="csv-export-form" onSubmit={onSubmit} className="flex flex-col gap-[var(--aura-space-3)]" noValidate>
        <div className="grid grid-cols-1 gap-[var(--aura-space-4)] sm:grid-cols-2">
          <TextField
            id="csv-export-from"
            type="date"
            label={t('fields.from')}
            value={from}
            onChange={(e) => setFrom(e.currentTarget.value)}
            required
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? 'csv-export-error-msg' : undefined}
          />
          <TextField
            id="csv-export-to"
            type="date"
            label={t('fields.to')}
            value={to}
            onChange={(e) => setTo(e.currentTarget.value)}
            required
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? 'csv-export-error-msg' : undefined}
          />
        </div>
        {/* One message for the pair: an inverted or over-long range is about
            both dates, so both fields point at it. */}
        {invalid ? (
          <p
            id="csv-export-error-msg"
            className="text-sm text-[var(--aura-fg-danger)]"
            role="alert"
            data-testid="csv-export-error"
          >
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
