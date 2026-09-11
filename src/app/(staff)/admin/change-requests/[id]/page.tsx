/**
 * F114 — `/admin/change-requests/[id]` — the review page (US2 AS1–AS9;
 * FR-019, FR-020, FR-026; T055).
 *
 * `requirePagePermission('members.read')` — manager / marketing see the page
 * read-only; the decision controls render only when `canDecide` (the
 * evaluator's `members.write` answer ∧ pending ∧ not archived ∧ not erasing).
 * Platform flag OFF → 404 (dark ship). Data through the members Application
 * use case; the wire shape is the same the API route emits.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';
import { env } from '@/lib/env';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { serialiseChangeRequestForStaff, serialiseReviewField } from '@/lib/change-request-staff-view';
import { getChangeRequestReview, type ChangeRequestId } from '@/modules/members';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InlineAlert } from '@/components/ui/inline-alert';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { ChangeRequestReviewClient } from '@/components/members/change-requests/change-request-review-client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  readonly params: Promise<{ id: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.changeRequests.review');
  return { title: t('title') };
}

export default async function ChangeRequestReviewPage({ params }: PageProps) {
  if (!env.features.memberChangeApproval) notFound();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const session = await requirePagePermission('members.read');
  const canWrite = canPerform(session.user.role, 'members.write');
  const h = await headers();
  const tenant = resolveTenantFromHeaders(h);
  const requestId = requestIdFromHeaders(h);

  const result = await getChangeRequestReview(buildChangeRequestDeps(tenant), {
    changeRequestId: id as ChangeRequestId,
    canWrite,
    actor: { userId: asMembersUserId(session.user.id), role: session.user.role, requestId },
  });
  if (!result.ok) {
    if (result.error.type === 'not_found') notFound();
    logger.error(
      { errorId: 'M114.admin.review_page.use_case_failed', requestId, tenantId: tenant.slug, changeRequestId: id, err: result.error.message },
      'change-requests.review page: use case failed',
    );
    throw new Error('change-requests.review: load failed');
  }

  const review = result.value;
  const request = serialiseChangeRequestForStaff(review.row);
  const fields = review.fields.map(serialiseReviewField);
  const t = await getTranslations('admin.changeRequests.review');
  const locale = await getLocale();
  const fmt = (iso: string) => formatLocalisedDate(iso, locale, { dateStyle: 'medium', timeStyle: 'short' });

  const notice =
    request.state !== 'pending'
      ? { tone: 'neutral' as const, text: t('notPending') }
      : review.member.erasing
        ? { tone: 'destructive' as const, text: t('erasing') }
        : review.member.archived
          ? { tone: 'warning' as const, text: t('archived') }
          : !canWrite
            ? { tone: 'info' as const, text: t('readOnly') }
            : null;

  return (
    <DetailContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle', {
          company: review.member.companyName,
          submitter: request.submittedBy.displayName,
          role: t(`roles.${request.submittedBy.roleAtSubmission}`),
          submittedAt: fmt(request.submittedAt),
        })}
        badge={
          <Badge variant={request.state === 'pending' ? 'secondary' : 'outline'} data-testid="change-request-state">
            {request.state === 'decided' && request.outcome ? t(`outcome.${request.outcome}`) : t(`state.${request.state}`)}
          </Badge>
        }
        actions={
          <Link href={`/admin/members/${request.memberId}`} className={`${buttonVariants({ variant: 'outline', size: 'sm' })} inline-flex items-center`}>
            <ArrowLeftIcon className="mr-1 h-4 w-4" aria-hidden="true" />
            {t('backToMember')}
          </Link>
        }
      />

      {notice ? (
        <InlineAlert tone={notice.tone} role="status" data-testid="review-notice">
          {notice.text}
        </InlineAlert>
      ) : null}

      {request.state === 'decided' && request.decidedAt ? (
        <Card data-testid="decision-summary">
          <CardHeader>
            <CardTitle className="text-base">
              {t('decidedBy', {
                name: request.decidedBy?.displayName ?? '',
                decidedAt: fmt(request.decidedAt),
              })}
              {request.decidedBy?.deactivated ? <span className="ml-1 text-muted-foreground">{t('deactivated')}</span> : null}
            </CardTitle>
          </CardHeader>
          {request.decisionReason || request.decisionNote ? (
            <CardContent className="space-y-2 text-sm">
              {request.decisionReason ? (
                <p>
                  <span className="font-medium">{t('decisionReason')}: </span>
                  <span className="whitespace-pre-wrap">{request.decisionReason}</span>
                </p>
              ) : null}
              {request.decisionNote ? (
                <p>
                  <span className="font-medium">{t('decisionNote')}: </span>
                  <span className="whitespace-pre-wrap">{request.decisionNote}</span>
                </p>
              ) : null}
            </CardContent>
          ) : null}
        </Card>
      ) : null}

      <ChangeRequestReviewClient request={request} fields={fields} canDecide={review.canDecide} />
    </DetailContainer>
  );
}
