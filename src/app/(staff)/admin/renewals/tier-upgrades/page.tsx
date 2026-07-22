/**
 * F8 Phase 7 T197 — `/admin/renewals/tier-upgrades` server component.
 *
 * Tier-upgrade admin queue page. Lists `open` + `accepted_pending_apply`
 * suggestions for the current tenant. Admin role required.
 *
 * Authz: admin only. Manager + member redirect to /admin/renewals
 * (the queue is admin-only per FR-052a).
 *
 * Kill-switch: when `FEATURE_F8_RENEWALS=false`, returns 404.
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getTranslations, getLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { makeRenewalsDeps } from '@/modules/renewals';
import { TierUpgradeQueueClient } from './_components/tier-upgrade-queue';
import { parseTierUpgradeEvidenceView } from './_lib/tier-upgrade-queue-item';
import { RenewalsErrorRetry } from '../_components/renewals-error-retry';
import { RenewalsSectionTabs } from '../_components/renewals-section-tabs';
import { fetchPlanDisplay } from '../[cycleId]/_lib/cycle-detail-fetchers';
import { fetchPendingReviewCompanyNames } from '../_lib/pending-review-enrichment';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.renewals.tier_upgrades');
  return { title: t('title'), description: t('subtitle') };
}

export default async function TierUpgradeQueuePage() {
  if (!env.features.f8Renewals) {
    notFound();
  }

  const session = await requireSession('staff');
  if (session.user.role !== 'admin') {
    redirect('/admin/renewals');
  }

  const reqHeaders = await headers();
  const fakeRequest = new Request(
    `http://${reqHeaders.get('host') ?? 'localhost'}/admin/renewals/tier-upgrades`,
    { headers: reqHeaders },
  );
  const tenantCtx = resolveTenantFromRequest(fakeRequest);
  const [deps, locale, t] = await Promise.all([
    Promise.resolve(makeRenewalsDeps(tenantCtx.slug)),
    getLocale(),
    getTranslations('admin.renewals.tier_upgrades'),
  ]);

  let queueItems: Awaited<
    ReturnType<typeof deps.tierUpgradeRepo.listForAdminQueue>
  >['items'] = [];
  let hasError = false;
  try {
    const queue = await deps.tierUpgradeRepo.listForAdminQueue(
      tenantCtx.slug,
      { limit: 50 },
    );
    queueItems = queue.items;
  } catch (e) {
    // Phase 7 review-fix I-UX-1: render explicit error state instead of
    // silently rendering empty-state copy (which would mislead admin
    // into thinking no candidates exist when the DB query failed).
    hasError = true;
    logger.error(
      { err: e instanceof Error ? e : new Error(String(e)) },
      'admin.renewals.tier-upgrades.page_load_failed',
    );
  }

  // Resolve plan names for the queue items. Collect unique plan IDs
  // so we fire at most one query per distinct plan (most queues have
  // ≤10 items, so N queries is acceptable; no batch-plan endpoint
  // exists yet — matches the cycle-detail-fetchers pattern).
  const planNameMap = new Map<string, string>();
  // P1-9 — resolve each suggestion's member COMPANY NAME in ONE batched,
  // RLS-scoped read (reuses the pending-review enrichment helper), so the
  // queue links a human name to `/admin/members/[id]` instead of a raw
  // 8-char UUID slice. A member absent from the map (archived / hidden)
  // degrades to the id, exactly as the escalation-task queue does.
  let companyNames: ReadonlyMap<string, string> = new Map<string, string>();
  if (!hasError && queueItems.length > 0) {
    const uniquePlanIds = new Set<string>();
    for (const s of queueItems) {
      uniquePlanIds.add(s.fromPlanId);
      uniquePlanIds.add(s.toPlanId);
    }
    const [, companyNamesResult] = await Promise.all([
      Promise.allSettled(
        Array.from(uniquePlanIds).map(async (planId) => {
          try {
            const display = await fetchPlanDisplay({
              tenantSlug: tenantCtx.slug,
              planId,
              locale,
            });
            if (display) planNameMap.set(planId, display.localisedName);
          } catch (e) {
            // Non-fatal: fall back to rendering the ID.
            logger.warn(
              { planId, err: e instanceof Error ? e : new Error(String(e)) },
              'admin.renewals.tier-upgrades.plan_name_lookup_failed',
            );
          }
        }),
      ),
      fetchPendingReviewCompanyNames({
        tenantSlug: tenantCtx.slug,
        memberIds: queueItems.map((s) => s.memberId),
      }).catch((e: unknown) => {
        // Non-fatal: fall back to rendering the member-id slice.
        logger.warn(
          { err: e instanceof Error ? e : new Error(String(e)) },
          'admin.renewals.tier-upgrades.company_name_lookup_failed',
        );
        return new Map<string, string>();
      }),
    ]);
    companyNames = companyNamesResult;
  }

  // Format the threshold date SERVER-side (locale + Buddhist-Era + Bangkok TZ)
  // so the client never receives a raw ISO instant to reformat. Bound to
  // `locale` here; `Asia/Bangkok` avoids an off-by-one near UTC midnight.
  const formatThresholdDate = (iso: string): string =>
    formatLocalisedDate(iso, locale, {
      dateStyle: 'medium',
      timeZone: 'Asia/Bangkok',
    });

  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <RenewalsSectionTabs />
      {hasError ? (
        // Phase 7 review-fix Round 2 IMP-8 + Round 4 SUG-6: explicit
        // role="alert" added here on the Card element. The Card
        // primitive (src/components/ui/card.tsx) is a plain `<div>`
        // with NO implicit ARIA role — the role="alert" attribute is
        // load-bearing and provides the implicit aria-live="assertive"
        // + aria-atomic="true" announcement (which is why aria-live
        // was removed in Round 3 IMP-10 as redundant). DO NOT remove
        // role="alert" without adding aria-live back.
        <Card
          className="border-destructive/40 bg-destructive/5"
          role="alert"
        >
          <CardContent className="flex items-start gap-3 py-6">
            <AlertTriangle
              className="mt-0.5 size-5 shrink-0 text-destructive"
              aria-hidden
            />
            <div className="flex-1">
              <p className="text-base font-medium text-destructive">
                {t('error_state.title')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('error_state.subtitle')}
              </p>
              <RenewalsErrorRetry
                label={t('error_state.retry')}
                retryingLabel={t('error_state.retrying')}
              />
            </div>
          </CardContent>
        </Card>
      ) : (
        <TierUpgradeQueueClient
          items={queueItems.map((s) => {
            const fromPlanName = planNameMap.get(s.fromPlanId);
            const toPlanName = planNameMap.get(s.toPlanId);
            const companyName = companyNames.get(s.memberId);
            // Validate + pre-format the evidence at the presentation
            // boundary; a malformed/mismatched shape becomes `null` → the
            // client renders the localised "verify manually" line.
            const evidence = parseTierUpgradeEvidenceView(
              s.reasonCode,
              s.evidence,
              formatThresholdDate,
            );
            return {
              suggestionId: s.suggestionId,
              memberId: s.memberId,
              status: s.status,
              fromPlanId: s.fromPlanId,
              // Only spread optional keys when truthy to satisfy
              // exactOptionalPropertyTypes (string | undefined is not
              // assignable to optional string without this guard).
              ...(fromPlanName !== undefined ? { fromPlanName } : {}),
              toPlanId: s.toPlanId,
              ...(toPlanName !== undefined ? { toPlanName } : {}),
              ...(companyName !== undefined ? { companyName } : {}),
              reasonCode: s.reasonCode,
              evidence,
              createdAt: s.createdAt,
            };
          })}
        />
      )}
    </TableContainer>
  );
}
