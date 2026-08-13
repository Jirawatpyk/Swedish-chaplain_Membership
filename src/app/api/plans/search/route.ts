/**
 * GET /api/plans/search (T080, US1/US6, contracts/plans-api.md § 11).
 *
 * Command palette backend. In-memory filter over current-year plans +
 * static action/navigate registries, role-filtered so managers never
 * see write actions.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { canPerform, requireApiPermission } from '@/lib/rbac';
import { legacyAdminOnly, mappedLegacy } from '@/modules/auth/domain/permissions/legacy-shim';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { searchPlans, filterPaletteEntriesByFeature } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import type { LocaleKey } from '@/modules/plans';
import {
  directorySearch,
  formatMemberNumber,
  resolveMemberNumberPrefix,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  listInvoicesPaged,
  makeListInvoicesDeps,
  displayDocumentNumber,
} from '@/modules/invoicing';
import {
  loadInvoicePaymentActivity,
  makeLoadInvoicePaymentActivityDeps,
  computeRemainingRefundable,
} from '@/modules/payments';
import type {
  PaletteMemberEntity,
  PaletteRefundableInvoiceEntity,
} from '@/components/command-palette/registry';

const querySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function resolveLocale(request: NextRequest): LocaleKey {
  const header = request.headers.get('accept-language') ?? 'en';
  const primary = header.split(',')[0]?.split('-')[0]?.toLowerCase();
  if (primary === 'th') return 'th';
  if (primary === 'sv') return 'sv';
  return 'en';
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 016 T064 — the palette is not a plans surface; it is the ⌘K entry point for
  // every staff surface, and its per-entry permissions do the real gating below.
  // Guarding the whole endpoint on `plans.read` denied it outright to
  // `marketing`, whose bundle carries members + broadcasts + events — so its
  // palette came back empty for entries it is plainly entitled to.
  //
  // The key widens to `dashboard.view`; the LEGACY ROW is deliberately
  // unchanged, so on the OFF leg the admitted population is byte-identical to
  // before. Plan hits are re-gated on `plans.read` further down.
  const ctx = await requireApiPermission(request, 'dashboard.view', mappedLegacy('plan', 'read'));
  if ('response' in ctx) return ctx.response;
  // rbac-subgate-ok: an optional SECTION of an already-authorised palette
  // response (the plan hits), not this surface's admission decision — that is
  // the `dashboard.view` gate immediately above.
  const canReadPlans = canPerform(
    ctx.current.user.role,
    'plans.read',
    mappedLegacy('plan', 'read'),
  );
  // rbac-subgate-ok: gates the member SECTION of an already-authorised palette
  // response. 016 review — when the endpoint gate widened to `dashboard.view`,
  // the plan and refund sections were re-gated and this one was not. It is safe
  // today only because every bundle holding `dashboard.view` also holds
  // `members.read`; that coincidence is exactly what this feature elsewhere
  // refuses to rely on, and a future engagement-only role would get member PII
  // through ⌘K with no code change.
  const canReadMembers = canPerform(
    ctx.current.user.role,
    'members.read',
    mappedLegacy('members', 'read'),
  );

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    q: url.searchParams.get('q') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_query',
          message: 'Invalid query parameters.',
          details: { issues: parsed.error.issues },
        },
      },
      { status: 400 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const deps = buildPlansDeps(tenant);

  const input: Parameters<typeof searchPlans>[0] = {
    q: parsed.data.q,
    role: ctx.current.user.role,
    activeLocale: resolveLocale(request),
    ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
  };

  const result = await searchPlans(input, {
    tenant: deps.tenant,
    planRepo: deps.planRepo,
    clock: deps.clock,
    // 016 T064 — bind the evaluator to this actor. The Application layer holds
    // each entry's declared permission but must not read `env`, so the probe
    // crosses the boundary instead of `canPerform` itself.
    can: (key, legacy) => canPerform(ctx.current.user.role, key, legacy),
  });

  if (result.ok) {
    // T069 — also search members for the palette. Ordering: plan matches
    // first, then members, mirroring the `groups.tsx` render order. The hits
    // are gated on `members.read` at the exit point below (016 review): the
    // endpoint gate is `dashboard.view`, which is broader.
    let members: readonly PaletteMemberEntity[] = [];
    try {
      const membersDeps = buildMembersDeps(tenant);
      const [membersResult, memberPrefix] = await Promise.all([
        directorySearch(
          { tenant, memberRepo: membersDeps.memberRepo },
          {
            q: parsed.data.q,
            limit: parsed.data.limit ?? 10,
          },
        ),
        // 055-member-number — resolve the per-tenant display prefix ONCE via
        // the RLS-safe shared helper (mirrors the admin members-list page).
        // Falls back to the DEFAULT 'M' from the settings repo when no row exists.
        resolveMemberNumberPrefix(tenant, membersDeps.memberSettings),
      ]);
      if (membersResult.ok) {
        members = membersResult.value.items.map((row) => ({
          member_id: row.member.memberId,
          company_name: row.member.companyName,
          primary_contact_name: row.primaryContact
            ? `${row.primaryContact.firstName} ${row.primaryContact.lastName}`.trim()
            : null,
          status: row.member.status,
          url: `/admin/members/${row.member.memberId}`,
          // 055-member-number — format the display number (e.g. `SCCM-0042`)
          // using the prefix resolved above. `row.member.memberNumber` is
          // already a branded MemberNumber (validated by rowToMember) — pass
          // it straight through, no re-wrap needed.
          member_number_display: formatMemberNumber(
            memberPrefix,
            row.member.memberNumber,
          ),
        }));
      }
    } catch (e) {
      // Non-fatal — plans + registries already rendered. Log and
      // continue so a single-module outage doesn't blank the palette.
      logger.warn(
        // errKind only — a raw thrown error (e.g. NeonDbError) serialises its
        // .message/.stack with SQL/schema fragments into the log sink (n43 leak
        // class — the same hardening the server_error path below already has).
        { requestId: ctx.requestId, errKind: errKind(e) },
        'palette.members_search_failed',
      );
    }

    // F5 Phase 6 (T118 fuzzy-search variant) — refundable invoices.
    // Admin-only; no manager surface (refund is admin-only). Graceful
    // augmentation: a single-module outage on this fetch must NOT
    // blank the rest of the palette (plans + members already populated).
    let refundableInvoices: readonly PaletteRefundableInvoiceEntity[] = [];
    // 016 review C1 — evaluator-derived instead of the `role === 'admin'`
    // literal, which dropped this palette section for a promoted super_admin
    // while `POST /api/refunds/initiate` (the action these entries launch)
    // still admitted them. `legacyAdminOnly` reproduces the pre-016 arm
    // byte-for-byte; the ON leg follows `refunds.write`.
    // rbac-subgate-ok: an optional SECTION of an already-authorised palette
    // response, not admission to the surface (that is the `plans.read` gate).
    if (canPerform(ctx.current.user.role, 'refunds.write', legacyAdminOnly)) {
      try {
        const invoiceDeps = makeListInvoicesDeps(tenant.slug);
        const paid = await listInvoicesPaged(invoiceDeps, {
          tenantId: tenant.slug,
          status: 'paid',
          paidOnlineOnly: true,
          search: parsed.data.q,
          pageSize: parsed.data.limit ?? 10,
          offset: 0,
          includeDrafts: false,
        });
        if (paid.ok) {
          // Per-invoice remaining-refundable filter — drop any
          // candidate where the succeeded F5 payment has been fully
          // refunded out of band. Bounded to pageSize (max 10) so the
          // N+1 cost is capped; `Promise.all` parallelises the 10
          // tenant-scoped activity reads so palette latency stays
          // close to ~1×RTT instead of ~10×RTT.
          const activityDeps = makeLoadInvoicePaymentActivityDeps(tenant.slug);
          const activities = await Promise.all(
            paid.value.rows.map((inv) =>
              loadInvoicePaymentActivity(activityDeps, {
                tenantId: tenant.slug,
                invoiceId: String(inv.invoiceId),
              }).then((r) => ({ inv, result: r })),
            ),
          );
          // Aggregate per-invoice typed errors into a
          // `Map<errorKind, count>` capped at 5 distinct shapes —
          // best-effort attribution that covers the wide-outage case
          // where multiple error kinds fire at once. Distinct-kind
          // #6 onwards is dropped from the Map but counted in
          // `errorKindsTruncatedAt` so totals reconcile and operators
          // can spot when the cap was reached. Without this aggregator
          // only the first error survived; if 10 invoices failed
          // across 3 distinct error shapes, operators saw only one.
          const failedInvoiceIds: string[] = [];
          const errorKindCounts = new Map<string, number>();
          const ERROR_KIND_CAP = 5;
          const items: PaletteRefundableInvoiceEntity[] = [];
          for (const { inv, result } of activities) {
            if (!result.ok) {
              failedInvoiceIds.push(String(inv.invoiceId));
              const errorKind =
                (result.error as { code?: string; kind?: string }).code ??
                (result.error as { code?: string; kind?: string }).kind ??
                'unknown';
              if (
                errorKindCounts.has(errorKind) ||
                errorKindCounts.size < ERROR_KIND_CAP
              ) {
                errorKindCounts.set(
                  errorKind,
                  (errorKindCounts.get(errorKind) ?? 0) + 1,
                );
              }
              continue;
            }
            const remaining = computeRemainingRefundable(result.value);
            if (!remaining) continue;

            const total = inv.total ? Number(inv.total.satang) / 100 : 0;
            const memberCompany =
              (inv.memberIdentitySnapshot as { legal_name?: string } | null)
                ?.legal_name ?? '';
            items.push({
              invoice_id: String(inv.invoiceId),
              // 088 FR-030 — these rows are PAID → documentNumber-first via the
              // shared helper (documentNumber?.raw ?? receiptDocumentNumberRaw). Also
              // fixes the latent `String(valueObject)`→"[object Object]" bug: the
              // DocumentNumber VO has no toString, so read `.raw` via the helper.
              invoice_number: displayDocumentNumber(inv) ?? '',
              member_company_name: memberCompany,
              total_display: `${total.toFixed(2)} ${inv.currency}`,
              // RefundDialog auto-opens on `?refund=1`.
              url: `/admin/invoices/${String(inv.invoiceId)}?refund=1`,
            });
          }
          refundableInvoices = items;
          if (failedInvoiceIds.length > 0) {
            // R5-S10 — escalate warn → error when ≥10 invoices fail
            // (suggested threshold for "wide F5 outage"). SRE alert
            // rules keyed on error-level catch the wide outage;
            // warn-level remains for partial degradation (1-9 failed).
            const structured = {
              errorId: 'F2.PALETTE.REFUNDABLE_ACTIVITY_UNAVAILABLE',
              requestId: ctx.requestId,
              failedInvoiceIds,
              failedCount: failedInvoiceIds.length,
              // Map serialised to object for structured logs.
              // Keys are error codes/kinds; values are occurrence
              // counts.
              errorKindCounts: Object.fromEntries(errorKindCounts),
              errorKindsTruncatedAt:
                errorKindCounts.size >= ERROR_KIND_CAP
                  ? ERROR_KIND_CAP
                  : null,
            };
            const WIDE_OUTAGE_THRESHOLD = 10;
            if (failedInvoiceIds.length >= WIDE_OUTAGE_THRESHOLD) {
              logger.error(
                structured,
                'palette.refundable_invoice_activity_unavailable (wide outage)',
              );
            } else {
              logger.warn(
                structured,
                'palette.refundable_invoice_activity_unavailable',
              );
            }
          }
        } else {
          // Surface listInvoicesPaged Result.err (F5 disabled,
          // kill-switch flipped, RBAC drift, etc.). The outer
          // try/catch only handles thrown exceptions; a typed
          // Result.err would otherwise be invisible to ops. The
          // errorId provides alert-routing parity with the
          // F2.PLAN_CHANGE.* convention used in F8 callbacks.
          logger.warn(
            {
              errorId: 'F2.PALETTE.REFUNDABLE_LIST_UNAVAILABLE',
              requestId: ctx.requestId,
              err: paid.error,
            },
            'palette.refundable_invoices_list_unavailable',
          );
        }
      } catch (e) {
        logger.warn(
          {
            errorId: 'F2.PALETTE.REFUNDABLE_SEARCH_THREW',
            requestId: ctx.requestId,
            // errKind only (n43 leak class) — never the raw thrown error.
            errKind: errKind(e),
          },
          'palette.refundable_invoices_search_failed',
        );
      }
    }

    // Kill-switch strip (Presentation-layer gate — `env` is read HERE, in the
    // route, never in the Application-layer `searchPlans`, per Principle III).
    // Any registry entry tagged with a `feature` flag is dropped when that flag
    // is OFF, so ⌘K never surfaces a jump whose destination is proxy-503'd
    // (F7 → `/admin/broadcasts/**`), `notFound()` (F6 → `/admin/events/**`), or
    // absent (088 §86/4 receipt re-render on the legacy §87-at-issue flow).
    const enabledFeatures = {
      f6EventCreate: env.features.f6EventCreate,
      f7Broadcasts: env.features.f7Broadcasts,
      f088TaxAtPayment: env.features.f088TaxAtPayment,
    };
    const actions = filterPaletteEntriesByFeature(
      result.value.results.actions,
      enabledFeatures,
    );
    const navigate = filterPaletteEntriesByFeature(
      result.value.results.navigate,
      enabledFeatures,
    );

    return NextResponse.json(
      {
        results: {
          ...result.value.results,
          // 016 T064 — the endpoint gate widened to `dashboard.view` so every
          // staff role reaches the palette; plan HITS still need `plans.read`.
          // Emptied here rather than skipping the query: the plan list is an
          // in-memory filter over the tenant's ~9 plans, so there is no cost to
          // save, and one exit point is easier to prove than two.
          plans: canReadPlans ? result.value.results.plans : [],
          members: canReadMembers ? members : [],
          actions,
          navigate,
          refundableInvoices,
        },
      },
      { status: 200 },
    );
  }

  // server_error from use case (e.g. DB connection failure). Log only the
  // safe `errKind` classifier — never the raw error object, whose message
  // could carry SQL/schema fragments from a Postgres failure (n43 log-hygiene).
  logger.error(
    { requestId: ctx.requestId, errKind: result.error.errKind },
    'search-plans: server error',
  );
  return NextResponse.json(
    { error: { code: 'server_error', message: 'Internal server error.' } },
    { status: 500 },
  );
}
