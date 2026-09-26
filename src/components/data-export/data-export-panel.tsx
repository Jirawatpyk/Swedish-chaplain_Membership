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
 * Spec 122 US3: AURA Button (`loading`), Table, Badge (status tone) and a
 * secondary link button for the download; shared with the staff member page.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';
import { Download } from 'lucide-react';
import { Badge, Button, Table, TBody, THead, Td, Th, Tr } from '@jirawatpyk/aura-react';
import { auraButtonClass } from '@/components/shell/aura-markup';
import type { ExportStatus } from '@/modules/insights';
import { exportStatusTone } from '@/lib/export-status-variant';

export interface DataExportRow {
  readonly jobId: string;
  readonly status: ExportStatus;
  readonly statusLabel: string;
  readonly downloadable: boolean;
  readonly requestedAt: string;
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
}

export function DataExportPanel({
  rows,
  labels,
  requestUrl = '/api/portal/account/data-export',
  downloadUrlBase = '/api/portal/account/data-export',
}: {
  readonly rows: readonly DataExportRow[];
  readonly labels: DataExportLabels;
  /** POST endpoint that enqueues the export (member self vs admin on-behalf). */
  readonly requestUrl?: string;
  /** Base for the per-job download link: `${downloadUrlBase}/${jobId}/download`. */
  readonly downloadUrlBase?: string;
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

  async function requestExport(): Promise<void> {
    setPending(true);
    try {
      const res = await fetch(requestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
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
    <div className="space-y-6">
      <div className="space-y-2">
        <Button onClick={requestExport} disabled={disabled} loading={pending}>
          {pending ? labels.requesting : labels.requestButton}
        </Button>
        {hasPending && !pending ? (
          <p className="text-sm text-[var(--aura-fg-secondary)]">{labels.alreadyPending}</p>
        ) : null}
      </div>

      {/* SR-only live region — announces the request outcome (W1). */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <section aria-labelledby="data-export-recent-heading" className="space-y-3">
        <h2 id="data-export-recent-heading" className="text-sm font-semibold">
          {labels.statusHeading}
        </h2>
        {rows.length === 0 ? (
          <p className="rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] py-6 text-center text-sm text-[var(--aura-fg-secondary)]">
            {labels.empty}
          </p>
        ) : (
          <>
            <div className="overflow-hidden rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)]">
              <Table caption={labels.caption} captionHidden>
                <THead>
                  <Tr>
                    <Th>{labels.colStatus}</Th>
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
                        <Badge tone={exportStatusTone(row.status)}>{row.statusLabel}</Badge>
                      </Td>
                      <Td className="text-[var(--aura-fg-secondary)]">{row.requestedAt}</Td>
                      <Td align="end">
                        {row.downloadable ? (
                          <a
                            href={`${downloadUrlBase}/${row.jobId}/download`}
                            aria-label={`${labels.download} — ${row.requestedAt}`}
                            // AURA's md button is 44px: the touch target (ux-standards § 9.1 / S4)
                            className={auraButtonClass({ variant: 'secondary' })}
                          >
                            <Download aria-hidden="true" className="aura-icon size-4" />
                            {labels.download}
                          </a>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
            <p className="text-xs text-[var(--aura-fg-secondary)]">{labels.expiresHint}</p>
          </>
        )}
      </section>
    </div>
  );
}
