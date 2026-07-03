/**
 * GET /api/plans/search (T080, US1/US6, contracts/plans-api.md § 11).
 *
 * Command palette backend. In-memory filter over current-year plans +
 * static action/navigate registries, role-filtered so managers never
 * see write actions.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { searchPlans } from '@/modules/plans';
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
  const ctx = await requireAdminContext(request, {
    resource: 'plan',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

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
  });

  if (result.ok) {
    // T069 — also search members for the palette. Ordering: plan
    // matches first, then members, mirroring the `groups.tsx` render
    // order. Member search is admin/manager-read-gated (the admin
    // context gate above already blocks the `member` role from
    // reaching this surface).
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
    if (ctx.current.user.role === 'admin') {
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
              // 088 FR-030 — these rows are PAID → receipt-first via the shared
              // helper (documentNumber?.raw ?? receiptDocumentNumberRaw). Also
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

    // 088 T021b / FR-035 — the "Re-render tax receipt" palette action is an 088
    // tax-at-payment concept (the §86/4 RC receipt is minted at payment). Strip
    // it when FEATURE_088_TAX_AT_PAYMENT is OFF so the legacy §87-at-issue flow
    // never surfaces an action it cannot fulfil. Presentation-layer gate: `env`
    // is read here (route), not in the Application-layer `searchPlans`.
    const actions = env.features.f088TaxAtPayment
      ? result.value.results.actions
      : result.value.results.actions.filter((a) => a.id !== 'invoice.rerenderReceipt');

    return NextResponse.json(
      {
        results: { ...result.value.results, actions, members, refundableInvoices },
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
