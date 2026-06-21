/**
 * COMP-1 US3-D (Task 4) — DPO erasure-evidence log (`/admin/compliance/erasure-log`).
 *
 * Read-only admin page that gives the Data Protection Officer a single,
 * accountable view of every member erasure + its full Art.17 evidence: the
 * Art.12 attestation, the completion cascade, the F1 `user_erased` credential
 * proof, the US3-B tax-document redactions, and the US3-C sub-processor
 * outcome — grouped one card per erased member, newest-erasure-first, with a
 * prominent half-run / OVERDUE badge.
 *
 * RBAC (CWE-285 carry-forward from Task 2): ADMIN-ONLY. Chamber-OS has no
 * distinct DPO role, so the admin acts as DPO. `requireAdminContext`
 * (`src/lib/admin-context.ts`) is a ROUTE-HANDLER helper (returns a
 * `NextResponse`) and does NOT work in an RSC page; the F9 audit page's
 * `requireSession('staff')` ALSO admits `manager`. So this page MUST do
 * `requireSession('staff')` THEN `if (user.role !== 'admin') notFound()` — a
 * bare staff-gate would LEAK erasure evidence (PII + identity-verification
 * attestations) to managers.
 *
 * UNGATED: US3-D is COMP-1, NOT F9 — the reused audit-viewer shell gates on
 * `FEATURE_F9_DASHBOARD`, but this page deliberately does NOT (consistent with
 * the already-live US3-A admin erase UI). No `env.features.f9Dashboard` check.
 *
 * Read-only: NO action buttons. The page never mutates an erasure — remediation
 * runs through the US2d reconciler cron / the US3-A admin erase flow.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, getLocale } from 'next-intl/server';
import { env } from '@/lib/env';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shell/empty-state';
import { ShieldCheckIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { cn } from '@/lib/utils';
import {
  getErasureEvidenceLog,
  makeGetErasureEvidenceLogDeps,
  type GroupedEvidence,
} from '@/modules/insights';
import { decodeCursor, encodeCursor } from './cursor';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.compliance.erasureLog');
  return { title: t('title') };
}

/** Keyset page size — the evidence read is per-member low-volume; 25 is plenty. */
const PAGE_SIZE = 25;

type SearchParams = Record<string, string | string[] | undefined>;

/** First value of a possibly-repeated query param, trimmed. */
function str(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return (raw ?? '').trim();
}

export default async function ErasureLogPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<React.JSX.Element> {
  // RBAC: staff session, then admin-only. Manager + member → notFound (no leak).
  const { user } = await requireSession('staff');
  if (user.role !== 'admin') notFound();

  const params = await searchParams;
  const t = await getTranslations('admin.compliance.erasureLog');
  const locale = await getLocale();
  const tenant = resolveTenantFromRequest();
  const cursor = decodeCursor(str(params.cursor));

  // Read the clock ONCE so the use-case's isOverdue (server-side) and the
  // per-card `elapsed()` render agree on the same instant.
  const now = new Date();
  const result = await getErasureEvidenceLog(makeGetErasureEvidenceLogDeps(), {
    ctx: tenant,
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
    now,
  });

  // Render every instant in the tenant timezone (the Vercel runtime is UTC;
  // without timeZone the "local" line would duplicate the UTC value).
  const dateFmt = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: env.tenant.timezone, // canonical tenant TZ (matches the F9 audit page); closes the latent multi-tenant gap
  });

  const header = <PageHeader title={t('title')} subtitle={t('subtitle')} />;

  if (result.rows.length === 0) {
    // Distinguish a genuinely-empty org (no cursor → first page) from an empty
    // paginated TAIL (a "load more" landed on a 0-row page beyond a full final
    // page). The org-level "none yet" copy would mislead on the latter.
    const emptyKey = cursor ? 'emptyTail' : 'empty';
    return (
      <TableContainer>
        {header}
        <Card>
          <CardContent>
            <EmptyState
              icon={ShieldCheckIcon}
              title={t(`${emptyKey}.title`)}
              description={t(`${emptyKey}.body`)}
              bordered={false}
              data-testid="erasure-log-empty"
            />
          </CardContent>
        </Card>
      </TableContainer>
    );
  }

  const nextHref =
    result.nextCursor !== null
      ? `/admin/compliance/erasure-log?cursor=${encodeCursor(result.nextCursor)}`
      : null;

  return (
    <TableContainer>
      {header}

      {/* SR result-count announcement, re-rendered on each "load more" nav. */}
      <p role="status" className="sr-only">
        {t('resultCount', { count: result.rows.length })}
      </p>

      <ul className="flex flex-col gap-[var(--page-section-gap)]">
        {result.rows.map((row) => (
          <li key={row.memberId}>
            <EvidenceCard row={row} fmt={dateFmt} t={t} now={now} />
          </li>
        ))}
      </ul>

      {nextHref ? (
        <div className="flex justify-center">
          <a href={nextHref} className={buttonVariants({ variant: 'outline' })}>
            {t('loadMore')}
          </a>
        </div>
      ) : null}
    </TableContainer>
  );
}

// ---------------------------------------------------------------------------
// Presentation helpers (RSC-local — no client interactivity on this surface)
// ---------------------------------------------------------------------------

type T = (key: string, values?: Record<string, string | number>) => string;

/** Human-readable elapsed time since an instant (whole days / hours / minutes). */
function elapsed(from: Date, now: Date, t: T): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return t('status.elapsedDays', { count: days });
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return t('status.elapsedHours', { count: hours });
  const minutes = Math.floor(ms / (60 * 1000));
  return t('status.elapsedMinutes', { count: minutes });
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

const DASH = '—';

function EvidenceCard({
  row,
  fmt,
  t,
  now,
}: {
  row: GroupedEvidence;
  fmt: Intl.DateTimeFormat;
  t: T;
  now: Date;
}): React.JSX.Element {
  const headingId = `erasure-${row.memberId}`;
  const fmtDate = (d: Date | null): string => (d ? fmt.format(d) : DASH);
  const fmtBool = (b: boolean | null): string =>
    b === null ? DASH : b ? t('value.yes') : t('value.no');
  const fmtText = (s: string | null): string => (s && s.trim() !== '' ? s : DASH);

  // Status badge — destructive (overdue) > amber (half-run) > neutral (complete).
  const statusVariant: 'destructive' | 'outline' | 'secondary' = row.isOverdue
    ? 'destructive'
    : row.halfRun
      ? 'outline'
      : 'secondary';
  const statusLabel = row.isOverdue
    ? t('status.overdue')
    : row.halfRun
      ? t('status.halfRun')
      : t('status.complete');

  return (
    <Card>
      <CardHeader className="border-b">
        <section aria-labelledby={headingId} className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 id={headingId} className="font-heading text-base font-medium leading-snug">
              {t('memberNumber', { number: row.memberNumber })}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('erasedAt', { at: fmtDate(row.erasedAt) })}
            </p>
          </div>
          <Badge
            variant={statusVariant}
            className={cn(
              'h-6 px-2.5 text-xs',
              // Amber half-run (not overdue): the destructive variant is reserved
              // for the breach state, so half-run gets an explicit amber treatment.
              row.halfRun && !row.isOverdue &&
                'border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400',
            )}
          >
            {statusLabel}
          </Badge>
        </section>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {/* Half-run note — elapsed time + reconciler escalation guidance. */}
        {row.halfRun && row.requestedAt ? (
          <p
            className={cn(
              'rounded-md border p-3 text-sm',
              row.isOverdue
                ? 'border-destructive/40 bg-destructive-surface text-destructive'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
            )}
            role={row.isOverdue ? 'alert' : 'status'}
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
    </Card>
  );
}
