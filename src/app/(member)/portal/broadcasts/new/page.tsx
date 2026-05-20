import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { ComposeForm } from '@/components/broadcast/compose-form';
import {
  ComposeTemplatePicker,
  type TemplatePickerRow,
} from '@/components/broadcast/compose/template-picker';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runInTenant } from '@/lib/db';
import {
  computeQuotaCounter,
  envTenantDisplayName,
  f7AuditAdapter,
  isF71aUs7Enabled,
  listBroadcastTemplates,
  makeComputeQuotaDeps,
  makeListBroadcastTemplatesDeps,
  substituteChamberName,
} from '@/modules/broadcasts';
import { makeDrizzleBroadcastTemplatesRepo } from '@/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo';
import { safeAuditEmit } from '@/modules/broadcasts/application/use-cases/_safe-audit-emit';
import { isF71aUs2Enabled } from '@/modules/broadcasts/infrastructure/feature-flags';
import { buildMembersDeps } from '@/modules/members/members-deps';

/**
 * Compose page (server component).
 *
 * Coordinates: signed-in member resolution → quota snapshot → optional
 * `?template=<id>` pre-population (US7) → image-upload flag readiness
 * (US2) → handoff to client `<ComposeForm />`. Emits a cross-tenant
 * probe audit when a `?template=` ID resolves to null (R1.1 CRIT-3).
 * F7.1b draft-resume (`?draftId=`) is backlog — MVP creates fresh
 * drafts only.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.broadcasts.compose');
  return { title: t('title') };
}

interface PageProps {
  readonly searchParams: Promise<{ readonly template?: string }>;
}

export default async function ComposeBroadcastPage({
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  // T172/T174 NOTE: SLO-F7-001 compose page TTFB is measured via
  // Vercel Speed Insights per docs/observability.md § 22.2 source-
  // signal table — NOT via OTel histogram. Server-component bodies
  // must be pure under React 19 (`react-hooks/purity`); time-sensitive
  // measurements would violate the rule. Trace span is auto-created
  // by `@vercel/otel` for the route handler.
  const t = await getTranslations('portal.broadcasts.compose');
  const session = await requireSession('member');
  const tenant = resolveTenantFromRequest();
  const { template: templateIdParam } = await searchParams;

  // Resolve linked member to seed the quota counter + enforce FR-009
  // (members on plans with eblast_per_year=0 do not see the compose
  // surface — bounce them to the benefits page where the upgrade
  // explainer lives).
  const membersDeps = buildMembersDeps(tenant);
  let initialQuota = null;
  try {
    const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
      tenant,
      session.user.id,
    );
    if (memberLookup.ok) {
      const quotaResult = await computeQuotaCounter(
        makeComputeQuotaDeps(tenant.slug),
        { memberId: memberLookup.value.memberId },
      );
      if (quotaResult.ok) {
        // FR-009 — cap=0 means the member's plan has no E-Blast benefit.
        // Redirect to the benefits surface (which renders the same quota
        // card with an "exhausted / not in plan" treatment).
        if (quotaResult.value.counter.cap === 0) {
          redirect('/portal/benefits/e-blasts');
        }
        initialQuota = {
          used: quotaResult.value.counter.used,
          reserved: quotaResult.value.counter.reserved,
          remaining: quotaResult.value.counter.remaining,
          cap: quotaResult.value.counter.cap,
          quotaYear: quotaResult.value.quotaYear,
        };
      }
    }
  } catch {
    // Fall through — client component will fetch /api/broadcasts/quota
    initialQuota = null;
  }

  // F7.1a US2 (T078) — resolve the kill-switch server-side so the
  // toolbar surface only appears when all three flag layers
  // (f7Broadcasts + f71aBroadcastAdvanced + f71aUs2Images) are ON.
  const imagesEnabled = isF71aUs2Enabled();

  // F7.1a US7 (T111) — template picker. Server-side fetches the
  // tenant's templates filtered by the member's current locale
  // (cascading default applied in the use-case), then optionally
  // pre-populates initialSubject + initialBodyHtml from `?template={id}`
  // with `substituteChamberName` applied.
  const templatesEnabled = isF71aUs7Enabled();
  let pickerRows: readonly TemplatePickerRow[] = [];
  let initialSubject: string | undefined;
  let initialBodyHtml: string | undefined;
  let selectedTemplateId: string | null = null;

  if (templatesEnabled) {
    const currentLocale = ((await getLocale()) as 'en' | 'th' | 'sv') ?? 'en';

    try {
      const rows = await runInTenant(tenant, async () =>
        listBroadcastTemplates(makeListBroadcastTemplatesDeps(tenant.slug), {
          tenantId: tenant.slug as never,
          currentUserLocale: currentLocale,
        }),
      );
      pickerRows = rows.map((r) => ({
        id: r.id,
        name: r.name,
        locale: r.locale,
        isSeeded: r.isSeeded,
      }));
    } catch {
      // Picker gracefully degrades to empty list — does not block
      // the compose surface.
      pickerRows = [];
    }

    // Pre-populate compose fields when `?template={id}` is present.
    if (typeof templateIdParam === 'string' && templateIdParam.length > 0) {
      try {
        const template = await runInTenant(tenant, async () => {
          const repo = makeDrizzleBroadcastTemplatesRepo();
          return repo.findById(tenant.slug as never, templateIdParam);
        });
        if (template) {
          const chamberName = await envTenantDisplayName.resolve(
            tenant.slug as never,
          );
          initialSubject = substituteChamberName(template.subject, chamberName);
          initialBodyHtml = substituteChamberName(
            template.bodyHtml,
            chamberName,
          );
          selectedTemplateId = template.id;
        } else {
          // R1.1 CRIT-3: emit cross-tenant probe audit so SSR page
          // render path matches the API surface's audit coverage
          // (Constitution I sub-clause 4). The user-visible UX still
          // falls through to blank compose; only the audit emission
          // is added. safeAuditEmit so a transient audit-storage hiccup
          // doesn't 500 the compose page.
          await safeAuditEmit(f7AuditAdapter, null, {
            eventType: 'broadcast_cross_tenant_probe',
            actorUserId: session.user.id,
            tenantId: tenant.slug,
            summary: `Cross-tenant probe on member compose ?template= ${templateIdParam}`,
            payload: {
              probedTenantId: tenant.slug,
              probedTemplateId: templateIdParam,
              resourceKind: 'template',
            },
            requestId: null,
          });
        }
      } catch {
        // Same graceful-degradation rationale as the picker list above.
      }
    }
  }

  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {templatesEnabled ? (
        <ComposeTemplatePicker
          templates={pickerRows}
          selectedId={selectedTemplateId}
        />
      ) : null}
      <ComposeForm
        initialQuota={initialQuota}
        imagesEnabled={imagesEnabled}
        {...(initialSubject !== undefined ? { initialSubject } : {})}
        {...(initialBodyHtml !== undefined ? { initialBodyHtml } : {})}
      />
    </FormContainer>
  );
}
