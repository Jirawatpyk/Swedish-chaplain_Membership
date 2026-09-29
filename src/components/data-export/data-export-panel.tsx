'use client';

/**
 * F9 US6 (T093) — member GDPR data-export panel (client).
 *
 * A "Request my data export" button (POST → `/api/portal/account/data-export`,
 * 202 on enqueue) with toast feedback + `router.refresh()` so the recent-requests
 * table re-renders with the new job, plus a status table with a download link
 * once a job is `ready|delivered` (the link hits the member prepare-and-redirect
 * route, which mints a fresh single-use token).
 *
 * RSC boundary: imports the `ExportStatus` TYPE only from the insights barrel
 * (erased at compile) — never the server-only runtime (mirrors the directory
 * forms' convention).
 *
 * Spec 122 US3: as on the `Portal-account` boards — AURA Button (`loading`),
 * a borderless Table with a StatusPill per request and a secondary link button
 * for the download; below `sm` each row is the pill with its date under it.
 * Shared with the staff member page.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';
import { Download } from 'lucide-react';
import { Button, Table, TBody, THead, Td, Th, Tr } from '@jirawatpyk/aura-react';
import { Icon, StatusPill, buttonClass } from '@jirawatpyk/aura-react/server';
import type { ExportStatus } from '@/modules/insights';
import { exportStatusTone } from '@/lib/export-status-variant';

export interface DataExportRow {
  readonly jobId: string;
  readonly status: ExportStatus;
  readonly statusLabel: string;
  readonly downloadable: boolean;
  readonly requestedAt: string;
  /** Admin card only — whom the archive was prepared for (PDPA §30). */
  readonly forLabel?: string;
}

export interface DataExportLabels {
  readonly requestButton: string;
  readonly requesting: string;
  readonly requestedTitle: string;
  readonly requestedBody: string;
  readonly statusHeading: string;
  readonly empty: string;
  readonly download: string;
  readonly errorTitle: string;
  readonly errorBody: string;
  readonly expiresHint: string;
  readonly colStatus: string;
  readonly colRequested: string;
  readonly caption: string;
  /** Shown (+ button disabled) when an export is already requested/processing. */
  readonly alreadyPending: string;
  /** Column header for `DataExportRow.forLabel` (admin card only). */
  readonly colFor?: string;
}

export function DataExportPanel({
  rows,
  labels,
  requestUrl = '/api/portal/account/data-export',
  downloadUrlBase = '/api/portal/account/data-export',
  requestBody = {},
}: {
  readonly rows: readonly DataExportRow[];
  readonly labels: DataExportLabels;
  /** POST endpoint that enqueues the export (member self vs admin on-behalf). */
  readonly requestUrl?: string;
  /** Base for the per-job download link: `${downloadUrlBase}/${jobId}/download`. */
  readonly downloadUrlBase?: string;
  /** JSON body of the request POST (the admin card names a contact; default `{}`). */
  readonly requestBody?: Readonly<Record<string, unknown>>;
}): React.JSX.Element {
  const router = useRouter();
  const readOnlyToast = useReadOnlyToast();
  const [pending, setPending] = React.useState(false);
  // Polite live-region message so screen-reader users hear the request result
  // even if the toast (rendered in a portal outside main) is missed (W1).
  const [announcement, setAnnouncement] = React.useState('');

  // An export already in flight (requested/processing) — disable the button so a
  // member can't spawn duplicate jobs across idempotency windows (W4).
  const hasPending = rows.some((r) => r.status === 'requested' || r.status === 'processing');
  const disabled = pending || hasPending;
  // Admin card only: a "prepared for" column when the caller labels its rows.
  const showFor = labels.colFor !== undefined && rows.some((r) => r.forLabel !== undefined);

  async function requestExport(): Promise<void> {
    setPending(true);
    try {
      const res = await fetch(requestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      if (!res.ok) {
        if (await isReadOnlyResponse(res)) {
          setAnnouncement(readOnlyToast());
          return;
        }
        toast.error(labels.errorTitle, { description: labels.errorBody });
        setAnnouncement(labels.errorTitle);
        return;
      }
      toast.success(labels.requestedTitle, { description: labels.requestedBody });
      setAnnouncement(`${labels.requestedTitle}. ${labels.requestedBody}`);
      router.refresh();
    } catch {
      toast.error(labels.errorTitle, { description: labels.errorBody });
      setAnnouncement(labels.errorTitle);
    } finally {
      setPending(false);
    }
  }

  return (
    // The boards: 16px between the parts, the pending note 12px from the button.
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <Button
          variant="secondary"
          icon="download"
          className="max-sm:w-full"
          onClick={requestExport}
          disabled={disabled}
          loading={pending}
        >
          {pending ? labels.requesting : labels.requestButton}
        </Button>
        {hasPending && !pending ? (
          <p className="aura-text-table-cell text-[var(--aura-fg-secondary)]">{labels.alreadyPending}</p>
        ) : null}
      </div>

      {/* SR-only live region — announces the request outcome (W1). */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <section aria-labelledby="data-export-recent-heading" className="space-y-4">
        {/* h3: the panel sits under its card's h2 on both the portal and the staff page. */}
        {/* AURA's mono caption on the text: preflight resets a heading's size over AURA's token layer. */}
        <h3 id="data-export-recent-heading" className="m-0 font-normal text-[var(--aura-fg-tertiary)]">
          <span className="aura-text-mono uppercase tracking-[0.04em]">{labels.statusHeading}</span>
        </h3>
        {rows.length === 0 ? (
          <p className="rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] py-6 text-center text-sm text-[var(--aura-fg-secondary)]">
            {labels.empty}
          </p>
        ) : (
          <>
            {/* The boards draw the list without a box: AURA's frameless, centred
                Table (5.13, handoff #81); its row height and header are AURA's. */}
            <Table caption={labels.caption} captionHidden bordered={false} align="middle">
              <THead className="max-sm:hidden">
                <Tr>
                  <Th>{labels.colStatus}</Th>
                  {showFor ? <Th>{labels.colFor}</Th> : null}
                  <Th>{labels.colRequested}</Th>
                  <Th>
                    <span className="sr-only">{labels.download}</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <Tr key={row.jobId}>
                    <Td>
                      <StatusPill tone={exportStatusTone(row.status)}>{row.statusLabel}</StatusPill>
                      {/* below sm the date (and who it was prepared for) sits under the pill, their columns hidden */}
                      <span className="mt-1 block aura-text-table-cell sm:hidden">
                        {showFor && row.forLabel ? `${row.forLabel} · ${row.requestedAt}` : row.requestedAt}
                      </span>
                    </Td>
                    {showFor ? <Td className="max-sm:hidden">{row.forLabel ?? ''}</Td> : null}
                    <Td className="max-sm:hidden">{row.requestedAt}</Td>
                    <Td align="end">
                      {row.downloadable ? (
                        <a
                          href={`${downloadUrlBase}/${row.jobId}/download`}
                          aria-label={`${labels.download} — ${row.requestedAt}`}
                          // AURA's md button is 44px: the touch target (ux-standards § 9.1 / S4)
                          className={buttonClass({ variant: 'secondary' })}
                        >
                          <Icon name={<Download />} size={16} />
                          {labels.download}
                        </a>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <p className="text-xs text-[var(--aura-fg-secondary)]">{labels.expiresHint}</p>
          </>
        )}
      </section>
    </div>
  );
}
