/**
 * COMP-1 US3-D (Task 4, rewired Task 6) — DPO erasure-evidence log
 * (`/admin/compliance/erasure-log`).
 *
 * Read-only admin page that gives the Data Protection Officer a single,
 * accountable, TRIAGE-FIRST view of every member erasure + its full Art.17
 * evidence: the Art.12 attestation, the completion cascade, the F1
 * `user_erased` credential proof, the US3-B tax-document redactions, and the
 * US3-C sub-processor outcome — grouped one card per erased member,
 * urgency-first (overdue > in-progress > complete), with a status-filter nav,
 * an SCCM member-number search, and a breach / all-clear banner.
 *
 * RBAC (CWE-285 carry-forward from Task 2): gated by
 * `requirePagePermission('members.erasure_log_read')`. A bare
 * staff gate would LEAK erasure evidence (PII + identity-verification
 * attestations) to managers, so the shim row is `legacyAdminOnly`, not
 * `legacySessionOnly`.
 *
 * Per-leg outcome: flag OFF admits admin (and, via D16, a promoted
 * super_admin) and 404s everyone else — byte-identical to the pre-016
 * `requireSession('staff')` + `role !== 'admin'` pair this replaced. Flag ON
 * narrows further: `members.erasure_log_read` is `superAdminOnly`, so plain
 * admin is denied too — a DECLARED narrowing (`INTENTIONAL_NARROWINGS`), not a
 * regression. Do not "restore" a role literal here; the gate is the contract
 * and `scripts/check-staff-page-guard.ts` pins it against the frozen baseline.
 *
 * UNGATED: US3-D is COMP-1, NOT F9 — the reused audit-viewer shell gates on
 * `FEATURE_F9_DASHBOARD`, but this page deliberately does NOT (consistent with
 * the already-live US3-A admin erase UI). No `env.features.f9Dashboard` check.
 *
 * Read-only: NO action buttons. The page never mutates an erasure — remediation
 * runs through the US2d reconciler cron / the US3-A admin erase flow.
 *
 * Task 6 replaces the original cursor/keyset pager with the `getErasureEvidenceLog`
 * triage engine (Task 3): a bounded `displayCap` read, a status-bucket summary,
 * urgency-first sort, an optional `?status=` filter, and an optional `?q=`
 * SCCM member-number search — see `src/modules/insights/application/erasure-evidence.ts`.
 */
import type { Metadata } from 'next';
import { getTranslations, getLocale } from 'next-intl/server';
import { env } from '@/lib/env';
import { Alert, Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shell/empty-state';
import { ShieldCheckIcon } from 'lucide-react';
import { requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import {
  getErasureEvidenceLog,
  makeGetErasureEvidenceLogDeps,
  DEFAULT_DISPLAY_CAP,
  type ErasureStatusFilter,
} from '@/modules/insights';
import {
  resolveMemberNumberPrefix,
  drizzleMemberSettingsRepo,
  parseMemberNumberQuery,
  formatMemberNumber,
  asMemberNumber,
} from '@/modules/members';
import { EvidenceCard } from './_components/evidence-card';
import { ErasureFilterTabs } from './_components/erasure-filter-tabs';
import { ErasureSearchForm } from './_components/erasure-search-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.compliance.erasureLog');
  return { title: t('title') };
}

type SearchParams = Record<string, string | string[] | undefined>;

/** First value of a possibly-repeated query param, trimmed. */
function str(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return (raw ?? '').trim();
}

const VALID_STATUS = new Set<ErasureStatusFilter>(['all', 'overdue', 'in_progress', 'complete']);

/** Unknown/absent `?status=` values fall back to `'all'` (never a 400 — this is a triage view, not an API). */
function parseStatus(v: string): ErasureStatusFilter {
  return VALID_STATUS.has(v as ErasureStatusFilter) ? (v as ErasureStatusFilter) : 'all';
}

type Translator = (key: string, values?: Record<string, string | number>) => string;

/** `filteredEmpty`/`filteredSearchEmpty` i18n key segment for a non-'all' status bucket. */
function statusMessageKey(status: Exclude<ErasureStatusFilter, 'all'>): 'overdue' | 'inProgress' | 'complete' {
  return status === 'in_progress' ? 'inProgress' : status;
}

/**
 * Canonical SCCM echo for the empty-state `ref` — a numeric/`SCCM-NNNN` query
 * echoes back formatted the same way `EvidenceCard` renders it (e.g. `17` →
 * `SCCM-0017`), instead of the raw query text. Non-numeric queries (company
 * name searches, once supported) echo back verbatim.
 */
function formatSearchRef(q: string, memberPrefix: string): string {
  const n = parseMemberNumberQuery(q);
  return n !== null ? formatMemberNumber(memberPrefix, asMemberNumber(n)) : q;
}

/**
 * Empty-state title copy — four mutually exclusive cases (search × filter),
 * distinguishing a genuinely-empty org from a filtered/searched dead end so
 * the DPO is never told "no erasures" when the org simply has none matching
 * the CURRENT view.
 */
function emptyStateTitle(
  status: ErasureStatusFilter,
  q: string,
  memberPrefix: string,
  t: Translator,
): string {
  const ref = formatSearchRef(q, memberPrefix);
  if (q !== '' && status !== 'all') return t(`filteredSearchEmpty.${statusMessageKey(status)}`, { ref });
  if (q !== '' && status === 'all') return t('search.empty', { ref });
  if (q === '' && status !== 'all') return t(`filteredEmpty.${statusMessageKey(status)}`);
  return t('empty.title');
}

export default async function ErasureLogPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<React.JSX.Element> {
  // RBAC: staff session, then admin-only. Manager + member → notFound (no leak).
  await requirePagePermission('members.erasure_log_read');

  const params = await searchParams;
  const locale = await getLocale();
  const tenant = resolveTenantFromRequest();
  const status = parseStatus(str(params.status));
  const q = str(params.q);

  // Read the clock ONCE so the use-case's isOverdue (server-side) and the
  // per-card `elapsed()` render agree on the same instant.
  const now = new Date();
  const [result, memberPrefix] = await Promise.all([
    getErasureEvidenceLog(makeGetErasureEvidenceLogDeps(), {
      ctx: tenant,
      now,
      filter: status,
      ...(q ? { search: q } : {}),
      displayCap: DEFAULT_DISPLAY_CAP,
    }),
    resolveMemberNumberPrefix(tenant, drizzleMemberSettingsRepo),
  ]);

  // Render every instant in the tenant timezone (the Vercel runtime is UTC;
  // without timeZone the "local" line would duplicate the UTC value).
  const dateFmt = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: env.tenant.timezone, // canonical tenant TZ (matches the F9 audit page); closes the latent multi-tenant gap
  });

  return renderErasureLogView({ status, q, result, memberPrefix, fmt: dateFmt, now });
}

/**
 * The loaded erasure log (header, status tabs + search, the banners, the
 * evidence cards or the empty state), shared with the AURA preview harness
 * (spec 122 US10b, T1018) so it renders this markup with fixture rows.
 */
export async function renderErasureLogView({
  status,
  q,
  result,
  memberPrefix,
  fmt,
  now,
}: {
  readonly status: ErasureStatusFilter;
  readonly q: string;
  readonly result: Awaited<ReturnType<typeof getErasureEvidenceLog>>;
  readonly memberPrefix: string;
  readonly fmt: Intl.DateTimeFormat;
  readonly now: Date;
}): Promise<React.JSX.Element> {
  const t = await getTranslations('admin.compliance.erasureLog');
  const dateFmt = fmt;
  const unfiltered = status === 'all' && q === '';
  const topBannerPresent = unfiltered && result.summary.overdue > 0;
  // `!result.capped`: a capped read only shows the newest `displayCap` rows, so
  // an org with older, unseen erasures past the cap could have `inProgress === 0`
  // on the visible slice while older rows are still outstanding — asserting
  // "no outstanding breaches" here would be a false compliance claim.
  const showAllClear =
    unfiltered && result.summary.total > 0 && result.summary.inProgress === 0 && !result.capped;

  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {/* Spec 122 US10b (T1017; boards `Admin-erasure-log`, `Admin-state-erasure-breach`):
          the status tabs and the member-number search share a row on a wide
          screen, the breach banner and the all-clear notice are AURA alerts. */}
      <div className="flex flex-col gap-[var(--aura-space-3)] sm:flex-row sm:items-end sm:justify-between">
        <ErasureFilterTabs active={status} summary={result.summary} q={q} />
        <ErasureSearchForm status={status} q={q} />
      </div>

      {topBannerPresent ? (
        <Alert tone="danger" role="alert">
          {t('breachAlert', { count: result.summary.overdue })}
        </Alert>
      ) : showAllClear ? (
        <Alert tone="success" role="none">
          {t('allClear')}
        </Alert>
      ) : null}

      {result.capped ? (
        <p className="text-sm text-[var(--aura-fg-secondary)]">{t('capNote', { cap: DEFAULT_DISPLAY_CAP })}</p>
      ) : null}

      {result.rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={ShieldCheckIcon}
            title={emptyStateTitle(status, q, memberPrefix, t)}
            bordered={false}
            data-testid="erasure-log-empty"
            {...(unfiltered ? { description: t('empty.body') } : {})}
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-[var(--page-section-gap)]">
          {result.rows.map((row) => (
            <li key={row.memberId}>
              <EvidenceCard
                row={row}
                memberPrefix={memberPrefix}
                fmt={dateFmt}
                now={now}
                topBannerPresent={topBannerPresent}
              />
            </li>
          ))}
        </ul>
      )}
    </TableContainer>
  );
}
