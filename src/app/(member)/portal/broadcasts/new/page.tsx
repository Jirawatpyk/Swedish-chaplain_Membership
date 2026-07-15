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
import { logger } from '@/lib/logger';
import { loadMembershipAccess } from '@/lib/load-membership-access';
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
  // 059-membership-suspension Task 9 item 5 — hoisted OUT of the try/catch
  // below (see the `redirect()` calls further down for why): a suspended/
  // terminated member must never reach the compose form.
  // `enforcePortalPageAccess` (member shell layout) already catches this on
  // SSR load/refresh, but Next.js 16 does NOT re-run a layout on client-side
  // navigation between sibling portal routes — so a member who was `full`
  // when the portal first loaded and became suspended mid-session (or who
  // client-navigates here from the command palette / benefits page) needs
  // this page-level check too.
  let membershipAccessBlocked = false;
  // FR-009 cap=0 flag, also hoisted for the same reason (see below).
  let quotaExhausted = false;
  try {
    const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
      tenant,
      session.user.id,
    );
    if (memberLookup.ok) {
      const membershipAccess = await loadMembershipAccess(
        tenant.slug,
        memberLookup.value.memberId,
      );
      if (membershipAccess.access !== 'full') {
        membershipAccessBlocked = true;
      } else {
        const quotaResult = await computeQuotaCounter(
          makeComputeQuotaDeps(tenant.slug),
          { memberId: memberLookup.value.memberId },
        );
        if (quotaResult.ok) {
          // FR-009 — cap=0 means the member's plan has no E-Blast benefit.
          if (quotaResult.value.counter.cap === 0) {
            quotaExhausted = true;
          } else {
            initialQuota = {
              used: quotaResult.value.counter.used,
              reserved: quotaResult.value.counter.reserved,
              remaining: quotaResult.value.counter.remaining,
              cap: quotaResult.value.counter.cap,
              quotaYear: quotaResult.value.quotaYear,
            };
          }
        }
      }
    }
  } catch (err) {
    // R3.2 H-7 — log quota init failures so RLS misconfig / DB outage
    // shows up in observability. Page still degrades gracefully (the
    // client component will retry via /api/broadcasts/quota), but the
    // server-side initial load no longer fails silently.
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        tenantId: tenant.slug,
        userId: session.user.id,
      },
      'broadcasts.compose.quota_init_failed',
    );
    initialQuota = null;
  }

  // `redirect()` throws a special Next.js error that a broad `catch` would
  // otherwise swallow — Next's own docs (and this repo's
  // `src/lib/portal-page-access.ts`) call this out explicitly, so both
  // redirects are resolved here, AFTER the try/catch above has fully
  // settled, never inside it. Both land on the same benefits-page target —
  // it explains why compose is unavailable either way (paused benefits or
  // an exhausted/not-in-plan quota).
  if (membershipAccessBlocked || quotaExhausted) {
    redirect('/portal/benefits?tab=broadcasts');
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
    } catch (err) {
      // R3.2 H-7 — log picker list failures (DB outage / RLS misconfig)
      // so observability picks up degradation. Picker still gracefully
      // falls back to empty list — does not block the compose surface.
      // R4.3 M-6 — see template_pre_populate_failed sibling log; same
      // userId-in-context rationale applies to picker-list failures.
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          tenantId: tenant.slug,
          userId: session.user.id,
        },
        'broadcasts.compose.template_picker_list_failed',
      );
      pickerRows = [];
    }

    // Pre-populate compose fields when `?template={id}` is present.
    if (typeof templateIdParam === 'string' && templateIdParam.length > 0) {
      try {
        // R3.2 H-1 — findByIdAllowDeletedInTx returns the template
        // EVEN IF soft-deleted so we can distinguish:
        //   (a) null → true cross-tenant probe → emit probe audit
        //   (b) deletedAt !== null → soft-deleted (benign stale link;
        //       e.g. shared URL after admin deleted the template) →
        //       fall through to blank compose SILENTLY (no audit)
        //   (c) live template → substitute + pre-populate as before
        const template = await runInTenant(tenant, async (tx) => {
          const repo = makeDrizzleBroadcastTemplatesRepo();
          // tx cast: runInTenant supplies a TenantTx; the templates
          // port brand BroadcastTemplatesTx is the same Drizzle handle
          // structurally (R3-F4 brand applied at port boundary for
          // intra-use-case discipline). Cast-through-unknown matches
          // adapter wiring in drizzle-broadcast-templates-repo.ts.
          return repo.findByIdAllowDeletedInTx(
            tenant.slug as never,
            templateIdParam,
            tx as unknown as Parameters<
              typeof repo.findByIdAllowDeletedInTx
            >[2],
          );
        });
        if (template && template.deletedAt === null) {
          // (c) — live template.
          const chamberName = await envTenantDisplayName.resolve(
            tenant.slug as never,
          );
          initialSubject = substituteChamberName(template.subject, chamberName);
          initialBodyHtml = substituteChamberName(
            template.bodyHtml,
            chamberName,
          );
          selectedTemplateId = template.id;
        } else if (!template) {
          // (a) — R1.1 CRIT-3: cross-tenant probe audit. Emit
          // best-effort so a transient audit-storage hiccup doesn't
          // 500 the compose page.
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
        // (b) implicit — soft-deleted template falls through with no
        // audit + no pre-population.
      } catch (err) {
        // R3.2 H-7 — log so RLS / DB / sanitiser surprises are
        // observable. Page still falls back to blank compose.
        // R4.3 M-6 — include `userId` in the log context so SRE can
        // correlate the warn line with the audit log and the
        // per-tenant rate-limit bucket when triage-ing recurring
        // pre-populate failures.
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            tenantId: tenant.slug,
            templateIdParam,
            userId: session.user.id,
          },
          'broadcasts.compose.template_pre_populate_failed',
        );
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
      {/*
        E2E + UX bug fix 2026-05-21: pass `selectedTemplateId` (or
        'blank') as React key so a `router.push(?template=<id>)`
        client-side navigation REMOUNTS the form with fresh state.
        Without the key, React preserves the prior `useState` values
        for `subject` + `bodyHtml`, ignoring the new prop values from
        the re-rendered server component. Symptom: member picks a
        template, URL updates, but Subject stays empty (T172 SLO-F7-001
        cold-render is correct; the bug is the client-side persist).
      */}
      <ComposeForm
        key={selectedTemplateId ?? 'blank'}
        initialQuota={initialQuota}
        imagesEnabled={imagesEnabled}
        {...(initialSubject !== undefined ? { initialSubject } : {})}
        {...(initialBodyHtml !== undefined ? { initialBodyHtml } : {})}
      />
    </FormContainer>
  );
}
