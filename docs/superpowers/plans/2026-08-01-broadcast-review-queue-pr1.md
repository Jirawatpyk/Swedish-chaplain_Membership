# E-Blast review queue — PR1 (triage + presentation/a11y/i18n/tokens) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the admin E-Blast review queue (`/admin/broadcasts`) a current-state triage signal (overdue-now banner), fix a real i18n leak (Audience raw enum) + ICU pluralisation, close bulk-bar a11y gaps, and remove success/warning token drift — pure presentation + one read-only tenant-scoped `COUNT`. First of three sequenced PRs (PR2 = shared `<Table>` + mobile cards; PR3 = send-path confirm) — do NOT do PR2/PR3 work here.

**Architecture:** `/admin/broadcasts/page.tsx` is an async RSC that composes banners + `QueueFilters` + `QueueTable` (server wrapper `queue-table.tsx` → `'use client'` `queue-table-client.tsx`, TanStack Table v8). PR1 adds an inline read-only overdue `COUNT` (mirroring the existing `totalPending`), a small server-rendered `OverdueBanner`, de-jargons + tokenises `SlaBanner`, wires the Audience column through the existing segment labels, moves bulk count/partial strings to client `useTranslations` (ICU plural), and adds a11y (`aria-live`, `indeterminate`, 24 px targets).

**Tech Stack:** Next.js 16 App Router (RSC + `'use client'`), React 19, TypeScript strict, next-intl (EN canonical + TH + SV, ICU), Tailwind v4 (semantic `--success`/`--warning` tokens), TanStack Table v8, Vitest + @testing-library/react + NextIntlClientProvider, Playwright + axe-core.

## Global Constraints

- **RSC + one client component.** `page.tsx`, `queue-table.tsx`, `sla-banner.tsx`, `loading.tsx`, `OverdueBanner` are Server Components; `queue-table-client.tsx`, `approve-dialog.tsx`, `review-actions.tsx` are `'use client'`. Do NOT add `'use client'` to a server file; `useTranslations` from next-intl is usable in BOTH.
- **No PR2/PR3 work.** Do NOT adopt the shared `<Table>` primitive, add mobile cards, move the bulk bar to fixed-bottom, or touch the send/approve decision. Those are later PRs.
- **Read-only + presentation only.** The one new query is a `COUNT(*)` via `runInTenant` (RLS), identical shape to `totalPending` (`page.tsx:254-260`). No money/approve/reject/cancel endpoint or RBAC change.
- **Semantic tokens (verified present + AA-tuned in `globals.css`):** `text-success` / `bg-success-surface` / `border-success` and `text-warning` / `bg-warning-surface` / `border-warning`. Use these — NOT raw `emerald-*`/`amber-*`. `red`/destructive already uses `bg-destructive-surface text-destructive`.
- **Overdue threshold = 48 h** (matches `SLA_RED_HOURS`, `queue-table.tsx:85`).
- **Truncation guard uses `listResult.nextCursor !== null`** — NOT the filter-unaware `totalPending`. Overdue banner + truncation note render only on the **default `submitted` view** (mirror erasure-log's unfiltered gating).
- **i18n:** EN canonical (`en.json`); every key present in TH + SV (`check:i18n` blocks on missing). TH must NOT use `italic`. Delete dead keys on the FULL path (`admin.broadcasts.queue.filters.apply`, not bare `"apply"` — leaf names collide across namespaces). `filters.statusAll` (the "All statuses" i18n key) is dead; the JS `statusAll` property in `queue-filters.tsx:125` (the `status_all=1` URL sentinel) is LIVE — do NOT touch it.
- **Package manager `pnpm`** (never npm). **Never run `pnpm format`/prettier** — hand-format. **Never `git add -A`** (untracked PII/junk in tree; stray `i18n_dump*.txt` at root — never stage). Stage explicit paths only.
- **`pnpm typecheck` is in no gate** — run it after the last edit of each task, plus `pnpm lint`.
- **Commit trailer** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
  Conventional Commits (commit-msg hook); `i18n(` type is rejected — use `feat`/`fix`/`refactor`.

---

## File Structure

- Modify `src/i18n/messages/{en,th,sv}.json` — new keys (`overdueBanner`, `truncationNote`, `approveDialog.recipientCount`), de-jargon `queue.slaBanner.*`, ICU `queue.bulk.selected`, delete dead keys. (Task 1)
- Modify `src/components/broadcast/admin/sla-banner.tsx` — raw→semantic tokens + de-jargon + a `compact` inline variant. (Task 2)
- Create `src/components/broadcast/admin/overdue-banner.tsx` — server component `OverdueBanner({ count })`. (Task 3)
- Modify `src/app/(staff)/admin/broadcasts/page.tsx` — overdue `COUNT`, `OverdueBanner`, `SlaBanner compact` when overdue, truncation note via `nextCursor`, gated to default view. (Task 3)
- Modify `src/app/(staff)/admin/broadcasts/loading.tsx` — chip skeleton count from `BROADCAST_STATUSES.length`. (Task 3)
- Modify `src/components/broadcast/admin/queue-table.tsx` — Audience label via `tSegment`; drop the `bulk*` count/partial `columnLabels`. (Task 4 + Task 5)
- Modify `src/components/broadcast/admin/queue-table-client.tsx` — `aria-live`, `indeterminate`, 24 px targets, client `useTranslations` for bulk strings (ICU), thread `recipientCount` to `ReviewActions`. (Task 5 + Task 6)
- Modify `src/components/broadcast/admin/review-actions.tsx` — accept + pass `recipientCount`. (Task 6)
- Modify `src/components/broadcast/admin/approve-dialog.tsx` — accept + display `recipientCount`. (Task 6)
- Modify `tests/e2e/*broadcast*` — a11y + i18n + overdue banner. (Task 7)
- New component tests under `tests/unit/...` per task.

---

## Task 1: i18n — new keys, de-jargon, ICU plural, delete dead keys

**Files:**
- Modify: `src/i18n/messages/en.json`, `th.json`, `sv.json` (all under `admin.broadcasts.queue` + `admin.broadcasts.approveDialog`)

**Interfaces:**
- Produces the message keys consumed by Tasks 2-6. Exact EN below (TH/SV parity required).

- [ ] **Step 1: Add / change EN keys, delete dead ones**

Under `admin.broadcasts.queue`:
- **Delete** `filters.apply`, `filters.statusAll`, `pagination` (the whole `{previous,next}` object). (Verify first: `grep -rn "queue.filters.apply\|queue.filters.statusAll\|queue.pagination" src/` returns nothing before deleting.)
- **De-jargon `slaBanner`** (replace values):
  ```json
  "slaBanner": {
    "targetSla": "Review target: within 48 hours",
    "medianRolling30d": "Half decided within {hours}h",
    "p95Rolling30d": "95% within {hours}h",
    "withinBudget": "Reviews on track",
    "breachWarning": "Reviews are running slow"
  }
  ```
- **ICU `bulk.selected`** (was `"{count} selected"`):
  ```json
  "selected": "{count, plural, one {# selected} other {# selected}}"
  ```
  (leave `bulk.partial` = `"{ok} approved, {fail} failed."` — interpolated via `t()` in Task 5, not `.replace()`.)
- **Add** `overdueBanner` + `truncationNote`:
  ```json
  "overdueBanner": "{count, plural, one {# broadcast has} other {# broadcasts have}} been waiting over 48 hours — review now.",
  "truncationNote": "Showing the first 50 — refine the filters to see more."
  ```

Under `admin.broadcasts.approveDialog`, **add**:
```json
"recipientCount": "Reaches ~{count, plural, one {# recipient} other {# recipients}}."
```

- [ ] **Step 2: Run check:i18n — expect FAIL (TH/SV missing the new keys)**

Run: `pnpm check:i18n`
Expected: FAIL naming the missing TH/SV keys (`overdueBanner`, `truncationNote`, `approveDialog.recipientCount`) + the de-jargon/ICU value edits are value-only (no failure), and the deletions must be mirrored (a key present in EN-absent-but-TH-present is fine; check:i18n blocks on EN-present-TH-absent).

- [ ] **Step 3: Mirror into TH + SV (delete the same dead keys; add the same new keys)**

`th.json` (TH — no `italic`, single plural form):
```json
"slaBanner": { "targetSla": "เป้าหมายการตรวจ: ภายใน 48 ชั่วโมง", "medianRolling30d": "ครึ่งหนึ่งตัดสินภายใน {hours} ชม.", "p95Rolling30d": "95% ภายใน {hours} ชม.", "withinBudget": "ตรวจทันเวลา", "breachWarning": "การตรวจล่าช้า" },
"bulk": { … "selected": "{count, plural, other {เลือก # รายการ}}" … },
"overdueBanner": "มี {count} รายการรออนุมัติเกิน 48 ชั่วโมง — รีบตรวจสอบ",
"truncationNote": "แสดง 50 รายการแรก — กรองเพิ่มเพื่อดูรายการอื่น"
```
`approveDialog.recipientCount` (th): `"ส่งถึงผู้รับ ~{count} คน"`.

`sv.json`:
```json
"slaBanner": { "targetSla": "Granskningsmål: inom 48 timmar", "medianRolling30d": "Hälften beslutade inom {hours}h", "p95Rolling30d": "95% inom {hours}h", "withinBudget": "Granskningar i fas", "breachWarning": "Granskningar går långsamt" },
"bulk": { … "selected": "{count, plural, one {# markerad} other {# markerade}}" … },
"overdueBanner": "{count, plural, one {# utskick har} other {# utskick har}} väntat i över 48 timmar — granska nu.",
"truncationNote": "Visar de första 50 — förfina filtren för att se fler."
```
`approveDialog.recipientCount` (sv): `"Når ~{count, plural, one {# mottagare} other {# mottagare}}."`.

- [ ] **Step 4: Run check:i18n — expect PASS**

Run: `pnpm check:i18n`
Expected: PASS (3-locale parity). Also `node -e "JSON.parse(require('fs').readFileSync('src/i18n/messages/th.json'))"` for each file to confirm valid JSON.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "feat(broadcasts): review-queue i18n — overdue/truncation/recipient keys, de-jargon SLA, ICU plural, drop dead keys"
```

---

## Task 2: `SlaBanner` — semantic tokens + compact variant

**Files:**
- Modify: `src/components/broadcast/admin/sla-banner.tsx`
- Test: `tests/unit/broadcast/sla-banner.test.tsx`

**Interfaces:**
- Produces: `SlaBanner({ stats, compact? })` — new optional `compact?: boolean` (default `false`). When `true`, renders a single-line muted inline stat (NO full-width coloured banner) for the "overdue banner is already showing" case (Task 3 passes it).

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/broadcast/sla-banner.test.tsx
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { SlaBanner, type SlaStats } from '@/components/broadcast/admin/sla-banner';

const green: SlaStats = { targetSlaHours: 48, medianTimeToDecisionHours: 5, p95TimeToDecisionHours: 20, decisionCount: 9, bannerSeverity: 'green' };
const red: SlaStats = { ...green, p95TimeToDecisionHours: 60, bannerSeverity: 'red' };
function renderBanner(stats: SlaStats, compact = false) {
  // SlaBanner is an async Server Component; await its element.
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {/* @ts-expect-error async server component in a test render */}
      <SlaBanner stats={stats} compact={compact} />
    </NextIntlClientProvider>,
  );
}
afterEach(cleanup);

describe('SlaBanner', () => {
  it('green severity uses the semantic success token, not raw emerald', () => {
    const { container } = renderBanner(green);
    const el = container.querySelector('[class*="success"]');
    expect(el).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/emerald-/);
  });

  it('red severity keeps the destructive token + role=alert', () => {
    const { container } = renderBanner(red);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.innerHTML).toContain('destructive');
  });

  it('compact renders an inline stat, not a full coloured banner (no role, no severity bg)', () => {
    const { container } = renderBanner(green, true);
    expect(container.querySelector('[role="region"]')).toBeNull();
    expect(container.innerHTML).not.toMatch(/bg-success-surface|bg-warning-surface|bg-destructive-surface/);
  });
});
```
(If rendering an async server component under `render()` is awkward in this repo's harness, split `SlaBanner` into a thin async wrapper that resolves `t` and a sync `SlaBannerView({ stats, compact, labels })` and test the sync view — match whichever pattern the repo already uses for async-server-component tests.)

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run tests/unit/broadcast/sla-banner.test.tsx`
Expected: FAIL (`emerald-` still present; no `compact`).

- [ ] **Step 3: Implement**

In `sla-banner.tsx`: swap `SEVERITY_STYLES` + the pill classes to tokens, add the `compact` branch:
```tsx
const SEVERITY_STYLES: Record<SlaStats['bannerSeverity'], string> = {
  green: 'border-success/40 bg-success-surface text-success',
  amber: 'border-warning/40 bg-warning-surface text-warning',
  red: 'border-destructive/40 bg-destructive-surface text-destructive',
};
const PILL_STYLES: Record<SlaStats['bannerSeverity'], string> = {
  green: 'bg-success/15', amber: 'bg-warning/15', red: 'bg-destructive/15',
};
```
Add `compact?: boolean` to `SlaBannerProps`. When `compact`, return a single muted line (no `role`, no `SEVERITY_STYLES` background):
```tsx
if (compact) {
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      {t('medianRolling30d', { hours: fmt(stats.medianTimeToDecisionHours) })} · {t('p95Rolling30d', { hours: fmt(stats.p95TimeToDecisionHours) })}
    </p>
  );
}
```
Replace the pill's raw `emerald/amber/red` conditional classes with `PILL_STYLES[stats.bannerSeverity]`. Keep the existing `role={severity==='red'?'alert':'region'}` + copy keys (now de-jargoned via Task 1).

- [ ] **Step 4: Run test + typecheck + lint**

Run: `pnpm vitest run tests/unit/broadcast/sla-banner.test.tsx` → PASS.
Run: `pnpm typecheck` → PASS. `pnpm lint` on the file → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/broadcast/admin/sla-banner.tsx tests/unit/broadcast/sla-banner.test.tsx
git commit -m "feat(broadcasts): SLA banner semantic tokens + compact inline variant"
```

---

## Task 3: Overdue-now banner + page wiring + loading skeleton

**Files:**
- Create: `src/components/broadcast/admin/overdue-banner.tsx`
- Modify: `src/app/(staff)/admin/broadcasts/page.tsx`
- Modify: `src/app/(staff)/admin/broadcasts/loading.tsx`
- Test: `tests/unit/broadcast/overdue-banner.test.tsx`

**Interfaces:**
- Consumes: `SlaBanner({ compact })` (Task 2).
- Produces: `OverdueBanner({ count })` — renders nothing when `count <= 0`; else a destructive `role="alert"` banner using `t('admin.broadcasts.queue.overdueBanner', { count })`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/broadcast/overdue-banner.test.tsx
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { OverdueBanner } from '@/components/broadcast/admin/overdue-banner';

function renderBanner(count: number) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <OverdueBanner count={count} />
    </NextIntlClientProvider>,
  );
}
afterEach(cleanup);

describe('OverdueBanner', () => {
  it('renders nothing when count is 0', () => {
    const { container } = renderBanner(0);
    expect(container.firstChild).toBeNull();
  });
  it('renders a destructive alert with the count when > 0', () => {
    renderBanner(3);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/3 broadcasts have been waiting over 48 hours/);
    expect(alert.className).toContain('bg-destructive-surface');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing)**

Run: `pnpm vitest run tests/unit/broadcast/overdue-banner.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Create `overdue-banner.tsx`** (sync server component, `useTranslations`)

```tsx
import { useTranslations } from 'next-intl';

export function OverdueBanner({ count }: { readonly count: number }): React.ReactElement | null {
  const t = useTranslations('admin.broadcasts.queue');
  if (count <= 0) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive-surface p-3 text-sm font-medium text-destructive"
    >
      {t('overdueBanner', { count })}
    </div>
  );
}
```
(Mirrors the shipped erasure-log breach banner `erasure-log/page.tsx:179-184`.)

- [ ] **Step 4: Wire the page** (`page.tsx`)

After the existing `totalPending` query block (`:254-260`), add the overdue count (same `runInTenant` + tenant-explicit pattern):
```ts
const overdueRows = (await runInTenant(tenant, async (tx) =>
  tx.execute(sql`
    SELECT COUNT(*)::int AS n FROM broadcasts
    WHERE tenant_id = ${tenant.slug}
      AND status = 'submitted'
      AND submitted_at < NOW() - INTERVAL '48 hours'
  `),
)) as unknown as Array<{ n: number }>;
const overdueCount = overdueRows[0]?.n ?? 0;
```
Compute the default-view gate + truncation flag:
```ts
// Overdue banner + truncation note only on the default `submitted` view — a
// filtered/searched subset would mislead (mirror erasure-log unfiltered gating).
const isDefaultView = !explicitShowAll && params.status === undefined && params.memberId === undefined;
const showOverdue = isDefaultView && overdueCount > 0;
const truncated = isDefaultView && listResult.nextCursor !== null;
```
In the JSX, replace `<SlaBanner stats={slaStats} />` with:
```tsx
<OverdueBanner count={showOverdue ? overdueCount : 0} />
<SlaBanner stats={slaStats} compact={showOverdue} />
{truncated ? (
  <p className="text-xs text-muted-foreground">{t('truncationNote')}</p>
) : null}
```
Add the import: `import { OverdueBanner } from '@/components/broadcast/admin/overdue-banner';`.

- [ ] **Step 5: Fix the loading skeleton chip count** (`loading.tsx`)

Import `BROADCAST_STATUSES` and derive the chip count; update the comment:
```ts
import { BROADCAST_STATUSES } from '@/modules/broadcasts';
// …
{Array.from({ length: BROADCAST_STATUSES.length }).map((_, i) => (
  <Skeleton key={i} className="h-11 w-24 rounded-full" />
))}
```
(Verify `queue-filters.tsx` renders one chip per `BROADCAST_STATUSES` so the counts match; if it renders a subset, match THAT count instead and note it.)

- [ ] **Step 6: Run tests + gates**

Run: `pnpm vitest run tests/unit/broadcast/overdue-banner.test.tsx` → PASS.
Run: `pnpm typecheck` → PASS. `pnpm lint` → PASS. `pnpm check:layout` → PASS (TableContainer pairing).

- [ ] **Step 7: Commit**

```bash
git add src/components/broadcast/admin/overdue-banner.tsx "src/app/(staff)/admin/broadcasts/page.tsx" "src/app/(staff)/admin/broadcasts/loading.tsx" tests/unit/broadcast/overdue-banner.test.tsx
git commit -m "feat(broadcasts): overdue-now breach banner + SLA demote + truncation note + skeleton chip count"
```

---

## Task 4: Audience column — human label, not raw enum

**Files:**
- Modify: `src/components/broadcast/admin/queue-table.tsx`
- Test: `tests/unit/broadcast/queue-table-segment.test.tsx`

**Interfaces:**
- Consumes: the existing `admin.broadcasts.review.segmentType.*` labels (as `[id]/page.tsx:44,191` already does).
- Produces: `EnrichedQueueRow.segmentLabel` now carries the localised label, not the raw enum.

- [ ] **Step 1: Write the failing test**

`QueueTable` is an async server component; test that the enriched row it hands `QueueTableClient` carries the localised label. Simplest: render `QueueTable` and assert the DOM shows the label, not the enum.
```tsx
// tests/unit/broadcast/queue-table-segment.test.tsx
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { QueueTable, type QueueRow } from '@/components/broadcast/admin/queue-table';

const row: QueueRow = {
  broadcastId: 'b1', status: 'submitted', subject: 'Hello', requestedByMemberId: 'm1',
  requestedByMemberDisplayName: 'Acme Co', actorRole: 'member_self_service',
  segmentType: 'event_attendees_last_90d', estimatedRecipientCount: 12,
  submittedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z',
};
afterEach(cleanup);

it('renders the localised segment label, not the raw enum', async () => {
  const ui = await QueueTable({ rows: [row], readOnly: false });
  render(<NextIntlClientProvider locale="en" messages={enMessages}>{ui}</NextIntlClientProvider>);
  expect(screen.getByText('Event attendees (last 90 days)')).toBeInTheDocument();
  expect(screen.queryByText('event_attendees_last_90d')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run it — expect FAIL** (shows the raw enum)

Run: `pnpm vitest run tests/unit/broadcast/queue-table-segment.test.tsx`
Expected: FAIL — `event_attendees_last_90d` is in the DOM; the label is not.

- [ ] **Step 3: Implement** (`queue-table.tsx`)

Add the segment translator (mirror `[id]/page.tsx:44`) and use it:
```ts
const tSegment = await getTranslations('admin.broadcasts.review.segmentType');
```
In the `enrichedRows` map, change `segmentLabel: row.segmentType` to:
```ts
segmentLabel: tSegment(row.segmentType as Parameters<typeof tSegment>[0]),
```

- [ ] **Step 4: Run test + gates**

Run: `pnpm vitest run tests/unit/broadcast/queue-table-segment.test.tsx` → PASS.
Run: `pnpm typecheck` → PASS. `pnpm lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/broadcast/admin/queue-table.tsx tests/unit/broadcast/queue-table-segment.test.tsx
git commit -m "fix(broadcasts): Audience column shows localised segment label, not raw enum"
```

---

## Task 5: Bulk-bar a11y + ICU plural (client)

**Files:**
- Modify: `src/components/broadcast/admin/queue-table-client.tsx`
- Modify: `src/components/broadcast/admin/queue-table.tsx` (drop the `bulk*` count/partial `columnLabels` — the client now translates them)
- Test: `tests/unit/broadcast/queue-table-client-a11y.test.tsx`

**Interfaces:**
- Consumes: `admin.broadcasts.queue.bulk.*` i18n (Task 1 ICU).
- Produces: the client component translates its own bulk strings via `useTranslations`; `QueueTableClientProps.columnLabels` no longer carries `bulkSelected`/`bulkSuccess`/`bulkFailure`/`bulkPartial`/`bulkApprove`/`bulkClear`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/broadcast/queue-table-client-a11y.test.tsx
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { QueueTableClient, type EnrichedQueueRow } from '@/components/broadcast/admin/queue-table-client';

const base: EnrichedQueueRow = {
  broadcastId: 'b1', subject: 'Hi', memberDisplayName: 'Acme', actorRoleLabel: null,
  segmentLabel: 'All members', recipientCount: 5, submittedAtFormatted: '1 Aug 2026, 07:00',
  ageBadge: null, statusBadgeVariant: 'secondary', statusBadgeLabel: 'Submitted', actionable: true,
};
const rows = [base, { ...base, broadcastId: 'b2', subject: 'Hi2' }];
// columnLabels now omits the bulk.* strings (client translates them):
const columnLabels = {
  submittedAt: 'Submitted', member: 'Member', subject: 'Subject', segment: 'Audience',
  recipientCount: 'Recipients', status: 'Status', actions: 'Actions', select: 'Select broadcast',
  tableAria: 'Broadcast review queue',
};
function renderTable() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QueueTableClient rows={rows} columnLabels={columnLabels} />
    </NextIntlClientProvider>,
  );
}
afterEach(cleanup);

describe('QueueTableClient a11y + ICU', () => {
  it('the selected-count region is aria-live=polite and pluralises via ICU', async () => {
    renderTable();
    const [rowCheckbox] = screen.getAllByRole('checkbox', { name: /select broadcast/i });
    await userEvent.click(rowCheckbox);
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live).toHaveTextContent(/1 selected/);
  });
  it('the header select-all checkbox exposes an indeterminate (mixed) state', async () => {
    const { container } = renderTable();
    const [rowCheckbox] = screen.getAllByRole('checkbox', { name: /select broadcast/i });
    await userEvent.click(rowCheckbox); // 1 of 2 selected → mixed
    // shadcn Checkbox indeterminate → aria-checked="mixed" on the header control
    const mixed = container.querySelector('[aria-checked="mixed"]');
    expect(mixed).not.toBeNull();
  });
  it('checkbox targets meet the 24px minimum', () => {
    const { container } = renderTable();
    const cb = container.querySelector('button[role="checkbox"], input[type="checkbox"]');
    expect(cb?.className ?? '').toMatch(/min-h-\[24px\]|min-w-\[24px\]/);
  });
});
```
(If the shadcn `Checkbox` renders differently, match the real DOM — the intent is: aria-live count, an `indeterminate`/`mixed` header state, and a 24 px target class.)

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run tests/unit/broadcast/queue-table-client-a11y.test.tsx`
Expected: FAIL (no `aria-live`, no mixed state, no 24 px class, and the props still require `bulkSelected` etc.).

- [ ] **Step 3: Implement** (`queue-table-client.tsx`)

- Add `import { useTranslations } from 'next-intl';` and `const tBulk = useTranslations('admin.broadcasts.queue.bulk');`.
- Remove `bulkSelected`/`bulkApprove`/`bulkClear`/`bulkSuccess`/`bulkFailure`/`bulkPartial` from `QueueTableClientProps.columnLabels`; use `tBulk('selected', {count})`, `tBulk('approveSelected')`, `tBulk('clear')`, `tBulk('successAll')`, `tBulk('failureAll')`, and for the partial toast `tBulk('partial', { ok: succeeded, fail: failures.length })` (drop the `.replace()` calls at `:370-372,422-425`).
- Header select-all checkbox: add the `indeterminate` state (some-but-not-all actionable rows selected):
  ```tsx
  const actionableRows = table.getRowModel().rows.filter((r) => r.original.actionable);
  const selectedActionable = actionableRows.filter((r) => r.getIsSelected());
  const allSelected = actionableRows.length > 0 && selectedActionable.length === actionableRows.length;
  const someSelected = selectedActionable.length > 0 && !allSelected;
  // <Checkbox checked={allSelected} indeterminate={someSelected} className="min-h-[24px] min-w-[24px]" … />
  ```
  (Confirm the shadcn `Checkbox` prop name — `indeterminate` — in `src/components/ui/checkbox.tsx`; if it takes `checked="indeterminate"`, use that form.)
- Add `min-h-[24px] min-w-[24px]` to BOTH the header and per-row select checkboxes (`:115-131`).
- The selected-count span in the bulk bar (`:434`): add `aria-live="polite"` and render `tBulk('selected', { count: selectedIds.length })`.
- **Age-badge token (WS-E, same file).** The amber age badge (`:154`) uses raw `border-amber-400/40 bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200` — swap to `border-warning/40 bg-warning-surface text-warning`. Leave the red branch (`:153`, already `bg-destructive-surface text-destructive`) and its `AlertCircle`/`Clock` icons.

Then in `queue-table.tsx`, drop the now-unused `bulk*` entries from the `columnLabels` object passed to `<QueueTableClient>` (keep `select` + `tableAria` + the column headers).

- [ ] **Step 4: Run test + gates**

Run: `pnpm vitest run tests/unit/broadcast/queue-table-client-a11y.test.tsx` → PASS.
Run: `pnpm typecheck` → PASS. `pnpm lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/broadcast/admin/queue-table-client.tsx src/components/broadcast/admin/queue-table.tsx tests/unit/broadcast/queue-table-client-a11y.test.tsx
git commit -m "feat(broadcasts): bulk-bar a11y (aria-live + indeterminate + 24px) + ICU-plural bulk strings"
```

---

## Task 6: Single-approve shows recipient count

**Files:**
- Modify: `src/components/broadcast/admin/approve-dialog.tsx`
- Modify: `src/components/broadcast/admin/review-actions.tsx`
- Modify: `src/components/broadcast/admin/queue-table-client.tsx` (pass `recipientCount` into `ReviewActions`)
- Test: `tests/unit/broadcast/approve-dialog-recipient.test.tsx`

**Interfaces:**
- Consumes: `EnrichedQueueRow.recipientCount` (already present); `admin.broadcasts.approveDialog.recipientCount` (Task 1).
- Produces: `ApproveDialog` + `ReviewActions` gain an optional `recipientCount?: number`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/broadcast/approve-dialog-recipient.test.tsx
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ApproveDialog } from '@/components/broadcast/admin/approve-dialog';

afterEach(cleanup);
it('shows the recipient count when provided', () => {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ApproveDialog broadcastId="b1" open onOpenChange={() => {}} recipientCount={12} />
    </NextIntlClientProvider>,
  );
  expect(screen.getByText(/Reaches ~12 recipients/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it — expect FAIL** (no such prop / text)

Run: `pnpm vitest run tests/unit/broadcast/approve-dialog-recipient.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `approve-dialog.tsx`: add `readonly recipientCount?: number;` to `ApproveDialogProps`; inside the dialog body (near `AlertDialogDescription`) render, when defined:
  ```tsx
  {recipientCount !== undefined ? (
    <p className="text-sm text-muted-foreground">{t('recipientCount', { count: recipientCount })}</p>
  ) : null}
  ```
  (`t` is the existing `useTranslations('admin.broadcasts.approveDialog')` in that file.)
- `review-actions.tsx`: add `readonly recipientCount?: number;` to `ReviewActionsProps`; pass it through to `<ApproveDialog recipientCount={recipientCount} …>`.
- `queue-table-client.tsx`: in the `actions` column cell (`:231-234`), pass the row's count: `<ReviewActions broadcastId={ctx.row.original.broadcastId} recipientCount={ctx.row.original.recipientCount} />`.

- [ ] **Step 4: Run test + gates**

Run: `pnpm vitest run tests/unit/broadcast/approve-dialog-recipient.test.tsx` → PASS.
Run: `pnpm typecheck` → PASS. `pnpm lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/broadcast/admin/approve-dialog.tsx src/components/broadcast/admin/review-actions.tsx src/components/broadcast/admin/queue-table-client.tsx tests/unit/broadcast/approve-dialog-recipient.test.tsx
git commit -m "feat(broadcasts): single-approve dialog shows recipient count"
```

---

## Task 7: E2E — a11y + i18n + overdue banner

**Files:**
- Modify: the broadcast-queue e2e spec (find it: `ls tests/e2e | grep -i broadcast`)

- [ ] **Step 1: Update / add assertions**

In the admin broadcast-queue e2e (sign in as admin, go to `/admin/broadcasts`):
- **No raw-enum leak:** assert the Audience cell does NOT contain `event_attendees_last_90d` / `all_members` / `tier` / `custom` raw strings (`await expect(page.getByText('event_attendees_last_90d')).toHaveCount(0)`), and DOES show a localised label when a submitted broadcast with a known segment is present (use the existing broadcast seed helper if any; otherwise assert the negative only).
- **Bulk a11y:** select a `submitted` row's checkbox → assert an `[aria-live="polite"]` element shows "1 selected".
- **@a11y:** keep/add the axe-core WCAG 2.1/2.2 AA scan of `/admin/broadcasts` (now covers the overdue banner + SLA token colours + bulk a11y) — no violations.
- **@i18n:** EN/TH/SV render the localised page + the new de-jargoned SLA copy with no `MISSING_MESSAGE` / raw-key leak.
Run with `--workers=1`. If a dev server for this branch's code is not reachable, run against the worktree port (`E2E_BASE_URL=http://localhost:<worktree-port>`) — the plain `:3100` may serve the main checkout; identify the worktree's port before running (see the worktree-e2e note). If no dev server is available, report DONE_WITH_CONCERNS: spec updated + typecheck/lint/check:fixme green but not executed.

- [ ] **Step 2: Gates**

Run: `pnpm typecheck` · `pnpm lint` · `pnpm check:fixme` (no `test.fixme`/bare skip) → all PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/<broadcast-queue-spec>.ts
git commit -m "test(broadcasts): e2e for overdue banner + Audience label + bulk aria-live + a11y"
```

---

## Final gates (before PR)

```bash
pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm check:layout && pnpm vitest run tests/unit/broadcast/
```
All must pass. This is a UI PR → an `enterprise-ux-designer` pass (per CLAUDE.md). No security review needed for PR1 (no send/approve/RBAC change — the one new query is a read-only tenant-scoped COUNT).

## Self-review notes (PR1 spec coverage)

- WS-A overdue banner + de-jargon + priority demote + nextCursor truncation → Tasks 1, 2, 3.
- WS-B Audience raw-enum → Task 4; ICU plural → Tasks 1, 5; dead-key removal → Task 1; single-approve recipient count → Tasks 1, 6.
- WS-C aria-live + indeterminate + 24 px → Task 5.
- WS-E SLA + age-badge tokens → Task 2 (SLA) + **age badge in `queue-table-client.tsx:154`** → fold the amber→`text-warning`/`bg-warning-surface` swap into Task 5 (same file) — add a one-line note there.
- WS-G skeleton chip count → Task 3.
- Deferred (NOT PR1): shared `<Table>` + mobile cards + fixed-bottom toolbar (PR2); bulk-approve confirm + schedule + Undo (PR3).
