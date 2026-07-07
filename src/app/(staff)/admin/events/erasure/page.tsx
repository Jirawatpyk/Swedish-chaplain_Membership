/**
 * Erase-by-email admin page (F6 remediation PR 2.2 / P4 / FR-032a).
 *
 * Static segment `/admin/events/erasure` — Next.js resolves it in preference to
 * the sibling `[eventId]` dynamic segment, so it never collides. Server
 * component that:
 *   1. flag-gates `env.features.f6EventCreate` → notFound()
 *   2. **admin-only** (FR-035, carry-forward #1) — manager + member redirected
 *      to /admin/events, mirroring the per-registration erase page. Without this
 *      gate the `runSearchAttendeesByEmail` PII preview (attendee name + email)
 *      would leak to non-admins.
 *   3. reads `?email=`, normalises `.trim().toLowerCase()` (carry-forward #4) and
 *      RFC-validates (≤254 chars). Invalid / empty → renders the empty search
 *      form (no error state).
 *   4. runs `runSearchAttendeesByEmail` inside a try/catch (carry-forward #2 —
 *      the read can REJECT when the repo enumeration fails loud; a throw renders
 *      the error state, never an unhandled rejection). The searched email is
 *      NEVER written to a log line (it is the PII the DSR concerns).
 *   5. renders a results table (event name + Bangkok-local CE date + match badge
 *      + quota badge + per-row `ErasePiiDialog`) plus the "Erase all N" bulk
 *      affordance. When the result set is `truncated` a banner warns the list is
 *      PARTIAL and prompts a re-run (carry-forward #3).
 *
 * The `<title>` is name/email-free via the `metaTitle` key (no PII in browser
 * history / bookmarks); the `?email=` query is acceptable — it is the DSR
 * subject the admin is acting on.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { getTranslations } from 'next-intl/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { runSearchAttendeesByEmail } from '@/lib/events-admin-deps';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EraseByEmailPanel } from '@/components/events/erase-by-email-panel';
import { ErasePiiDialog } from '@/components/events/erase-pii-dialog';
import { MatchStatusBadge } from '@/components/events/match-status-badge';
import { QuotaEffectBadge } from '@/components/events/quota-effect-badge';

// RFC email + ≤254 applied to the trimmed+lowered value (carry-forward #4).
const NormalisedEmailSchema = z.string().min(1).max(254).email();

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.events.erasure');
  // Name/email-free document title — the searched email must not leak into
  // browser history or bookmarks via <title>.
  return { title: t('metaTitle') };
}

interface SearchParams {
  readonly email?: string | string[];
}

function firstParam(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function EraseByEmailPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (!env.features.f6EventCreate) notFound();

  // FR-035 admin-only (carry-forward #1) — mirror the per-registration erase
  // page's deny: manager + member redirected to /admin/events.
  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession('staff');
  } catch {
    redirect('/admin/sign-in');
  }
  if (session.user.role !== 'admin') {
    redirect('/admin/events');
  }

  let tenantCtx: ReturnType<typeof resolveTenantFromHeaders>;
  try {
    tenantCtx = resolveTenantFromHeaders(await headers());
  } catch (e) {
    logger.error(
      {
        event: 'admin_erase_by_email_page_tenant_resolve_failed',
        err: e instanceof Error ? e.message : String(e),
        // No email in the log line — it is the PII we are erasing.
      },
      '[F6] resolveTenantFromHeaders threw on erase-by-email page',
    );
    notFound();
  }

  const query = await searchParams;
  const t = await getTranslations('admin.events.erasure');
  const tMatch = await getTranslations('admin.events.matchType');
  const tQuota = await getTranslations('admin.events.quotaEffect');
  const tShared = await getTranslations('shared');

  // carry-forward #4 — normalise, THEN RFC-validate. Invalid / empty renders the
  // empty search form (no error).
  const rawEmail = firstParam(query.email);
  const normalisedEmail = (rawEmail ?? '').trim().toLowerCase();
  const emailValid =
    normalisedEmail.length > 0 &&
    NormalisedEmailSchema.safeParse(normalisedEmail).success;
  const searchedEmail = emailValid ? normalisedEmail : '';

  let searchResult: Awaited<ReturnType<typeof runSearchAttendeesByEmail>> | null =
    null;
  let searchThrew = false;
  if (searchedEmail) {
    try {
      searchResult = await runSearchAttendeesByEmail(tenantCtx.slug, {
        emailLower: searchedEmail,
      });
    } catch (e) {
      // carry-forward #2 — the read can reject (fail-loud enumerate). Render the
      // error state; never an unhandled rejection. NO email in the log line.
      searchThrew = true;
      logger.error(
        {
          event: 'admin_erase_by_email_page_throw',
          err:
            e instanceof Error
              ? {
                  name: e.name,
                  message: e.message,
                  stack:
                    typeof e.stack === 'string'
                      ? (redactStack(e.stack) ?? null)
                      : null,
                }
              : String(e),
        },
        '[F6] runSearchAttendeesByEmail threw on erase-by-email page',
      );
    }
  }

  const hasError = searchThrew || (searchResult !== null && !searchResult.ok);
  const matches =
    searchResult !== null && searchResult.ok ? searchResult.value.matches : [];
  const truncated =
    searchResult !== null && searchResult.ok
      ? searchResult.value.truncated
      : false;

  return (
    <TableContainer>
      <PageHeader title={t('pageTitle')} subtitle={t('pageHint')} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <EraseByEmailPanel email={searchedEmail} matchCount={matches.length} />

          {/* sr-only live region announcing the result count after a re-search. */}
          <output
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {searchedEmail ? t('resultsCount', { count: matches.length }) : ''}
          </output>

          {searchedEmail && truncated ? (
            <div
              role="alert"
              className="rounded-md border border-amber-500/50 bg-amber-50 p-3 text-body text-amber-900 dark:bg-amber-900/20 dark:text-amber-100"
            >
              {t('truncatedBanner', { cap: 500 })}
            </div>
          ) : null}

          {!searchedEmail ? (
            <p className="py-8 text-center text-muted-foreground">
              {t('emptyPrompt')}
            </p>
          ) : hasError ? (
            <div className="py-8 text-center" role="alert">
              <p className="text-muted-foreground">{t('errorState')}</p>
            </div>
          ) : matches.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">
              {t('noMatches')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-body">
                <thead>
                  <tr className="border-b text-caption text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('columns.event')}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('columns.date')}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('columns.match')}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('columns.quota')}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('columns.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m) => (
                    <tr
                      key={m.registrationId}
                      className="border-b last:border-b-0"
                    >
                      <td className="px-3 py-3">
                        {m.eventName ? (
                          <Link
                            href={`/admin/events/${m.eventId}`}
                            className="underline underline-offset-2 hover:no-underline"
                          >
                            {m.eventName}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">
                            {t('unknownEvent')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 tabular-nums">
                        {m.eventStartDateIso
                          ? bangkokLocalDate(m.eventStartDateIso)
                          : '—'}
                      </td>
                      <td className="px-3 py-3">
                        <MatchStatusBadge
                          matchType={m.matchType}
                          label={tMatch(m.matchType)}
                        />
                      </td>
                      <td className="px-3 py-3">
                        {m.countedPartnership ? (
                          <QuotaEffectBadge
                            kind="partnership"
                            label={tQuota('partnership')}
                          />
                        ) : m.countedCultural ? (
                          <QuotaEffectBadge
                            kind="cultural"
                            label={tQuota('cultural')}
                          />
                        ) : (
                          <span className="text-caption text-muted-foreground">
                            {tQuota('none')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {m.isPseudonymised ? (
                          <Badge variant="outline">
                            {t('pseudonymisedBadge')}
                          </Badge>
                        ) : (
                          <ErasePiiDialog
                            eventId={m.eventId}
                            registrationId={m.registrationId}
                            attendeeName={m.attendeeName}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div>
            <Link
              href="/admin/events"
              className="text-body underline underline-offset-2 hover:no-underline"
            >
              {t('backLink')}
            </Link>
          </div>
        </CardContent>
      </Card>
      <span className="sr-only">{tShared('loaded')}</span>
    </TableContainer>
  );
}
