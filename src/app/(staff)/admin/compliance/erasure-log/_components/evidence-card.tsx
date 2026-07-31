/**
 * COMP-1 US3-D erasure-log UX enhancement (Task 3) — `EvidenceCard` extracted
 * from `page.tsx` into a native `<details>` for progressive disclosure:
 * complete cards render collapsed, half-run/overdue cards render open so the
 * DPO's attention lands on outstanding work without a click.
 *
 * Synchronous Server Component — `useTranslations` (next-intl) works in RSC,
 * so this file intentionally has NO `'use client'` directive.
 *
 * The `<details>`/`<summary>` element carries native disclosure semantics
 * (exposed accessibility state, no manual `aria-expanded`) — see MDN
 * disclosure widget notes. The marker is hidden cross-browser and replaced
 * with a chevron that rotates on open, guarded by `motion-reduce`.
 */
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldCheckIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatMemberNumber, asMemberNumber } from '@/modules/members';
import type { GroupedEvidence } from '@/modules/insights';

const DASH = '—';

/** Human-readable elapsed time since an instant (whole days / hours / minutes). */
function elapsed(from: Date, now: Date, t: (k: string, v?: Record<string, string | number>) => string): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return t('status.elapsedDays', { count: days });
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return t('status.elapsedHours', { count: hours });
  return t('status.elapsedMinutes', { count: Math.floor(ms / (60 * 1000)) });
}

/** A label/value definition row. Value is em-dash when null/empty. */
function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function EvidenceCard({
  row, memberPrefix, fmt, now, topBannerPresent,
}: {
  readonly row: GroupedEvidence;
  readonly memberPrefix: string;
  readonly fmt: Intl.DateTimeFormat;
  readonly now: Date;
  readonly topBannerPresent: boolean;
}): React.JSX.Element {
  const t = useTranslations('admin.compliance.erasureLog');
  const headingId = `erasure-${row.memberId}`;
  const isComplete = !row.halfRun;
  const fmtDate = (d: Date | null) => (d ? fmt.format(d) : DASH);
  const fmtBool = (b: boolean | null) => (b === null ? DASH : b ? t('value.yes') : t('value.no'));
  const fmtText = (s: string | null) => (s && s.trim() !== '' ? s : DASH);

  const statusVariant: 'destructive' | 'outline' | 'secondary' = row.isOverdue
    ? 'destructive' : row.halfRun ? 'outline' : 'secondary';
  const statusLabel = row.isOverdue ? t('status.overdue') : row.halfRun ? t('status.halfRun') : t('status.complete');
  // Defensive: `member_number` is DB-CHECK-guarded (> 0), so `asMemberNumber`
  // should never throw here — but this card renders inside the page's RSC
  // tree, so a single malformed row throwing would fail the ENTIRE
  // accountability list (error boundary), not just this card. Degrade to the
  // raw value instead of risking a whole-list 500.
  const ref =
    Number.isInteger(row.memberNumber) && row.memberNumber > 0
      ? formatMemberNumber(memberPrefix, asMemberNumber(row.memberNumber))
      : String(row.memberNumber);

  return (
    <Card
      className={cn(
        'p-0', // details owns padding
        row.isOverdue && 'border-l-2 border-l-destructive',
        row.halfRun && !row.isOverdue && 'border-l-2 border-l-amber-500',
      )}
    >
      <details data-evidence open={!isComplete} className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-3 border-b px-6 py-4 [&::-webkit-details-marker]:hidden [&::marker]:content-['']">
          <div className="flex flex-col gap-1">
            <h2 id={headingId} className="font-heading text-base font-medium leading-snug">
              {t('memberNumber', { ref })}
            </h2>
            <p className="text-sm text-muted-foreground">{t('erasedAt', { at: fmtDate(row.erasedAt) })}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant={statusVariant}
              className={cn('h-6 px-2.5 text-xs',
                row.halfRun && !row.isOverdue && 'border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400')}
            >
              {statusLabel}
            </Badge>
            <ChevronDownIcon
              aria-hidden
              className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
            />
          </div>
        </summary>

        <CardContent className="flex flex-col gap-6 pt-6 pb-6">
          {/* Half-run note — elapsed time + reconciler escalation guidance. */}
          {row.halfRun && row.requestedAt ? (
            <p
              className={cn(
                'rounded-md border p-3 text-sm',
                row.isOverdue
                  ? 'border-destructive/40 bg-destructive-surface text-destructive'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
              )}
              role={row.isOverdue && !topBannerPresent ? 'alert' : 'status'}
            >
              {row.isOverdue
                ? t('halfRunNote.overdue', { elapsed: elapsed(row.requestedAt, now, t) })
                : t('halfRunNote.pending', { elapsed: elapsed(row.requestedAt, now, t) })}
            </p>
          ) : null}

          {/* Requested + Art.12 attestation block. */}
          <section aria-label={t('sections.requested')} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t('sections.requested')}</h3>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('fields.requestedAt')}>{fmtDate(row.requestedAt)}</Field>
              <Field label={t('fields.reason')}>{fmtText(row.reason)}</Field>
              <Field label={t('fields.identityVerified')}>{fmtBool(row.identityVerified)}</Field>
              <Field label={t('fields.verificationMethod')}>{fmtText(row.verificationMethod)}</Field>
              <Field label={t('fields.note')}>{fmtText(row.note)}</Field>
            </dl>
          </section>

          {/* Completion block — cascade counts + the re-drive caveat. */}
          <section aria-label={t('sections.completion')} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t('sections.completion')}</h3>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('fields.completedAt')}>{fmtDate(row.completedAt)}</Field>
              <Field label={t('fields.sessionsRevoked')}>
                {row.sessionsRevokedTotal ?? DASH}
              </Field>
              <Field label={t('fields.invitationsRevoked')}>
                {row.invitationsRevokedCount ?? DASH}
              </Field>
            </dl>
            {row.reDrive === true ? (
              <p className="text-xs text-muted-foreground" role="note">
                {t('reDriveNote')}
              </p>
            ) : null}
          </section>

          {/* Credential erasure (user_erased) — occurredAt + marker ONLY (M-2). */}
          <section aria-label={t('sections.credential')} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t('sections.credential')}</h3>
            {row.userErasedProofs.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {row.userErasedProofs.map((p, i) => (
                  <li key={`${row.memberId}-cred-${i}`} className="flex items-center gap-2">
                    <ShieldCheckIcon className="size-4 text-muted-foreground" aria-hidden />
                    <span>{t('credentialErasedAt', { at: fmt.format(p.occurredAt) })}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('credentialNone')}</p>
            )}
          </section>

          {/* Tax-document redactions (US3-B) — occurredAt + document_kind (H-1). */}
          <section aria-label={t('sections.taxRedactions')} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t('sections.taxRedactions')}</h3>
            {row.taxRedactions.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {row.taxRedactions.map((r, i) => (
                  <li key={`${row.memberId}-tax-${i}`} className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {r.documentKind === 'invoice'
                        ? t('documentKind.invoice')
                        : r.documentKind === 'credit_note'
                          ? t('documentKind.creditNote')
                          : r.documentKind}
                    </Badge>
                    <span className="text-muted-foreground">{fmt.format(r.occurredAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('taxRedactionsNone')}</p>
            )}
          </section>

          {/* Sub-processor (Resend) outcome (US3-C). */}
          <section aria-label={t('sections.subprocessor')} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t('sections.subprocessor')}</h3>
            {row.subprocessorOutcome ? (
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label={t('fields.resendOutcome')}>
                  {row.subprocessorOutcome.resendOutcome}
                </Field>
                <Field label={t('fields.contactsRemoved')}>
                  {row.subprocessorOutcome.contactsRemoved}
                </Field>
                <Field label={t('fields.contactsFailed')}>
                  {row.subprocessorOutcome.contactsFailed}
                </Field>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">{t('subprocessorNone')}</p>
            )}
          </section>
        </CardContent>
      </details>
    </Card>
  );
}
