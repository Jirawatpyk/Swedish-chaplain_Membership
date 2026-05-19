/**
 * Admin erase-PII page (F6 Phase 10 T112 / FR-032a).
 *
 * Server component that:
 *   1. Loads the registration via `runLoadEventDetail` to confirm the
 *      registration exists in the path's eventId for THIS tenant
 *      (RLS-enforced) + read the attendee name for the dialog body.
 *   2. Renders a back-link to the event detail + the `ErasePiiDialog`
 *      auto-opened so admins arriving via deep-link don't need an
 *      extra click to start the destructive action.
 *   3. Calls notFound() on:
 *      - F6 flag off
 *      - eventId / registrationId not UUID v4
 *      - F6 use-case returns event_not_found / registration_not_found
 *      - registration belongs to a different event (path mismatch)
 *      - registration is already pseudonymised (PII gone — nothing to
 *        erase; the manual-erasure runbook covers this case)
 *   4. Admin-only — manager + member redirected to /admin (FR-035).
 *
 * Mirrors the F2 plan-create / F4 invoice-create deep-link conventions.
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { runLoadEventDetail } from '@/lib/events-admin-deps';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { ErasePiiDialog } from '@/components/events/erase-pii-dialog';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ eventId: string; registrationId: string }>;
}): Promise<Metadata> {
  const { eventId } = await params;
  const t = await getTranslations('admin.events.detail.erase');
  return {
    title: t('pageTitle', { attendeeName: eventId.slice(0, 8) }),
  };
}

export default async function ErasePiiPage({
  params,
}: {
  params: Promise<{ eventId: string; registrationId: string }>;
}) {
  if (!env.features.f6EventCreate) notFound();

  const { eventId, registrationId } = await params;
  if (!UUID_V4.test(eventId) || !UUID_V4.test(registrationId)) {
    notFound();
  }

  // Admin-only — manager + member redirected per FR-035.
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
        event: 'admin_erase_pii_page_tenant_resolve_failed',
        err: e instanceof Error ? e.message : String(e),
        eventId,
        registrationId,
      },
      '[F6] resolveTenantFromHeaders threw on erase page',
    );
    notFound();
  }

  let result: Awaited<ReturnType<typeof runLoadEventDetail>>;
  try {
    result = await runLoadEventDetail(tenantCtx.slug, {
      eventId,
      page: 1,
      pageSize: 500, // wide enough to find the target row in normal events
      unmatchedOnly: false,
      matchTypeFilter: null,
      q: null,
      paymentStatusFilter: null,
    });
  } catch (e) {
    logger.error(
      {
        event: 'admin_erase_pii_page_throw',
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
        eventId,
        registrationId,
      },
      '[F6] runLoadEventDetail threw on erase page',
    );
    notFound();
  }

  if (!result.ok) {
    notFound();
  }
  const registration = result.value.registrations.find(
    (r) => r.registrationId === registrationId,
  );
  if (!registration) {
    notFound();
  }
  if (registration.isPseudonymised) {
    // Already retention-purged — nothing to erase. Send admin back to
    // the event detail where the row is rendered with the pseudonymised
    // disallowed-relink badge.
    redirect(`/admin/events/${eventId}`);
  }

  const t = await getTranslations('admin.events.detail.erase');

  return (
    <DetailContainer>
      <PageHeader
        title={t('pageTitle', { attendeeName: registration.attendeeName })}
      />
      <p className="text-body text-muted-foreground">{t('pageHint')}</p>
      <div className="mt-4 flex flex-col gap-3">
        <ErasePiiDialog
          eventId={eventId}
          registrationId={registrationId}
          attendeeName={registration.attendeeName}
        />
        <Link
          href={`/admin/events/${eventId}`}
          className="text-body underline underline-offset-2 hover:no-underline"
        >
          {t('pageBackToEventLabel')}
        </Link>
      </div>
    </DetailContainer>
  );
}
