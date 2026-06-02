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
import { DownloadIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" type="button">
            <DownloadIcon className="size-4" aria-hidden />
            {t('trigger')}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dialog.title')}</DialogTitle>
          <DialogDescription>{t('dialog.description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="csv-export-from">{t('fields.from')}</Label>
              <Input
                id="csv-export-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.currentTarget.value)}
                required
                aria-invalid={error !== null}
                aria-describedby={error !== null ? 'csv-export-error-msg' : undefined}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="csv-export-to">{t('fields.to')}</Label>
              <Input
                id="csv-export-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.currentTarget.value)}
                required
                aria-invalid={error !== null}
                aria-describedby={error !== null ? 'csv-export-error-msg' : undefined}
              />
            </div>
          </div>
          {error !== null ? (
            <p
              id="csv-export-error-msg"
              className="text-sm text-destructive"
              role="alert"
              data-testid="csv-export-error"
            >
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="submit">{t('actions.download')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
