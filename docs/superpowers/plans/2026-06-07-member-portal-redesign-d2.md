# Member Portal Redesign — D2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (fresh subagent per task + two-stage review). Steps use `- [ ]` checkboxes.

**Goal:** Restructure the member-portal **Benefits** page into `[Benefits] [Broadcasts]` tabs, and consolidate **Account** settings + renewal preferences + data-export into a single `/portal/account` hub — presentation-only, reusing F7/F9/auth components, preserving every email-hardcoded route.

**Architecture:** D2 of the 3-deliverable portal redesign (D1 nav+dashboard+profile shipped via PR #72; D3 = Invoices polish, later). Two independent groups:
- **G1 — Benefits tabs:** `?tab=`-URL-driven Base UI Tabs; the **Broadcasts** tab relocates the e-blasts body (quota + Compose CTA + sent-history); `/portal/broadcasts/**` routes stay + the Benefits nav item keeps its active-state there (review M-2); `/portal/benefits/e-blasts` → `redirect()` (no 404).
- **G2 — Account hub:** one `/portal/account` page, real-`<h2>` sections + `#anchors`; embeds `RenewalRemindersToggle` (#renewal-prefs) + `DataExportPanel` (#data-privacy) + the EXISTING inline `ChangePasswordForm` (KEPT — decision C) + a "Forgot your password?" link → `/forgot-password` + locale + theme + sign-out. **SHIP BLOCKER:** `/portal/preferences/renewals` is hardcoded in renewal-reminder emails → it (and `/portal/account/data-export`) becomes a `redirect()` to the hub anchor (resolves, never 404).

**Tech Stack:** Next.js 16 App Router (RSC + `searchParams`) · Base UI Tabs (`src/components/ui/tabs.tsx`) · next-intl EN/TH/SV · existing F7 broadcasts + F9 insights + F1 auth components (reuse, no new backend) · Vitest + Playwright (`@axe-core/playwright`). RLS-safe session `memberId` reads; cross-tenant integration test per group (Principle I).

---

## File Structure

### G1 — Benefits page tabs [Benefits] [Broadcasts] (spec §4.4)
**Create**
- `src/app/(member)/portal/benefits/_components/benefits-tabs.tsx` — client wrapper: Base UI `Tabs` whose `value` is the active tab and whose `onValueChange` writes `?tab=` to the URL via `router.replace` (so deep-link/back/share work); renders the server-passed `benefitsPanel` + `broadcastsPanel` as children.
- `src/app/(member)/portal/benefits/_components/broadcasts-panel.tsx` — server component: the Broadcasts-tab body (QuotaDisplay + Compose CTA + sent-history table + `?page=` pagination), extracted verbatim from the current `e-blasts/page.tsx` so files stay small; renders a real `<h2>`.
- `tests/unit/portal/benefits-tab-param.test.ts` — pure-unit test for the `resolveBenefitsTab()` helper (param → `'benefits' | 'broadcasts'`, default + unknown clamp).
- `src/app/(member)/portal/benefits/_helpers/tabs.ts` — `resolveBenefitsTab(raw)` pure helper (the only logic that needs a fast unit test).
- `tests/unit/nav/benefits-broadcasts-active.test.ts` — regression: Benefits `activePattern` stays lit on `/portal/broadcasts/**` + `/portal/benefits` and is NOT lit on `/portal/invoices`.
- `tests/e2e/portal/benefits-tabs.spec.ts` — `@a11y`+behaviour: tab keyboard/`aria-selected`, deep-link `?tab=broadcasts`, `/portal/benefits/e-blasts` → no-404 redirect, each panel has a real `<h2>`.
- `tests/integration/broadcasts/benefits-tab-tenant-isolation.test.ts` — cross-tenant: member A's `listMemberBroadcasts` + `computeQuotaCounter` never return member B's rows/quota (Principle I).

**Modify**
- `src/app/(member)/portal/benefits/page.tsx` — read `searchParams.tab`, build both panels server-side, hand them to `<BenefitsTabs>`; the existing `BenefitUsageCard` becomes the Benefits-panel body.
- `src/app/(member)/portal/benefits/e-blasts/page.tsx` — replace the whole page body with a permanent server `redirect('/portal/benefits?tab=broadcasts')` (route preserved, no 404).
- `src/i18n/messages/en.json` — add `portal.benefits.tabs.{benefits,broadcasts}` + `portal.benefits.tabs.ariaLabel`.
- `src/i18n/messages/th.json` — same three keys (TH).
- `src/i18n/messages/sv.json` — same three keys (SV).

### G2 — Account hub `/portal/account` (sectioned + #anchors; route preservation for renewal-reminder emails)
**Create**
- `src/components/portal/portal-sign-out-button.tsx` — client Sign-out button for the Account-hub Appearance section (mobile has no avatar dropdown); reuses the exact `POST /api/auth/sign-out` + `router.push('/portal/sign-in')` + sonner-toast pattern lifted from `UserMenu`.
- `tests/unit/components/portal/portal-sign-out-button.test.tsx` — unit: renders a button, POSTs to `/api/auth/sign-out`, routes to `/portal/sign-in` on ok, toasts on failure.
- `tests/unit/app/portal/account-hub.test.tsx` — RSC structural test for the sectioned hub: real `<h2>` per section with correct `id` anchors + `scroll-mt` + Account/Renewal/Data&privacy/Appearance present.
- `tests/integration/portal/account-hub-cross-tenant.test.ts` — Principle I cross-tenant test: member A's renewal-opt-out flag / preferred-locale / data-export list never leak member B's values (all reads keyed by session `findByLinkedUserId`, never URL).
- `tests/e2e/portal/account-hub-route-safety.spec.ts` — `@route-safety` E2E: both legacy routes `/portal/preferences/renewals` and `/portal/account/data-export` resolve to the hub anchors (redirect, NOT 404); avatar deep-links land on the right section.

**Modify**
- `src/app/(member)/portal/account/page.tsx` — restructure into a sectioned hub: Account (email display + inline `ChangePasswordForm` [DECISION C — KEEP] + "Forgot your password?" link → `/forgot-password`, + `PreferredLocaleForm`) · Renewal preferences (`id="renewal-prefs"`, embed `RenewalRemindersToggle` + SSR `readRenewalRemindersOptedOut` seed) · Data & privacy (`id="data-privacy"`, embed `DataExportPanel` + `listMemberDataExports`, keep f9Dashboard gate) · Appearance (`ThemeToggle` + `PortalSignOutButton`). Real `<h2>` per section.
- `src/app/(member)/portal/preferences/renewals/page.tsx` — convert to `redirect('/portal/account#renewal-prefs')` (single source per §97; route still resolves so email hardcodes keep working).
- `src/app/(member)/portal/account/data-export/page.tsx` — convert to `redirect('/portal/account#data-privacy')` (route preserved, no 404).
- `src/components/shell/user-menu.tsx` — re-point member avatar links: Renewal → `/portal/account#renewal-prefs`, Data & privacy → `/portal/account#data-privacy`; update the stale doc comment (anchors are now live).
- `tests/unit/components/shell/user-menu.test.tsx` — update the two href assertions to the new anchors.
- `src/i18n/messages/en.json` — add `portal.account.sections.{account,renewalPrefs,dataPrivacy,appearance}` headings + `portal.account.forgotPassword`.
- `src/i18n/messages/th.json` — same keys, Thai.
- `src/i18n/messages/sv.json` — same keys, Swedish.

---

## Group 1 — G1 — Benefits page tabs [Benefits] [Broadcasts] (spec §4.4)

### Task 1 — i18n: add `portal.benefits.tabs.*` labels (EN/TH/SV)

The Broadcasts tab must NOT reuse the jargon "E-Blast" string (`nav.member.broadcasts` = "E-Blasts" — spec review S-6 wants "Broadcasts"). Give the tab strip its own namespace so no other consumer is affected.

**Step 1 — add the EN keys.** Open `src/i18n/messages/en.json`. There is no top-level `portal.benefits` object yet (verified — `portal.broadcasts` exists, `portal.benefits` is undefined). Add a new sibling under `portal`:

In `src/i18n/messages/en.json`, inside the `"portal"` object, add:

```json
"benefits": {
  "tabs": {
    "ariaLabel": "Benefits sections",
    "benefits": "Benefits",
    "broadcasts": "Broadcasts"
  }
},
```

**Step 2 — add the TH keys.** In `src/i18n/messages/th.json`, inside `"portal"`, add:

```json
"benefits": {
  "tabs": {
    "ariaLabel": "ส่วนสิทธิประโยชน์",
    "benefits": "สิทธิประโยชน์",
    "broadcasts": "การประกาศ"
  }
},
```

**Step 3 — add the SV keys.** In `src/i18n/messages/sv.json`, inside `"portal"`, add:

```json
"benefits": {
  "tabs": {
    "ariaLabel": "Förmånssektioner",
    "benefits": "Förmåner",
    "broadcasts": "Utskick"
  }
},
```

**Step 4 — run-green: i18n parity gate.**

```bash
pnpm check:i18n
```

Expect `0 missing keys`. (If a JSON merge collides with another branch's `portal.benefits`, fold the `tabs` object into the existing one rather than duplicating the key.)

**Commit:**

```
feat(portal): add portal.benefits.tabs i18n keys (EN/TH/SV) for Benefits/Broadcasts tabs
```

---

### Task 2 — `resolveBenefitsTab()` pure helper (red → green)

The server page needs a tiny, deterministic param→tab mapper (default `benefits`, clamp unknown). Isolate it so it's unit-tested without rendering.

**Step 1 — write the failing test.** Create `tests/unit/portal/benefits-tab-param.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveBenefitsTab, BENEFITS_TAB } from '@/app/(member)/portal/benefits/_helpers/tabs';

describe('resolveBenefitsTab (058 G1)', () => {
  it('defaults to benefits when param is absent', () => {
    expect(resolveBenefitsTab(undefined)).toBe(BENEFITS_TAB.benefits);
  });

  it('returns broadcasts when param is "broadcasts"', () => {
    expect(resolveBenefitsTab('broadcasts')).toBe(BENEFITS_TAB.broadcasts);
  });

  it('returns benefits when param is "benefits"', () => {
    expect(resolveBenefitsTab('benefits')).toBe(BENEFITS_TAB.benefits);
  });

  it('clamps an unknown value to the default benefits tab', () => {
    expect(resolveBenefitsTab('garbage')).toBe(BENEFITS_TAB.benefits);
  });
});
```

**Step 2 — run-red.**

```bash
pnpm vitest run tests/unit/portal/benefits-tab-param.test.ts
```

Expect failure: cannot resolve `_helpers/tabs`.

**Step 3 — minimal impl.** Create `src/app/(member)/portal/benefits/_helpers/tabs.ts`:

```ts
/**
 * 058 G1 — Benefits page tab identity (spec §4.4).
 *
 * The active tab is driven by the `?tab=` URL search param so deep-link /
 * back-button / share work. This pure helper maps the raw param onto the
 * closed tab union (default = benefits, unknown clamps to benefits). Kept
 * framework-free so it unit-tests without rendering.
 */
export const BENEFITS_TAB = {
  benefits: 'benefits',
  broadcasts: 'broadcasts',
} as const;

export type BenefitsTab = (typeof BENEFITS_TAB)[keyof typeof BENEFITS_TAB];

export function resolveBenefitsTab(raw: string | undefined): BenefitsTab {
  return raw === BENEFITS_TAB.broadcasts ? BENEFITS_TAB.broadcasts : BENEFITS_TAB.benefits;
}
```

**Step 4 — run-green.**

```bash
pnpm vitest run tests/unit/portal/benefits-tab-param.test.ts
```

Expect 4 passing.

**Commit:**

```
feat(portal): add resolveBenefitsTab helper for ?tab= URL-driven Benefits tabs
```

---

### Task 3 — nav regression test: Benefits tab stays lit on `/portal/broadcasts/**` (red → green)

`memberNavConfig` already sets the Benefits `activePattern` to `any:/portal/benefits|/portal/broadcasts` (verified from D1). Lock that with a regression test so a future edit can't silently break the spec §3/§4.4 / review M-2 requirement.

**Step 1 — write the test.** Create `tests/unit/nav/benefits-broadcasts-active.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  isNavItemActive,
  memberNavConfig,
  memberBottomTabItems,
} from '@/config/nav';

/** The Benefits nav item (top-nav) — looked up by href so a label change
 *  doesn't break the test. */
const benefitsItem = memberNavConfig.sections
  .flatMap((s) => s.items)
  .find((i) => 'href' in i && i.href === '/portal/benefits')!;

const benefitsTab = memberBottomTabItems.find((i) => i.href === '/portal/benefits')!;

describe('Benefits nav active-state on /portal/broadcasts/** (058 G1, review M-2)', () => {
  it('top-nav Benefits item exists with an any: multi-prefix pattern', () => {
    expect(benefitsItem).toBeDefined();
    expect(benefitsItem.activePattern).toBe('any:/portal/benefits|/portal/broadcasts');
  });

  it('is active on /portal/benefits', () => {
    expect(isNavItemActive('/portal/benefits', benefitsItem.activePattern)).toBe(true);
  });

  it('is active on /portal/benefits?tab=broadcasts base path', () => {
    // isNavItemActive matches pathname only (query is stripped by the caller)
    expect(isNavItemActive('/portal/benefits', benefitsItem.activePattern)).toBe(true);
  });

  it('stays active on /portal/broadcasts/new (compose route preserved)', () => {
    expect(isNavItemActive('/portal/broadcasts/new', benefitsItem.activePattern)).toBe(true);
  });

  it('stays active on /portal/broadcasts/<id> (detail route preserved)', () => {
    expect(
      isNavItemActive('/portal/broadcasts/3f1a-uuid', benefitsItem.activePattern),
    ).toBe(true);
  });

  it('is NOT active on /portal/invoices', () => {
    expect(isNavItemActive('/portal/invoices', benefitsItem.activePattern)).toBe(false);
  });

  it('mobile bottom-tab Benefits mirrors the same pattern', () => {
    expect(benefitsTab.activePattern).toBe('any:/portal/benefits|/portal/broadcasts');
    expect(isNavItemActive('/portal/broadcasts/new', benefitsTab.activePattern)).toBe(true);
  });
});
```

**Step 2 — run-green (this should pass immediately — D1 already wired the pattern).**

```bash
pnpm vitest run tests/unit/nav/benefits-broadcasts-active.test.ts
```

Expect 7 passing. If any FAIL, the D1 pattern regressed — fix `memberNavConfig` + `memberBottomTabItems` in `src/config/nav.ts` back to `any:/portal/benefits|/portal/broadcasts` before continuing (do NOT weaken the test).

**Commit:**

```
test(nav): lock Benefits active-state on /portal/broadcasts/** (review M-2 regression)
```

---

### Task 4 — extract the Broadcasts-tab body into `broadcasts-panel.tsx` (server component)

Move the entire current `e-blasts/page.tsx` body (QuotaDisplay + Compose CTA + history table + `?page=` pagination) into a reusable panel so the tabbed page stays small and the e-blasts route can become a thin redirect (Task 6).

**Step 1 — create the panel.** Create `src/app/(member)/portal/benefits/_components/broadcasts-panel.tsx`. This is the existing e-blasts page body, lifted verbatim, with three changes: (a) it is a named async component `BroadcastsPanel`, not a default page; (b) it takes `requestedPage: number` as a prop instead of parsing `searchParams` (the tabbed page parses it); (c) pagination `<Link>` hrefs target `/portal/benefits?tab=broadcasts&page=N` so `?tab=` and `?page=` coexist; (d) the title becomes a real `<h2 id="broadcasts-panel-heading">` for the panel landmark.

```tsx
/**
 * 058 G1 — Broadcasts tab body (spec §4.4), extracted from the former
 * /portal/benefits/e-blasts page so the tabbed Benefits page stays thin and
 * the e-blasts route can become a redirect (route preserved, no 404).
 *
 * Server component. memberId is resolved from the session via
 * findByLinkedUserId — NEVER from the URL (RLS self-scoping, mirrors the
 * /portal/timeline + /portal/benefits pattern). Pagination uses the existing
 * ?page=N param; the tabbed page threads it in as `requestedPage` and the
 * pagination links keep `?tab=broadcasts` so the two params coexist.
 */
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Mail } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/shell/empty-state';
import { QuotaDisplay } from '@/components/broadcast/quota-display';
import { ComposeButtonWithTooltip } from '@/components/broadcast/compose-button-with-tooltip';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  computeQuotaCounter,
  listMemberBroadcasts,
  makeComputeQuotaDeps,
  makeListMemberBroadcastsDeps,
} from '@/modules/broadcasts';
import { asMemberId } from '@/modules/members';
import type { IanaTimezone } from '@/modules/tenants';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  intlLocale,
  shouldShowPlanChangedExplainer,
} from '../e-blasts/_helpers/quota-banner';

const PER_PAGE = 10;

export async function BroadcastsPanel({
  requestedPage,
}: {
  readonly requestedPage: number;
}): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.list');
  const tStatus = await getTranslations('portal.broadcasts.list.status');
  const tCompose = await getTranslations('portal.broadcasts.compose');
  const tQuota = await getTranslations('portal.broadcasts.quota');
  const tPagination = await getTranslations('portal.broadcasts.list.pagination');
  const locale = await getLocale();
  const dateFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const dateOnlyFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'long',
  });

  const session = await requireSession('member');
  const tenant = resolveTenantFromRequest();
  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(tenant, session.user.id);
  const memberId = memberLookup.ok ? memberLookup.value.memberId : null;

  let quota: {
    used: number;
    reserved: number;
    remaining: number;
    cap: number;
    quotaYear: number;
    nextResetAt: string;
    tenantTimezone: IanaTimezone;
  } | null = null;
  let nextResetCopy: string | null = null;
  let planChangedExplainer: string | null = null;
  let history: Array<{
    broadcastId: string;
    subject: string;
    status: string;
    submittedAt: Date | null;
    sentAt: Date | null;
    estimatedRecipientCount: number;
  }> = [];
  let pagination = { page: 1, totalPages: 0, total: 0 };

  if (memberId !== null) {
    const [quotaResultS, planLookupS, listResultS] = await Promise.allSettled([
      computeQuotaCounter(makeComputeQuotaDeps(tenant.slug), { memberId }),
      membersDeps.memberRepo.findLastPlanChangedAt(tenant, asMemberId(memberId)),
      listMemberBroadcasts(makeListMemberBroadcastsDeps(tenant.slug), {
        memberId,
        page: requestedPage,
        perPage: PER_PAGE,
      }),
    ]);

    const quotaResult = quotaResultS.status === 'fulfilled' ? quotaResultS.value : null;
    const planLookup = planLookupS.status === 'fulfilled' ? planLookupS.value : null;

    if (quotaResult && quotaResult.ok) {
      const v = quotaResult.value;
      quota = {
        used: v.counter.used,
        reserved: v.counter.reserved,
        remaining: v.counter.remaining,
        cap: v.counter.cap,
        quotaYear: v.quotaYear,
        nextResetAt: v.nextResetAt,
        tenantTimezone: v.tenantTimezone,
      };
      nextResetCopy = tQuota('nextReset', {
        date: dateOnlyFormatter.format(new Date(v.nextResetAt)),
      });
      if (planLookup && !planLookup.ok) {
        logger.error(
          { err: planLookup.error, tenantId: tenant.slug, memberId },
          'broadcasts.benefits_tab.find_last_plan_changed_at_failed',
        );
      }
      const lastPlanChangedAt = planLookup && planLookup.ok ? planLookup.value : null;
      if (
        lastPlanChangedAt !== null &&
        shouldShowPlanChangedExplainer(lastPlanChangedAt, v.quotaYear, v.tenantTimezone)
      ) {
        const planChangedFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
          dateStyle: 'long',
          timeZone: v.tenantTimezone,
        });
        planChangedExplainer = tQuota('planChangedExplainer', {
          date: planChangedFormatter.format(lastPlanChangedAt),
        });
      }
    } else {
      const err =
        quotaResultS.status === 'rejected'
          ? quotaResultS.reason
          : quotaResult && !quotaResult.ok
            ? quotaResult.error
            : null;
      logger.error(
        { err, tenantId: tenant.slug, memberId },
        'broadcasts.benefits_tab.compute_quota_counter_failed',
      );
    }

    if (listResultS.status === 'fulfilled') {
      const listResult = listResultS.value;
      pagination = {
        page: listResult.page,
        totalPages: listResult.totalPages,
        total: listResult.total,
      };
      history = listResult.rows.map((b) => ({
        broadcastId: b.broadcastId as string,
        subject: b.subject,
        status: b.status,
        submittedAt: b.submittedAt,
        sentAt: b.sentAt,
        estimatedRecipientCount: b.estimatedRecipientCount,
      }));
    } else {
      logger.error(
        { err: listResultS.reason, tenantId: tenant.slug, memberId, page: requestedPage },
        'broadcasts.benefits_tab.list_history_failed',
      );
    }
  }

  const composeDisabled = quota !== null && quota.remaining === 0;

  return (
    <section aria-labelledby="broadcasts-panel-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="broadcasts-panel-heading" className="font-heading text-base font-medium leading-snug">
          {t('title')}
        </h2>
        {composeDisabled ? (
          <ComposeButtonWithTooltip
            label={tCompose('title')}
            tooltipText={t('quotaExhaustedTooltip', {
              year: quota?.quotaYear ?? new Date().getFullYear(),
            })}
          />
        ) : (
          <Link href="/portal/broadcasts/new" className={buttonVariants({ variant: 'default' })}>
            {tCompose('title')}
          </Link>
        )}
      </div>

      <QuotaDisplay
        initial={quota}
        nextResetCopy={nextResetCopy}
        planChangedExplainer={planChangedExplainer}
      />

      {history.length === 0 ? (
        <EmptyState
          data-testid="broadcast-empty-state"
          icon={Mail}
          title={t('emptyTitle')}
          description={t('empty')}
          action={
            composeDisabled ? undefined : (
              <Link href="/portal/broadcasts/new" className={buttonVariants({ size: 'sm' })}>
                {t('emptyCta')}
              </Link>
            )
          }
        />
      ) : (
        <Card>
          <CardContent>
            <Table
              data-testid="broadcast-history-table"
              aria-label={t('title')}
              className="min-w-[640px]"
            >
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('columns.subject')}</TableHead>
                  <TableHead scope="col">{t('columns.status')}</TableHead>
                  <TableHead scope="col">{t('columns.audience')}</TableHead>
                  <TableHead scope="col">{t('columns.submittedAt')}</TableHead>
                  <TableHead scope="col">{t('columns.sentAt')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((row) => {
                  const statusKey = row.status as Parameters<typeof tStatus>[0];
                  const statusLabel = tStatus.has(statusKey) ? tStatus(statusKey) : row.status;
                  return (
                    <TableRow key={row.broadcastId}>
                      <TableCell>
                        <Link
                          href={`/portal/broadcasts/${row.broadcastId}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {row.subject}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{statusLabel}</Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">{row.estimatedRecipientCount}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.submittedAt !== null
                          ? dateFormatter.format(new Date(row.submittedAt))
                          : '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.sentAt !== null ? dateFormatter.format(new Date(row.sentAt)) : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {pagination.totalPages > 1 ? (
        <nav
          data-testid="broadcast-history-pagination"
          aria-label={tPagination('ariaLabel')}
          className="flex items-center justify-between text-sm"
        >
          {pagination.page > 1 ? (
            <Link
              href={`/portal/benefits?tab=broadcasts&page=${pagination.page - 1}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              data-testid="pagination-prev"
            >
              {tPagination('previous')}
            </Link>
          ) : (
            <span
              aria-disabled="true"
              data-testid="pagination-prev"
              className={`${buttonVariants({ variant: 'outline', size: 'sm' })} cursor-not-allowed opacity-50 pointer-events-none`}
            >
              {tPagination('previous')}
            </span>
          )}
          <span className="text-muted-foreground">
            {tPagination('pageOf', { page: pagination.page, total: pagination.totalPages })}
          </span>
          {pagination.page < pagination.totalPages ? (
            <Link
              href={`/portal/benefits?tab=broadcasts&page=${pagination.page + 1}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              data-testid="pagination-next"
            >
              {tPagination('next')}
            </Link>
          ) : (
            <span
              aria-disabled="true"
              data-testid="pagination-next"
              className={`${buttonVariants({ variant: 'outline', size: 'sm' })} cursor-not-allowed opacity-50 pointer-events-none`}
            >
              {tPagination('next')}
            </span>
          )}
        </nav>
      ) : null}
    </section>
  );
}
```

**Step 2 — update `benefits/loading.tsx` to a tab-aware skeleton.** The current `src/app/(member)/portal/benefits/loading.tsx` (verified) renders only `<BenefitUsageSkeleton>` with no tab strip. After adding the `[Benefits] [Broadcasts]` tabs, a `?tab=broadcasts` deep-link will flash the wrong skeleton shape (no tab strip, wrong panel height — CLS per spec §10). Update it to show a neutral skeleton that includes a two-tab shimmer above the panel placeholder:

```tsx
/**
 * Route-level loading skeleton for `/portal/benefits` (ux-standards § 2.1).
 * Updated for 058 G1: shows a two-tab shimmer + panel skeleton so a
 * ?tab=broadcasts deep-link doesn't flash the wrong shape (CLS = 0 per §10).
 */
import { DetailContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';
import { BenefitUsageSkeleton } from '@/components/benefits/benefit-usage-skeleton';

export default function Loading() {
  return (
    <DetailContainer>
      {/* Tab strip shimmer — two tabs, matches BenefitsTabs chrome dimensions */}
      <div className="flex gap-2 border-b pb-0 mb-4" aria-hidden>
        <Skeleton className="h-9 w-24 rounded-sm" />
        <Skeleton className="h-9 w-24 rounded-sm" />
      </div>
      {/* Panel skeleton — neutral (not broadcasts-specific, so both tabs are correct) */}
      <BenefitUsageSkeleton />
    </DetailContainer>
  );
}
```

Adjust tab width values (`w-24`) to match the rendered `TabsTrigger` size if the a11y E2E (Task 7) reveals CLS. The skeleton intentionally reuses `BenefitUsageSkeleton` as the panel body (it is a neutral shimmer, not benefit-specific) — if a Broadcasts-specific skeleton is needed later, that is a follow-up.

**Step 3 — typecheck (the file references real barrels; catch any import drift now).**

```bash
pnpm typecheck
```

Expect clean. (If `pnpm dev` is running, the dev-server `.next/dev/types` can mask errors — per MEMORY, get a true check via a temp tsconfig excluding `.next` if anything looks off.)

**Commit:**

```
feat(portal): extract BroadcastsPanel server component; update benefits/loading.tsx tab-aware skeleton
```

---

### Task 5 — `BenefitsTabs` client wrapper + wire the tabbed page (red → green)

The page reads `?tab=` server-side and renders the active panel for correct SSR/deep-link; the client wrapper renders the Base UI `Tabs` chrome and writes `?tab=` on tab change so back-button/share work.

**Step 1 — write the failing e2e-shaped behaviour test as a unit smoke of the page export.** (The full a11y/behaviour e2e is Task 7.) Create the client wrapper first since the page imports it. Create `src/app/(member)/portal/benefits/_components/benefits-tabs.tsx`:

```tsx
'use client';

/**
 * 058 G1 — Benefits page tab chrome (spec §4.4).
 *
 * The ACTIVE PANEL is chosen server-side (the page reads ?tab= and only
 * passes the body it rendered) — but Base UI Tabs still needs both triggers
 * + both panels mounted to give keyboard roving + aria-selected. We mount
 * both panel slots; the server passes the active body and a null for the
 * inactive one (the inactive panel is an empty, hidden tabpanel until the
 * user switches, at which point we navigate so the server renders it).
 *
 * onValueChange writes ?tab= via router.replace (history-replace, not push,
 * so the back button leaves the Benefits page rather than cycling tabs) and
 * resets ?page= (pagination is broadcast-tab-scoped). Deep-link / share work
 * because the param is the source of truth.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { BENEFITS_TAB, type BenefitsTab } from '../_helpers/tabs';

export function BenefitsTabs({
  active,
  benefitsPanel,
  broadcastsPanel,
}: {
  readonly active: BenefitsTab;
  readonly benefitsPanel: React.ReactNode;
  readonly broadcastsPanel: React.ReactNode;
}): React.ReactElement {
  const t = useTranslations('portal.benefits.tabs');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onValueChange(value: string) {
    const next = value === BENEFITS_TAB.broadcasts ? BENEFITS_TAB.broadcasts : BENEFITS_TAB.benefits;
    startTransition(() => {
      // ?tab= drives the server-rendered active panel; drop ?page= on switch.
      router.replace(`/portal/benefits?tab=${next}`);
    });
  }

  return (
    <Tabs value={active} onValueChange={onValueChange} aria-busy={isPending}>
      <TabsList aria-label={t('ariaLabel')} variant="line">
        <TabsTrigger value={BENEFITS_TAB.benefits}>{t('benefits')}</TabsTrigger>
        <TabsTrigger value={BENEFITS_TAB.broadcasts}>{t('broadcasts')}</TabsTrigger>
      </TabsList>
      <TabsContent value={BENEFITS_TAB.benefits} className="pt-4">
        {active === BENEFITS_TAB.benefits ? benefitsPanel : null}
      </TabsContent>
      <TabsContent value={BENEFITS_TAB.broadcasts} className="pt-4">
        {active === BENEFITS_TAB.broadcasts ? broadcastsPanel : null}
      </TabsContent>
    </Tabs>
  );
}
```

**Step 2 — rewrite the page to read `?tab=` + `?page=` and compose both panels.** Replace the body of `src/app/(member)/portal/benefits/page.tsx`. Keep the existing member-resolution + `computeBenefitUsage` for the Benefits panel; wrap the `BenefitUsageCard` in a real `<h2>`-bearing `<section>` and pass the panels into `BenefitsTabs`:

```tsx
/**
 * 058 G1 — /portal/benefits with tabs [Benefits] [Broadcasts] (spec §4.4).
 *
 * Active tab is driven by ?tab=benefits|broadcasts (default benefits) so
 * deep-link / back-button / share work. The active panel is rendered
 * SERVER-side (correct SSR + no client data-fetch); the client <BenefitsTabs>
 * supplies the tab chrome + keyboard roving + writes ?tab= on switch.
 *
 * memberId is resolved from the session (findByLinkedUserId) — NEVER the URL.
 */
import type { Metadata } from 'next';
import { UserX } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { insightsMetrics } from '@/lib/metrics';
import { computeBenefitUsage, makeComputeBenefitUsageDeps } from '@/modules/insights';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import {
  BenefitUsageCard,
  type BenefitUsageItem,
} from '@/components/benefits/benefit-usage-card';
import { BenefitsTabs } from './_components/benefits-tabs';
import { BroadcastsPanel } from './_components/broadcasts-panel';
import { resolveBenefitsTab, BENEFITS_TAB } from './_helpers/tabs';

const EBLAST_COMPOSE_HREF = '/portal/broadcasts/new';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('benefits.page');
  return { title: t('title') };
}

export default async function PortalBenefitsPage(props: {
  searchParams: Promise<{ tab?: string; page?: string }>;
}) {
  const { user } = await requireSession('member');
  const tenant = resolveTenantFromRequest();
  const t = await getTranslations('benefits.page');
  const locale = await getLocale();
  const { tab, page } = await props.searchParams;
  const activeTab = resolveBenefitsTab(tab);

  // Same page-clamp rule the old e-blasts page used (probe/typo defence).
  const rawPage = Number(page ?? '1') || 1;
  const requestedPage = Math.min(1_000, Math.max(1, rawPage));

  const deps = buildMembersDeps(tenant);
  const memberResult = await deps.memberRepo.findByLinkedUserId(tenant, user.id);
  if (!memberResult.ok) {
    if (memberResult.error.code !== 'repo.not_found') {
      logger.error(
        { errKind: errKind(memberResult.error) },
        'portal.benefits.member_lookup_failed',
      );
      throw new Error('Failed to load member for benefits');
    }
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitleMember')} />
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <UserX aria-hidden="true" className="size-10 text-muted-foreground/60" />
            <p className="text-lg font-semibold">{t('emptyTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </CardContent>
        </Card>
      </DetailContainer>
    );
  }
  const member = memberResult.value;

  // Only compute the (heavier) benefit-usage read when the Benefits tab is
  // active — the Broadcasts panel does its own reads.
  let benefitsPanel: React.ReactNode = null;
  if (activeTab === BENEFITS_TAB.benefits) {
    const result = await computeBenefitUsage(
      tenant,
      { memberId: member.memberId },
      makeComputeBenefitUsageDeps(tenant.slug),
    );
    if (!result.ok) {
      throw new Error(`computeBenefitUsage failed: ${result.error.code}`);
    }
    const usage = result.value;
    insightsMetrics.benefitViewed('member', tenant.slug);
    const quantifiable: BenefitUsageItem[] = usage.quantifiable.map((b) =>
      b.key === 'eblast' ? { ...b, actionHref: EBLAST_COMPOSE_HREF } : { ...b },
    );
    benefitsPanel = (
      <BenefitUsageCard
        locale={locale}
        membershipYear={usage.membershipYear}
        elapsedYearPct={usage.elapsedYearPct}
        quantifiable={quantifiable}
        active={usage.active}
        aggregateConsumedPct={usage.aggregateConsumedPct}
        underUseWarning={usage.underUseWarning}
        warningActionHref={EBLAST_COMPOSE_HREF}
        headingId="benefits-panel-heading"
      />
    );
  }

  const broadcastsPanel =
    activeTab === BENEFITS_TAB.broadcasts ? (
      <BroadcastsPanel requestedPage={requestedPage} />
    ) : null;

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitleMember')} />
      <BenefitsTabs
        active={activeTab}
        benefitsPanel={benefitsPanel}
        broadcastsPanel={broadcastsPanel}
      />
    </DetailContainer>
  );
}
```

Note: `BenefitUsageCard`'s `headingId` makes its title a real `<h2 id>` (already supported — verified). The Broadcasts panel supplies its own `<h2>`. This satisfies the a11y "real `<h2>` per panel" rule.

**Step 2b — decide on `revalidate` for the composite page.** The current `e-blasts/page.tsx` sets `export const revalidate = 60` (verified: line 57, plan.md § Cold-start, caching, & memoisation CHK056). After moving the Broadcasts body into `BroadcastsPanel` under the benefits page, the quota counter / broadcast list reads are behind the same 60-second ISR window unless we carry the export forward.

Add the following line to `src/app/(member)/portal/benefits/page.tsx` (at module level, alongside `generateMetadata`):

```ts
/** 60-second segment-level revalidate — carried forward from the former
 *  /portal/benefits/e-blasts page (CHK056). Keeps the composite Benefits page
 *  within the §10 TTFB budget; without it the page opts into the default
 *  dynamic (no-store) rendering for server-component data reads. */
export const revalidate = 60;
```

If after profiling the composite TTFB is within the §10 budget WITHOUT the segment revalidate (i.e. the page is dynamic and still fast enough), remove this export and leave a one-line comment explaining the measurement. Do NOT silently drop the revalidate without a measurement.

**Step 3 — run-green: existing tests + typecheck.**

```bash
pnpm vitest run tests/unit/nav/benefits-broadcasts-active.test.ts tests/unit/portal/benefits-tab-param.test.ts && pnpm typecheck
```

Expect all passing + typecheck clean.

**Commit:**

```
feat(portal): tab the Benefits page into [Benefits] [Broadcasts] via ?tab= (spec §4.4)
```

---

### Task 6 — convert `/portal/benefits/e-blasts` to a redirect (route safety, red → green)

The route is referenced by the broadcast-detail back-link and the FR-009 cap=0 compose redirect. It MUST still resolve (no 404) — redirect it to the new tab.

**Step 1 — write the failing route-safety test.** Create `tests/unit/portal/e-blasts-redirect.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

// next/navigation redirect throws a control-flow signal in app-router; capture
// the target instead of executing the throw.
const redirectSpy = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({ redirect: redirectSpy }));

describe('/portal/benefits/e-blasts route preservation (058 G1)', () => {
  it('redirects to /portal/benefits?tab=broadcasts (no 404)', async () => {
    const mod = await import('@/app/(member)/portal/benefits/e-blasts/page');
    await expect(mod.default()).rejects.toThrow('REDIRECT:/portal/benefits?tab=broadcasts');
    expect(redirectSpy).toHaveBeenCalledWith('/portal/benefits?tab=broadcasts');
  });
});
```

**Step 2 — run-red.**

```bash
pnpm vitest run tests/unit/portal/e-blasts-redirect.test.ts
```

Expect failure (current default export reads `searchParams` + renders, doesn't redirect).

**Step 3 — replace the e-blasts page with a redirect.** Replace the entire contents of `src/app/(member)/portal/benefits/e-blasts/page.tsx`:

```tsx
/**
 * 058 G1 — /portal/benefits/e-blasts is now a tab inside /portal/benefits
 * (spec §4.4). The ROUTE IS PRESERVED (the broadcast-detail back-link and the
 * FR-009 cap=0 compose redirect both target it) — a 404 here would break those
 * deep-links, so we permanently redirect to the Broadcasts tab.
 *
 * The `_helpers/quota-banner.ts` module stays — BroadcastsPanel + the broadcast
 * detail page still import it.
 */
import { redirect } from 'next/navigation';

export default async function EblastsRedirectPage(): Promise<never> {
  redirect('/portal/benefits?tab=broadcasts');
}
```

**Step 4 — run-green.**

```bash
pnpm vitest run tests/unit/portal/e-blasts-redirect.test.ts
```

Expect 1 passing.

**Commit:**

```
feat(portal): redirect /portal/benefits/e-blasts to ?tab=broadcasts (route preserved, no 404)
```

---

### Task 7 — e2e: tab a11y + deep-link + redirect (`@a11y`)

Assert the spec §7 a11y contract (keyboard, `aria-selected`, real `<h2>` per panel), the `?tab=` deep-link, and the e-blasts redirect against a signed-in member.

**Step 1 — write the e2e spec.** Create `tests/e2e/portal/benefits-tabs.spec.ts`:

```ts
/**
 * 058 G1 — Benefits tabs [Benefits] [Broadcasts] (spec §4.4) E2E + @a11y.
 *
 * Requires E2E_MEMBER_* in .env.local. Run:
 *   pnpm test:e2e --grep "@a11y" --workers=1
 * (320px target-size / reflow + dev-server sign-in flakes are EXPECTED noise on
 * LOCAL dev per MEMORY — authoritative run is on the preview deploy.)
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../fixtures';
import { signInAsMember } from '../helpers/member-session';

test.describe('Benefits tabs @a11y', () => {
  test('default tab = Benefits; renders a real <h2>', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/benefits');
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    // Benefits tab selected by default.
    await expect(page.getByRole('tab', { name: /benefits|förmåner|สิทธิประโยชน์/i }).first())
      .toHaveAttribute('aria-selected', 'true');
    // BenefitUsageCard title is a real heading (headingId → <h2>).
    await expect(page.locator('#benefits-panel-heading')).toBeVisible();
  });

  test('deep-link ?tab=broadcasts opens the Broadcasts panel with its own <h2>', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/benefits?tab=broadcasts');
    await expect(page.getByRole('tab', { name: /broadcasts|utskick|การประกาศ/i }))
      .toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#broadcasts-panel-heading')).toBeVisible();
    // Quota display + compose CTA are in the Broadcasts panel.
    await expect(page.getByTestId('quota-display')).toBeVisible();
  });

  test('keyboard: ArrowRight moves selection to the Broadcasts tab', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/benefits');
    await page.getByRole('tab').first().focus();
    await page.keyboard.press('ArrowRight');
    // Base UI Tabs activates on focus by default and onValueChange fires
    // router.replace → re-render, making toBeFocused() racy. Instead assert
    // aria-selected after waitFor (stable because the DOM attribute is set
    // synchronously by Base UI on the new active tab) OR assert the URL update.
    await expect(page.getByRole('tab', { name: /broadcasts|utskick|การประกาศ/i }))
      .toHaveAttribute('aria-selected', 'true');
    // URL assertion is the canonical source of truth for tab state in this design.
    await expect(page).toHaveURL(/\/portal\/benefits\?tab=broadcasts/);
  });

  test('/portal/benefits/e-blasts redirects to the Broadcasts tab (no 404)', async ({ page }) => {
    await signInAsMember(page);
    const resp = await page.goto('/portal/benefits/e-blasts');
    expect(resp?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/portal\/benefits\?tab=broadcasts/);
    await expect(page.locator('#broadcasts-panel-heading')).toBeVisible();
  });

  test('axe: 0 violations on the Broadcasts tab', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/benefits?tab=broadcasts');
    await page.getByTestId('quota-display').waitFor();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
```

**Step 2 — run-green (member creds required in `.env.local`; clear rate-limits by re-running if sign-in times out — global-setup auto-clears).**

```bash
pnpm test:e2e --grep "Benefits tabs" --workers=1
```

Expect passing (treat known LOCAL 320px target-size / sign-in-flake noise per MEMORY; authoritative run is the preview deploy).

**Commit:**

```
test(e2e): Benefits tabs a11y + ?tab= deep-link + e-blasts redirect (@a11y)
```

---

### Task 8 — cross-tenant integration test: member A's broadcasts/quota ≠ member B (Principle I, red → green)

Group-closing Review-Gate blocker. Prove that the two reads the Broadcasts tab depends on — `listMemberBroadcasts` + `computeQuotaCounter` (through their barrels) — never surface another tenant's member's data.

**Step 1 — write the test.** Create `tests/integration/broadcasts/benefits-tab-tenant-isolation.test.ts` (mirrors `us3-tenant-isolation.test.ts` seeding):

```ts
/**
 * 058 G1 cross-tenant integration test (Principle I clause 3 — Review-Gate
 * blocker). The Benefits → Broadcasts tab reads via listMemberBroadcasts +
 * computeQuotaCounter (barrels). This proves member A's tenant context never
 * returns member B's (other-tenant) broadcasts or quota. Live Neon Singapore.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  computeQuotaCounter,
  listMemberBroadcasts,
  makeComputeQuotaDeps,
  makeListMemberBroadcastsDeps,
} from '@/modules/broadcasts';
import { asMemberId } from '@/modules/members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 3,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

describe('058 G1 Benefits→Broadcasts tab tenant isolation (Principle I)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let aMemberId: string;
  let bMemberId: string;
  let aBroadcastId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    for (const [t, label] of [[tenantA, 'a'] as const, [tenantB, 'b'] as const]) {
      const planId = `g1-iso-${randomUUID().slice(0, 8)}`;
      const memberUuid = randomUUID();
      if (label === 'a') aMemberId = memberUuid;
      else bMemberId = memberUuid;

      await runInTenant(t.ctx, async (tx) => {
        await tx.insert(tenantInvoiceSettings).values({
          tenantId: t.ctx.slug,
          currencyCode: 'THB',
          vatRate: '0.0700',
          registrationFeeSatang: 100000n,
          legalNameTh: 'TH',
          legalNameEn: 'EN',
          taxId: '0000000000000',
          registeredAddressTh: 'TH',
          registeredAddressEn: 'EN',
          invoiceNumberPrefix: 'INV',
          creditNoteNumberPrefix: 'CN',
        });
        await tx.insert(membershipPlans).values({
          tenantId: t.ctx.slug,
          planId,
          planYear: 2026,
          planName: { en: 'Iso Plan' },
          description: { en: 'desc' },
          sortOrder: 10,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 500_000,
          includesCorporatePlanId: null,
          minTurnoverMinorUnits: null,
          maxTurnoverMinorUnits: null,
          maxDurationYears: null,
          maxMemberAge: null,
          benefitMatrix: MATRIX,
          isActive: true,
          createdBy: user.userId,
          updatedBy: user.userId,
        });
        await tx.insert(members).values({
          tenantId: t.ctx.slug,
          memberId: memberUuid,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Iso Co ${label}`,
          country: 'TH',
          planId,
          planYear: 2026,
          registrationDate: new Date().toISOString().slice(0, 10),
          registrationFeePaid: true,
          status: 'active',
        });
      });

      const broadcastUuid = randomUUID();
      if (label === 'a') aBroadcastId = broadcastUuid;
      // Seed via owner role (BYPASS RLS) — repo reads below run in runInTenant
      // so they are tenant-scoped at read time.
      await db.insert(broadcasts).values({
        tenantId: t.ctx.slug,
        broadcastId: broadcastUuid,
        requestedByMemberId: memberUuid,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: `Iso ${label}`,
        bodyHtml: '<p>x</p>',
        bodySource: 'plain',
        fromName: `Iso Co ${label}`,
        replyToEmail: 'iso@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'sent',
        retentionYears: 5,
      });
    }
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('listMemberBroadcasts — tenantA context, tenantB memberId → empty (no leak)', async () => {
    const result = await runInTenant(tenantA.ctx, async () =>
      listMemberBroadcasts(makeListMemberBroadcastsDeps(tenantA.ctx.slug), {
        memberId: bMemberId,
        page: 1,
        perPage: 10,
      }),
    );
    expect(result.total).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it('listMemberBroadcasts — tenantA sees its own member broadcast', async () => {
    const result = await runInTenant(tenantA.ctx, async () =>
      listMemberBroadcasts(makeListMemberBroadcastsDeps(tenantA.ctx.slug), {
        memberId: aMemberId,
        page: 1,
        perPage: 10,
      }),
    );
    expect(result.total).toBe(1);
    expect(result.rows[0]?.broadcastId as string).toBe(aBroadcastId);
  });

  it('computeQuotaCounter — tenantA context, tenantB memberId → no cross-tenant quota', async () => {
    const result = await runInTenant(tenantA.ctx, async () =>
      computeQuotaCounter(makeComputeQuotaDeps(tenantA.ctx.slug), {
        memberId: asMemberId(bMemberId),
      }),
    );
    // B's member is invisible under A's RLS context → the use-case cannot
    // resolve a cap from B's plan; it must NOT return B's used=1 counter.
    if (result.ok) {
      expect(result.value.counter.used).toBe(0);
    } else {
      // member_not_found under A's context is the equally-correct isolation
      // outcome (B's member row is RLS-hidden from A).
      expect(result.error.code).toMatch(/not_found/);
    }
  });
});
```

**Step 2 — apply migrations + run-green against live Neon (per MEMORY: schema-touching reads must run integration, not mocks).**

```bash
pnpm drizzle-kit migrate && pnpm test:integration -- benefits-tab-tenant-isolation
```

Expect 3 passing. If `computeQuotaCounter`'s `member_not_found` code differs, adjust the `.toMatch(/not_found/)` arm to the actual code (read it from the assertion failure) — do NOT loosen the `used).toBe(0)` / `total).toBe(0)` isolation assertions.

**Commit:**

```
test(broadcasts): cross-tenant integration for Benefits→Broadcasts tab reads (Principle I)
```

---

### Task 9 — final group gate: full check sweep

Run the relevant gates end-to-end before handing G1 off, with `pnpm typecheck` as the FINAL step (per MEMORY — pre-push does not run it, and an earlier typecheck misses errors from later edits).

**Step 1 — i18n + the touched vitest subset + lint.**

```bash
pnpm check:i18n && pnpm vitest run tests/unit/nav/benefits-broadcasts-active.test.ts tests/unit/portal/benefits-tab-param.test.ts tests/unit/portal/e-blasts-redirect.test.ts && pnpm lint
```

**Step 2 — typecheck LAST (if `pnpm dev` is running, the `.next/dev/types` parse can mask real errors — get a true check via a temp tsconfig that excludes `.next` and runs non-incremental `npx tsc -p` per MEMORY).**

```bash
pnpm typecheck
```

Expect all green. No commit (verification-only); if anything fails, fix in the owning task's file and re-commit there.

---

## Group 2 — G2 — Account hub `/portal/account` (sectioned + #anchors; route preservation for renewal-reminder emails)

## G2 — Account hub `/portal/account`

Restructure the member account page (spec §4.5 + §97) into ONE sectioned hub URL with real `<h2>` sections + `#renewal-prefs` / `#data-privacy` anchors, then convert the two legacy routes to `redirect()`s (SHIP BLOCKER: renewal-reminder emails hardcode `/portal/preferences/renewals` — it must resolve, not 404), and re-point the avatar menu.

**Conventions for every task below**
- TDD micro-loop: write failing test → `pnpm vitest run <file>` (RED) → minimal impl → `pnpm vitest run <file>` (GREEN) → commit. E2E uses `pnpm test:e2e --workers=1 --grep <tag>`.
- All module reads via barrels only (`@/modules/members`, `@/modules/renewals`, `@/modules/insights`). RLS: `memberId` always comes from `findByLinkedUserId(tenant, user.id)`, NEVER a URL param.
- a11y: section titles are real `<h2>` (NOT `CardTitle`, which renders a `<div>` — see project memory "shadcn CardTitle is a div"); h1 (PageHeader) → h2 outline; ≥44px (`min-h-11`) targets.
- After the LAST edit before each commit, run `pnpm typecheck` (it is NOT in pre-push; run it via a temp tsconfig that excludes `.next` if the dev server is up — see project memory "typecheck masked by .next/dev/types").

---

### Task 1 — i18n keys for the sectioned hub (EN/TH/SV)

Add the four section headings + the "Forgot your password?" link label under the existing `portal.account` namespace. `portal.account.menu.{renewalPrefs,dataPrivacy}` already exist (reused by the avatar); we add `sections.*` + `forgotPassword`.

**Step 1 (RED):** add the keys to `en.json` so `check:i18n` parity holds once TH/SV match. In `src/i18n/messages/en.json`, replace the current `portal.account` block (lines ~3948–3955):

```json
    "account": {
      "title": "Account settings",
      "subtitle": "Manage your password and notification language.",
      "forgotPassword": "Forgot your password?",
      "sections": {
        "account": "Account",
        "renewalPrefs": "Renewal preferences",
        "dataPrivacy": "Data & privacy",
        "appearance": "Appearance"
      },
      "menu": {
        "renewalPrefs": "Renewal reminders",
        "dataPrivacy": "Data & privacy"
      }
    },
```

**Step 2:** add the SAME keys to `src/i18n/messages/th.json` `portal.account` block:

```json
      "forgotPassword": "ลืมรหัสผ่านใช่หรือไม่?",
      "sections": {
        "account": "บัญชีผู้ใช้",
        "renewalPrefs": "การตั้งค่าการต่ออายุ",
        "dataPrivacy": "ข้อมูลและความเป็นส่วนตัว",
        "appearance": "การแสดงผล"
      },
```

**Step 3:** add to `src/i18n/messages/sv.json` `portal.account` block:

```json
      "forgotPassword": "Glömt ditt lösenord?",
      "sections": {
        "account": "Konto",
        "renewalPrefs": "Förnyelseinställningar",
        "dataPrivacy": "Data och integritet",
        "appearance": "Utseende"
      },
```

**Step 4 (GREEN):** run `pnpm check:i18n` — 0 missing keys across EN/TH/SV.

**Commit:** `feat(portal): i18n keys for sectioned account hub (EN/TH/SV)`

---

### Task 2 — `PortalSignOutButton` (failing test first)

The mobile Account tab opens `/portal/account` directly (no avatar dropdown on mobile per spec §2), so the Appearance section needs its own Sign-out affordance. Reuse the exact POST pattern from `UserMenu` (lines 84–96).

**Step 1 (RED):** create `tests/unit/components/portal/portal-sign-out-button.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { PortalSignOutButton } from '@/components/portal/portal-sign-out-button';

const pushSpy = vi.fn();
const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy, refresh: refreshSpy }),
}));
const errorSpy = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => errorSpy(...a) } }));

function renderButton() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PortalSignOutButton />
    </NextIntlClientProvider>,
  );
}

describe('<PortalSignOutButton>', () => {
  beforeEach(() => {
    pushSpy.mockClear();
    refreshSpy.mockClear();
    errorSpy.mockClear();
  });

  it('POSTs to /api/auth/sign-out and routes to /portal/sign-in on success', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(pushSpy).toHaveBeenCalledWith('/portal/sign-in'));
    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/sign-out', { method: 'POST' });
    expect(refreshSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('toasts on a non-ok response and does NOT navigate', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 500 }));
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(pushSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
```

Run `pnpm vitest run tests/unit/components/portal/portal-sign-out-button.test.tsx` → RED (module missing).

**Step 2 (GREEN):** create `src/components/portal/portal-sign-out-button.tsx`:

```tsx
'use client';

/**
 * PortalSignOutButton — Sign-out affordance for the Account-hub Appearance
 * section. On mobile the Account tab opens /portal/account directly (no avatar
 * dropdown per spec §2), so the hub needs its own sign-out. Same POST +
 * router-push + toast pattern as <UserMenu>.
 */
import { LogOutIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function PortalSignOutButton() {
  const t = useTranslations('shell.userMenu');
  const router = useRouter();

  const handleSignOut = async () => {
    try {
      const response = await fetch('/api/auth/sign-out', { method: 'POST' });
      if (response.ok) {
        router.push('/portal/sign-in');
        router.refresh();
      } else {
        toast.error(t('signOutFailed'));
      }
    } catch {
      toast.error(t('signOutNetworkError'));
    }
  };

  return (
    <Button variant="outline" className="min-h-11" onClick={handleSignOut}>
      <LogOutIcon className="size-4" aria-hidden />
      {t('signOut')}
    </Button>
  );
}
```

Run the test → GREEN.

**Commit:** `feat(portal): add PortalSignOutButton for Account-hub Appearance section`

---

### Task 3 — Sectioned hub structure test (real `<h2>` + anchors)

Pin the IA before rewriting the page: real `<h2>` per section, correct `id` anchors with `scroll-mt`, all four sections present. Mock the server reads so the RSC renders synchronously in the test.

**Step 1 (RED):** create `tests/unit/app/portal/account-hub.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

// Server-only deps stubbed so the RSC body is pure JSX in the test.
vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({
    user: { id: 'u1', email: 'jane@example.com', role: 'member' },
  }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 't1' }),
}));
vi.mock('@/lib/env', () => ({ env: { features: { f9Dashboard: true } } }));
vi.mock('@/lib/db', () => ({ runInTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/members', () => ({
  getMemberPreferredLocale: vi.fn().mockResolvedValue({ ok: true, value: 'en' }),
  f3DrizzleMemberRepo: {},
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findByLinkedUserId: vi.fn().mockResolvedValue({ ok: true, value: { memberId: 'm1' } }) },
  }),
}));
vi.mock('@/modules/renewals', () => ({
  makeRenewalsDeps: () => ({
    memberRenewalFlagsRepo: { readRenewalRemindersOptedOut: vi.fn().mockResolvedValue(false) },
  }),
}));
vi.mock('@/modules/insights', () => ({ listMemberDataExports: vi.fn().mockResolvedValue([]) }));

import MemberAccountPage from '@/app/(member)/portal/account/page';

async function renderHub() {
  const ui = await MemberAccountPage();
  return render(<NextIntlClientProvider locale="en" messages={enMessages}>{ui}</NextIntlClientProvider>);
}

describe('Account hub — sectioned IA (G2)', () => {
  it('renders a real <h2> for each of the four sections', async () => {
    await renderHub();
    for (const name of [/^Account$/, /Renewal preferences/, /Data & privacy/, /Appearance/]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
  });

  it('anchors the renewal + data-privacy sections with scroll-mt offsets', async () => {
    const { container } = await renderHub();
    const renewal = container.querySelector('#renewal-prefs');
    const privacy = container.querySelector('#data-privacy');
    expect(renewal).not.toBeNull();
    expect(privacy).not.toBeNull();
    expect(renewal?.className).toMatch(/scroll-mt-/);
    expect(privacy?.className).toMatch(/scroll-mt-/);
  });

  it('shows the member email and a Forgot-your-password link to /forgot-password', async () => {
    await renderHub();
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /forgot your password/i }))
      .toHaveAttribute('href', '/forgot-password');
  });
});
```

Run `pnpm vitest run tests/unit/app/portal/account-hub.test.tsx` → RED (current page has no `<h2>` sections / anchors / email).

**Step 2:** implemented in Task 4 (this test stays RED until then — that is the TDD contract). Do NOT write the page yet.

**Commit (red):** `test(portal): RED — sectioned account-hub structure (h2 + anchors + email)`

---

### Task 4 — Rewrite `/portal/account/page.tsx` as the sectioned hub (GREEN)

Restructure into four anchored sections with real `<h2>`. KEEP the inline `ChangePasswordForm` (DECISION C) and add the Forgot-password link beneath it; KEEP the SSR locale seed; embed `RenewalRemindersToggle` (with its SSR `readRenewalRemindersOptedOut` seed) and `DataExportPanel` (with `listMemberDataExports`, f9 gate); add the Appearance section.

**Step 1 (GREEN):** replace the entire body of `src/app/(member)/portal/account/page.tsx`:

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { env } from '@/lib/env';
import { runInTenant } from '@/lib/db';
import { ChangePasswordForm } from '@/components/auth/change-password-form';
import { PreferredLocaleForm } from '@/components/portal/preferred-locale-form';
import { PortalSignOutButton } from '@/components/portal/portal-sign-out-button';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { DataExportPanel } from '@/components/data-export/data-export-panel';
import {
  buildDataExportLabels,
  buildDataExportRows,
} from '@/components/data-export/data-export-view-model';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { getMemberPreferredLocale, f3DrizzleMemberRepo } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { makeRenewalsDeps } from '@/modules/renewals';
import { listMemberDataExports } from '@/modules/insights';
import { RenewalRemindersToggle } from '../preferences/renewals/_components/renewal-reminders-toggle';

/**
 * Member Account hub at `/portal/account` (spec §4.5 + §97).
 *
 * ONE sectioned URL — real <h2> per section + #anchors so the desktop
 * avatar dropdown and (legacy) /portal/preferences/renewals +
 * /portal/account/data-export redirects deep-link to the right section.
 * Sections: Account (change-password [KEPT inline, DECISION C] + forgot-
 * password link + notification language) · Renewal preferences · Data &
 * privacy (f9-gated) · Appearance (theme + sign-out).
 *
 * memberId is always resolved from the session (findByLinkedUserId),
 * never a URL param (RLS — Principle I).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.account');
  return { title: t('title') };
}

export default async function MemberAccountPage() {
  const { user } = await requireSession('member');
  const tPage = await getTranslations('portal.account');
  const tChange = await getTranslations('auth.changePassword');
  const tLocale = await getTranslations('portal.preferredLocale');
  const tShell = await getTranslations('shell.roleBadge');
  const tExport = await getTranslations('dataExport');
  const locale = await getLocale();

  const tenant = resolveTenantFromRequest();
  const membersDeps = buildMembersDeps(tenant);

  // SSR-seed both the preferred-locale form and the renewal toggle from the
  // session member (no client GET waterfall). Best-effort: on lookup/repo
  // failure leave the seed undefined/false and let the client fall back.
  let initialLocale: 'en' | 'th' | 'sv' | null | undefined;
  let initialOptedOut = false;
  let memberId: string | null = null;
  try {
    const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(tenant, user.id);
    if (memberLookup.ok) {
      memberId = memberLookup.value.memberId;
      const localeResult = await getMemberPreferredLocale(
        { tenant, memberRepo: f3DrizzleMemberRepo },
        memberId,
      );
      if (localeResult.ok) initialLocale = localeResult.value;
      else
        logger.warn(
          { err: localeResult.error, tenantId: tenant.slug, userId: user.id },
          'portal.account.preferred_locale_lookup_failed',
        );

      const renewalsDeps = makeRenewalsDeps(tenant.slug);
      initialOptedOut =
        (await runInTenant(tenant, (tx) =>
          renewalsDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut(
            tx,
            tenant.slug,
            memberId!,
          ),
        )) ?? false;
    }
  } catch (err) {
    logger.warn(
      { err, tenantId: tenant.slug, userId: user.id },
      'portal.account.hub_seed_failed',
    );
  }

  const exportJobs =
    env.features.f9Dashboard && memberId
      ? await listMemberDataExports(tenant, memberId)
      : [];

  return (
    <FormContainer>
      <PageHeader
        title={tPage('title')}
        subtitle={tPage('subtitle')}
        badge={<Badge variant="outline">{tShell(user.role)}</Badge>}
      />

      {/* Account — email + change password (KEPT inline) + locale */}
      <section id="account" aria-labelledby="account-heading" className="scroll-mt-24 space-y-4">
        <h2 id="account-heading" className="text-lg font-semibold">
          {tPage('sections.account')}
        </h2>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <p className="text-sm text-muted-foreground">{user.email}</p>
            <ChangePasswordForm />
            <Link href="/forgot-password" className="text-sm text-primary underline-offset-4 hover:underline">
              {tPage('forgotPassword')}
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 pt-6">
            <p className="text-sm font-medium">{tLocale('title')}</p>
            <p className="text-sm text-muted-foreground">{tLocale('description')}</p>
            <PreferredLocaleForm initialValue={initialLocale} />
          </CardContent>
        </Card>
      </section>

      {/* Renewal preferences — #renewal-prefs deep-link target */}
      <section id="renewal-prefs" aria-labelledby="renewal-prefs-heading" className="scroll-mt-24 space-y-4">
        <h2 id="renewal-prefs-heading" className="text-lg font-semibold">
          {tPage('sections.renewalPrefs')}
        </h2>
        <Card>
          <CardContent className="pt-6">
            <RenewalRemindersToggle initialOptedOut={initialOptedOut} />
          </CardContent>
        </Card>
      </section>

      {/* Data & privacy — #data-privacy deep-link target (f9-gated) */}
      {env.features.f9Dashboard ? (
        <section id="data-privacy" aria-labelledby="data-privacy-heading" className="scroll-mt-24 space-y-4">
          <h2 id="data-privacy-heading" className="text-lg font-semibold">
            {tPage('sections.dataPrivacy')}
          </h2>
          <Card>
            <CardContent className="space-y-4 pt-6">
              <p className="max-w-prose text-sm text-muted-foreground">{tExport('description')}</p>
              <DataExportPanel
                rows={buildDataExportRows(exportJobs, tExport, locale)}
                labels={buildDataExportLabels(tExport)}
              />
            </CardContent>
          </Card>
        </section>
      ) : null}

      {/* Appearance — theme + sign-out */}
      <section id="appearance" aria-labelledby="appearance-heading" className="scroll-mt-24 space-y-4">
        <h2 id="appearance-heading" className="text-lg font-semibold">
          {tPage('sections.appearance')}
        </h2>
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
            <ThemeToggle />
            <PortalSignOutButton />
          </CardContent>
        </Card>
      </section>
    </FormContainer>
  );
}
```

**Step 2 (GREEN):** run `pnpm vitest run tests/unit/app/portal/account-hub.test.tsx` → all three cases GREEN. Then `pnpm typecheck` (note the `DataExportPanel` rows/labels view-model imports must match `data-export-view-model.ts` signatures already used by the legacy page).

**Commit:** `feat(portal): sectioned account hub with #renewal-prefs + #data-privacy anchors`

---

### Task 5 — Convert `/portal/preferences/renewals` to a redirect (SHIP BLOCKER route preservation)

Renewal-reminder emails hardcode `${baseUrl}/portal/preferences/renewals` (`dispatch-one-cycle.ts:782`, `retry-failed-reminders.ts:216`, `base-renewal-layout.tsx`). The route MUST keep resolving — convert it to a `redirect()` to the hub anchor so there is ONE source (§97). Do NOT touch the email use-case hardcodes (the redirect keeps them working).

**Step 1 (RED):** create `tests/unit/app/portal/renewals-redirect.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';

const redirectSpy = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`); // mirror next/navigation redirect throw
});
vi.mock('next/navigation', () => ({ redirect: redirectSpy }));

import RenewalPreferencesPage from '@/app/(member)/portal/preferences/renewals/page';

describe('/portal/preferences/renewals route preservation (G2)', () => {
  it('redirects to the Account-hub renewal anchor (never 404)', async () => {
    await expect(RenewalPreferencesPage()).rejects.toThrow(
      'NEXT_REDIRECT:/portal/account#renewal-prefs',
    );
    expect(redirectSpy).toHaveBeenCalledWith('/portal/account#renewal-prefs');
  });
});
```

Run `pnpm vitest run tests/unit/app/portal/renewals-redirect.test.tsx` → RED (page still renders the toggle).

**Step 2 (GREEN):** replace the entire body of `src/app/(member)/portal/preferences/renewals/page.tsx`:

```tsx
/**
 * `/portal/preferences/renewals` — PRESERVED route (spec §4.5 + §97).
 *
 * Renewal-reminder emails hardcode `${baseUrl}/portal/preferences/renewals`
 * (renewals/.../dispatch-one-cycle.ts + retry-failed-reminders.ts +
 * base-renewal-layout.tsx). The opt-out UI now lives in the consolidated
 * Account hub, so this route redirects to that section. A 404 here would
 * break the PDPA opt-out path (ship blocker). Do NOT change the email
 * hardcodes — this redirect keeps them working.
 */
import { redirect } from 'next/navigation';

export default function RenewalPreferencesPage(): never {
  redirect('/portal/account#renewal-prefs');
}
```

Run the test → GREEN.

**Step 3 — remove dead loading/error segments.** After the page body becomes a synchronous `redirect()` (no async work, no error boundary needed), the sibling `error.tsx` and `loading.tsx` in `src/app/(member)/portal/preferences/renewals/` are unreachable:
- `loading.tsx` — the route never suspends (redirect is synchronous).
- `error.tsx` — the route never throws an application error (redirect throws a Next.js control-flow signal that is NOT caught by error boundaries).

Verified: both files exist (confirmed via glob — `loading.tsx` + `error.tsx` present). Delete them:

```bash
git rm src/app/(member)/portal/preferences/renewals/error.tsx \
        src/app/(member)/portal/preferences/renewals/loading.tsx
```

If you judge it safer to keep them as no-ops (they are harmless), add a comment to each explaining they are dead post-redirect. Either way record the decision in the commit message.

**Note:** the now-unused `_components/renewal-reminders-toggle.tsx` is imported by the hub (Task 4) — keep it.

**Commit:** `refactor(portal): redirect /portal/preferences/renewals to account-hub anchor (route preserved)`

---

### Task 6 — Convert `/portal/account/data-export` to a redirect

Same route-preservation pattern: the page now lives in the hub's Data & privacy section. Redirect the legacy route to `#data-privacy`.

**Step 1 (RED):** create `tests/unit/app/portal/data-export-redirect.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';

const redirectSpy = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({ redirect: redirectSpy }));

import PortalDataExportPage from '@/app/(member)/portal/account/data-export/page';

describe('/portal/account/data-export route preservation (G2)', () => {
  it('redirects to the Account-hub data-privacy anchor (never 404)', async () => {
    await expect(PortalDataExportPage()).rejects.toThrow(
      'NEXT_REDIRECT:/portal/account#data-privacy',
    );
    expect(redirectSpy).toHaveBeenCalledWith('/portal/account#data-privacy');
  });
});
```

Run `pnpm vitest run tests/unit/app/portal/data-export-redirect.test.tsx` → RED.

**Step 2 (GREEN):** replace the entire body of `src/app/(member)/portal/account/data-export/page.tsx`:

```tsx
/**
 * `/portal/account/data-export` — PRESERVED route (spec §4.5 + §97).
 *
 * The member GDPR data-export panel now lives in the Account hub's
 * Data & privacy section. This legacy route redirects there so any
 * existing deep-link keeps resolving (no 404).
 */
import { redirect } from 'next/navigation';

export default function PortalDataExportPage(): never {
  redirect('/portal/account#data-privacy');
}
```

Run the test → GREEN.

**Step 3 — remove dead loading/error segments.** Same reasoning as Task 5: `src/app/(member)/portal/account/data-export/` has `loading.tsx` + `error.tsx` (verified via glob). After the page becomes a synchronous redirect they are unreachable:

```bash
git rm src/app/(member)/portal/account/data-export/error.tsx \
        src/app/(member)/portal/account/data-export/loading.tsx
```

**Commit:** `refactor(portal): redirect /portal/account/data-export to account-hub anchor (route preserved)`

---

### Task 7 — Re-point the avatar menu to the live hub anchors

Now that the hub sections exist, update the member avatar links from the legacy routes to the anchors, and refresh the stale doc comment (lines 14–21) that says the anchors are dead.

**Step 1 (RED):** update the two href assertions in `tests/unit/components/shell/user-menu.test.tsx` (lines 56 + 59):

```tsx
    expect(
      screen.getByRole('menuitem', { name: /renewal/i }),
    ).toHaveAttribute('href', '/portal/account#renewal-prefs');
    expect(
      screen.getByRole('menuitem', { name: /data & privacy/i }),
    ).toHaveAttribute('href', '/portal/account#data-privacy');
```

Run `pnpm vitest run tests/unit/components/shell/user-menu.test.tsx` → RED (component still points at legacy routes).

**Step 2 (GREEN):** in `src/components/shell/user-menu.tsx` update the two member links (lines 128 + 132):

```tsx
              <DropdownMenuItem render={<Link href="/portal/account#renewal-prefs" />}>
                <CalendarClockIcon className="size-4" aria-hidden />
                {tHub('renewalPrefs')}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/portal/account#data-privacy" />}>
                <ShieldIcon className="size-4" aria-hidden />
                {tHub('dataPrivacy')}
              </DropdownMenuItem>
```

**Step 3:** replace the stale doc paragraph (lines 14–21) so it reflects reality:

```tsx
 * Members get an Account menu linking to Account settings (/portal/account)
 * and its in-page sections (Renewal preferences → /portal/account#renewal-prefs,
 * Data & privacy → /portal/account#data-privacy), theme controls, and sign-out.
 * D2 consolidated these into the single Account hub; the legacy routes
 * (/portal/preferences/renewals, /portal/account/data-export) now redirect to
 * the matching anchors, so renewal-reminder email CTAs keep resolving.
 * Staff (admin/manager) keep the original single account item.
```

Run the user-menu test → GREEN. Then `pnpm typecheck`.

**Commit:** `feat(portal): point avatar menu at live account-hub anchors`

---

### Task 8 — Cross-tenant integration test (Principle I — member A ≠ member B)

Prove the hub's three member-scoped reads (renewal opt-out flag, preferred locale, data-export list) are tenant/member-isolated and derive `memberId` from the session, never a URL. Hits live Neon (`pnpm test:integration`).

**Repo-verified facts (check before implementing):**
- `ExportJobRecord` (from `src/modules/insights/application/ports/export-job-repo.ts`) has fields `id: string` and `subjectMemberId: string | null` — there are NO `jobId` or `memberId` fields on this type.
- `listMemberDataExports(tenant, subjectMemberId)` returns `Promise<readonly ExportJobRecord[]>` — the `ExportJobRecord` rows must be compared via `.id` and `.subjectMemberId`.
- `getMemberPreferredLocale(deps, memberId)` takes a **branded** `MemberId` (from `src/modules/members/domain/member.ts`). Wrap a raw UUID with `asMemberId(raw)` (re-exported from `@/modules/members`) or the call fails typecheck under `strict: true`.
- `seedTenantWithLinkedMember` / `tests/integration/helpers/portal-seed` **do NOT exist** in the repo. The proven seed pattern for cross-tenant tests is: `createTwoTestTenants()` + `createActiveTestUser` + `seedF8MembershipPlan` + inline `tx.insert(members)` with `nextSeedMemberNumber()` (see `tests/integration/portal/dashboard-cross-tenant.test.ts`). The contact row with `linked_user_id` must be seeded inline to satisfy `findByLinkedUserId` (which joins `contacts.linked_user_id → users.id`); the `contacts` table schema lives in `src/modules/members/infrastructure/db/schema-contacts.ts`.

**Step 1 (RED):** create `tests/integration/portal/account-hub-cross-tenant.test.ts`:

```ts
/**
 * G2 Principle I — Account-hub reads are session-scoped, never cross-tenant.
 *
 * Seeds two members in two tenants (using the same proven pattern as
 * dashboard-cross-tenant.test.ts: createTwoTestTenants + createActiveTestUser
 * + seedF8MembershipPlan + inline tx.insert). Each tenant has DISTINCT
 * renewal-opt-out flags + preferred locales. Asserts each tenant's reads only
 * ever see their own row. All seed data is SIMULATED — never real PII.
 *
 * Live Neon Singapore. Run with: pnpm test:integration -- account-hub-cross-tenant
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { asMemberId, getMemberPreferredLocale, f3DrizzleMemberRepo } from '@/modules/members';
import { makeRenewalsDeps } from '@/modules/renewals';
import { listMemberDataExports } from '@/modules/insights';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('G2 Account-hub cross-tenant isolation (Principle I)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let seedUser: TestUser;

  // Two members — one per tenant. Raw UUIDs; branded with asMemberId() at call sites.
  const aMemberUuid = randomUUID();
  const bMemberUuid = randomUUID();
  // Two DISTINCT user IDs simulating two different logged-in sessions.
  let aUserId: string;
  let bUserId: string;
  const aPlanId = `g2-iso-a-${randomUUID().slice(0, 8)}`;
  const bPlanId = `g2-iso-b-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    seedUser = await createActiveTestUser('admin');
    // Seed two separate tenant sessions for the two "user A" / "user B" accounts.
    // createActiveTestUser creates a user row in the global users table — use a
    // dedicated call per member so linked_user_id is distinct.
    const userA = await createActiveTestUser('member');
    const userB = await createActiveTestUser('member');
    aUserId = userA.userId;
    bUserId = userB.userId;

    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed tenant A plan + member + linked contact + renewal opt-out flag + preferred locale.
    await runInTenant(tenantA.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId: aPlanId,
        planName: { en: 'G2 Plan A' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: seedUser.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: aMemberUuid,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Sim Co A ${aMemberUuid.slice(0, 4)}`,
        country: 'TH',
        planId: aPlanId,
        planYear: 2026,
        status: 'active',
        // preferred_locale: 'sv' — tenant A member prefers Swedish
        preferredLocale: 'sv',
        // renewal_reminders_opted_out: true — tenant A member opted out
        renewalRemindersOptedOut: true,
      });
      // Seed the contact row linking the user session to this member.
      // findByLinkedUserId joins members via contacts.linked_user_id = users.id.
      await tx.insert(contacts).values({
        tenantId: tenantA.ctx.slug,
        contactId: randomUUID(),
        memberId: aMemberUuid,
        linkedUserId: aUserId,
        firstName: 'Sim',
        lastName: 'Alpha',
        email: `sim-alpha-${aMemberUuid.slice(0, 4)}@example.com`,
        isPrimary: true,
      });
    });

    // Seed tenant B plan + member + linked contact (opted-in, Thai locale).
    await runInTenant(tenantB.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenantB.ctx.slug,
        planId: bPlanId,
        planName: { en: 'G2 Plan B' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: seedUser.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantB.ctx.slug,
        memberId: bMemberUuid,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Sim Co B ${bMemberUuid.slice(0, 4)}`,
        country: 'TH',
        planId: bPlanId,
        planYear: 2026,
        status: 'active',
        // preferred_locale: 'th' — tenant B member prefers Thai
        preferredLocale: 'th',
        // renewal_reminders_opted_out: false — tenant B member opted in
        renewalRemindersOptedOut: false,
      });
      await tx.insert(contacts).values({
        tenantId: tenantB.ctx.slug,
        contactId: randomUUID(),
        memberId: bMemberUuid,
        linkedUserId: bUserId,
        firstName: 'Sim',
        lastName: 'Beta',
        email: `sim-beta-${bMemberUuid.slice(0, 4)}@example.com`,
        isPrimary: true,
      });
    });
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('renewal opt-out flag: tenant A = true, tenant B = false (no cross-leak)', async () => {
    const aDeps = makeRenewalsDeps(tenantA.ctx.slug);
    const aFlag = await runInTenant(tenantA.ctx, (tx) =>
      aDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut(
        tx, tenantA.ctx.slug, aMemberUuid,
      ),
    );
    const bDeps = makeRenewalsDeps(tenantB.ctx.slug);
    const bFlag = await runInTenant(tenantB.ctx, (tx) =>
      bDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut(
        tx, tenantB.ctx.slug, bMemberUuid,
      ),
    );
    expect(aFlag).toBe(true);
    expect(bFlag).toBe(false);
  });

  it('preferred locale: tenant A = sv, tenant B = th (getMemberPreferredLocale takes branded MemberId)', async () => {
    // getMemberPreferredLocale(deps, memberId: MemberId) — wrap raw UUID with asMemberId().
    const a = await getMemberPreferredLocale(
      { tenant: tenantA.ctx, memberRepo: f3DrizzleMemberRepo },
      asMemberId(aMemberUuid),
    );
    const b = await getMemberPreferredLocale(
      { tenant: tenantB.ctx, memberRepo: f3DrizzleMemberRepo },
      asMemberId(bMemberUuid),
    );
    expect(a.ok && a.value).toBe('sv');
    expect(b.ok && b.value).toBe('th');
  });

  it('findByLinkedUserId: tenant B user looked up under tenant A returns not-found (RLS)', async () => {
    // bUserId belongs to tenant B; querying it in tenant A context must not resolve.
    const lookup = await buildMembersDeps(tenantA.ctx).memberRepo.findByLinkedUserId(
      tenantA.ctx,
      bUserId,
    );
    expect(lookup.ok).toBe(false);
  });

  it('data-export list: ExportJobRecord rows keyed by .subjectMemberId, id by .id (never .memberId/.jobId)', async () => {
    // listMemberDataExports returns ExportJobRecord[]. The correct fields are
    // .id (not .jobId) and .subjectMemberId (not .memberId) — verified against
    // src/modules/insights/application/ports/export-job-repo.ts.
    const aJobs = await listMemberDataExports(tenantA.ctx, aMemberUuid);
    const bJobs = await listMemberDataExports(tenantB.ctx, bMemberUuid);
    // Each row's subjectMemberId must match the member we seeded (or be null for
    // non-GDPR-member kinds — but gdpr_member_archive always sets it).
    expect(aJobs.every((j) => j.subjectMemberId === aMemberUuid || j.subjectMemberId === null)).toBe(true);
    expect(bJobs.every((j) => j.subjectMemberId === bMemberUuid || j.subjectMemberId === null)).toBe(true);
    // No alpha job id (.id, not .jobId) ever appears in beta's list.
    const alphaIds = new Set(aJobs.map((j) => j.id));
    expect(bJobs.some((j) => alphaIds.has(j.id))).toBe(false);
  });
});
```

> **Column name caveat:** `members` Drizzle schema column names (`preferredLocale`, `renewalRemindersOptedOut`) must match `schema-members.ts`. If the columns are snake_case in Drizzle (no `fieldName` alias), use the raw column names. Verify against `src/modules/members/infrastructure/db/schema-members.ts` before inserting — do NOT guess column aliases. Similarly for `contacts.linkedUserId` vs `linked_user_id` in `schema-contacts.ts`.

Run `pnpm test:integration -- account-hub-cross-tenant` → RED (contact rows not yet seeded in any existing helper; inline seed above makes it self-contained).

**Step 2 (GREEN):** run the suite after the hub page is in place → GREEN. This is the Principle I Review-Gate blocker for G2.

**Commit:** `test(portal): cross-tenant isolation for account-hub reads (Principle I)`

---

### Task 9 — Route-safety + deep-link E2E (`@route-safety`)

End-to-end proof that BOTH legacy routes resolve (redirect, not 404) and the avatar deep-links land on the right section. This is the §10 "Route safety" success criterion. Run on preview per project memory (local dev sign-in flakes are expected noise — see "@a11y/@i18n + RUN_PERF gates are preview-only").

**Step 1 (RED):** create `tests/e2e/portal/account-hub-route-safety.spec.ts`:

```ts
/**
 * signInAsMember is exported from tests/e2e/helpers/member-session.ts
 * (verified against the file — there is NO ../helpers/auth helper;
 * G1 Task 7 correctly imports from '../helpers/member-session').
 */
import { test, expect } from '@playwright/test';
import { signInAsMember } from '../helpers/member-session';

test.describe('@route-safety Account-hub legacy routes resolve to anchors', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsMember(page);
  });

  test('legacy /portal/preferences/renewals redirects to #renewal-prefs (not 404)', async ({ page }) => {
    const res = await page.goto('/portal/preferences/renewals');
    expect(res?.status()).toBeLessThan(400); // never a 404 — emails hardcode this URL
    await expect(page).toHaveURL(/\/portal\/account#renewal-prefs$/);
    await expect(page.getByRole('heading', { level: 2, name: /renewal preferences/i })).toBeVisible();
  });

  test('legacy /portal/account/data-export redirects to #data-privacy (not 404)', async ({ page }) => {
    const res = await page.goto('/portal/account/data-export');
    expect(res?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/portal\/account#data-privacy$/);
    await expect(page.getByRole('heading', { level: 2, name: /data & privacy/i })).toBeVisible();
  });

  test('avatar Renewal/Data-privacy items deep-link into the hub sections', async ({ page }) => {
    await page.goto('/portal');
    await page.getByRole('button', { name: /account menu/i }).click();
    await page.getByRole('menuitem', { name: /renewal/i }).click();
    await expect(page).toHaveURL(/\/portal\/account#renewal-prefs$/);
  });
});
```

Run `pnpm test:e2e --workers=1 --grep @route-safety` → RED until Tasks 4–7 are in.

**Step 2 (GREEN):** with Tasks 4–7 landed, re-run → GREEN (authoritative run is on the preview deploy).

**Step 3 — full-suite gate:** run `pnpm vitest run tests/unit/app/portal tests/unit/components/portal tests/unit/components/shell/user-menu.test.tsx` (all G2 unit GREEN), `pnpm check:i18n` (0 missing), and `pnpm typecheck` as the final gate before the last commit.

**Commit:** `test(portal): @route-safety e2e for account-hub legacy redirects + avatar deep-links`
