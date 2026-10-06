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
 *      PARTIAL and prompts a re-run (carry-forward #3). Spec 122 US9b-1 (T925):
 *      the body is drawn by `renderErasureBody` on AURA, shared with the
 *      preview route.
 *
 * The `<title>` is name/email-free via the `metaTitle` key (no PII in browser
 * history / bookmarks); the `?email=` query is acceptable — it is the DSR
 * subject the admin is acting on.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { getTranslations } from 'next-intl/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import { requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { runSearchAttendeesByEmail } from '@/lib/events-admin-deps';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { TableContainer } from '@/components/layout';
import { renderErasureBody } from './_components/erasure-view';

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
  // 016 T027 — NOT wrapped in try/catch. `requirePagePermission` denies by
  // calling `notFound()`, which throws a Next.js control-flow signal; catching
  // it would swallow the denial and re-route to sign-in instead of serving the
  // 404. The no-session case is already handled by the staff shell's redirect.
  await requirePagePermission('events.erasure');

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
      {await renderErasureBody({
        searchedEmail,
        status: !searchedEmail ? 'idle' : hasError ? 'error' : 'results',
        truncated,
        rows: matches.map((m) => ({
          registrationId: m.registrationId,
          eventId: m.eventId,
          eventName: m.eventName,
          dateLabel: m.eventStartDateIso ? bangkokLocalDate(m.eventStartDateIso) : null,
          attendeeName: m.attendeeName,
          matchType: m.matchType,
          quota: m.countedPartnership ? 'partnership' : m.countedCultural ? 'cultural' : 'none',
          isPseudonymised: m.isPseudonymised,
        })),
      })}
      <span className="sr-only">{tShared('loaded')}</span>
    </TableContainer>
  );
}
