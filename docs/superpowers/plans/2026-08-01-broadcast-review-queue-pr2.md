# E-Blast Review-Queue UX — PR2 Implementation Plan (shared `<Table>` + mobile cards + bulk-bar convergence)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge the E-Blast review queue (`/admin/broadcasts`) onto the same table/mobile/bulk-toolbar structure the members & renewals admin lists use — shared `<Table>` primitive, a mobile card fallback, and a fixed-bottom `role="toolbar"` bulk bar — plus the WS-G filter-chip grouping and the three deferred PR1 Minors.

**Architecture:** Render-tree change, presentation-only. The current `queue-table-client.tsx` hand-rolls a `<table>` + a dead virtualizer + a sticky-TOP `role="region"` bulk bar and owns its own selection. PR2 (1) removes the virtualizer, (2) swaps the hand-rolled table for `@/components/ui/table.tsx`, (3) adds a `QueueCardList` dual-rendered under `md:hidden` sharing ONE `useReactTable` instance, and (4) lifts selection into a `QueueWithBulk` wrapper that composes the table + a new fixed-bottom `QueueBulkActionBar` (the existing bulk-approve fan-out moves into it, unchanged, still hardcoding `{decision:'send_now'}` — the send-confirm/schedule is PR3). No endpoint, RBAC, or money change.

**Tech Stack:** Next.js 16 RSC + `'use client'`, React 19, `@tanstack/react-table@^8`, Base UI `Checkbox`, Tailwind v4 semantic tokens, next-intl (EN canonical/TH/SV, ICU), Vitest + `@testing-library/react` + `NextIntlClientProvider`, Playwright + axe-core.

## Global Constraints

- **Presentation-only. No money-path, approve/reject/cancel endpoint, or RBAC change.** The bulk-approve fan-out still posts a hardcoded `{decision:'send_now'}` in PR2 — the send-now/schedule choice + confirm dialog + Undo is **PR3** (do NOT add it here).
- **Mirror the existing bars/tables EXACTLY** — reuse `@/components/ui/table.tsx`, the members/renewals fixed-bottom bar shape, and the shared `BULK_CAP`. Do NOT invent a broadcast-specific toolbar keyboard model (no roving-tabindex) — plain tab order, matching `bulk-action-bar.tsx` / `pipeline-bulk-action-bar.tsx`.
- **Shared cap** = `BULK_CAP` (100) imported from `@/lib/members-bulk-constants`. Keep the existing `BULK_CHUNK = 5` concurrency throttle (unrelated to the 100 cap).
- **ONE `useReactTable` instance** is shared between the desktop `<table>` and the mobile `QueueCardList` (pass the `table` instance as a prop, mirroring `PipelineCardList`). Never build a second instance for the cards.
- **Selection is uncontrolled TanStack state in the table client**, lifted to the wrapper via an `onSelectionChange(ids)` callback + reset via a `clearSelectionNonce` counter (mirror `directory-with-bulk.tsx`). The wrapper owns `selectedIds`.
- **Semantic tokens only** — no raw `emerald-*`/`amber-*`. Reuse the AA-tuned `--success`/`--warning`/`--destructive` tokens already in `globals.css`. The dark-mode `--destructive-foreground` trap (does NOT flip near-black) → `dark:text-background` on any `bg-destructive text-destructive-foreground` pill.
- **i18n**: every new key present in EN/TH/SV (`check:i18n`), ICU plurals for counts, TH uses classifier-based counts (no grammatical plural, no faux-italic), `text-muted-foreground` stays the empty-`—` sentinel. Delete NO keys in PR2 (PR1 already removed the dead ones).
- **Fixed-bottom bar** must render a ResizeObserver-measured spacer so it never covers the last row (round the measured height UP; fall back to `offsetHeight` when `ResizeObserver` is undefined).
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Conventional Commits. Never `git add -A` (stray `i18n_dump*.txt` at worktree root — stage explicit paths only). Never run `pnpm format`/prettier.
- **Gates before PR**: `pnpm lint` + `pnpm typecheck` + `pnpm check:i18n` + `pnpm check:layout` + `pnpm vitest run tests/unit/broadcast/`. Any UI PR → an `enterprise-ux-designer` pass. No security review needed (no send/RBAC/endpoint change).

## Reference files to mirror (read before implementing)

- Shared table: `src/components/ui/table.tsx` — `Table` (self-wraps in `<div role="region" tabIndex={0} aria-label>` focusable scroll container), `TableHeader` (`sticky top-0 z-10 bg-card`), `TableBody`, `TableRow` (`h-[var(--table-row-height)]`), `TableHead`, `TableCell`.
- Dual-render precedent: `src/app/(staff)/admin/renewals/_components/pipeline-table.tsx:508-619` (wrapper) + `pipeline-card-list.tsx` (`export function PipelineCardList({ table, ... , className })`, reads `table.getRowModel().rows`).
- Fixed-bottom bar precedent: `src/app/(staff)/admin/members/_components/bulk-action-bar.tsx:377-419` (bar markup, `role="toolbar"`, `aria-live` count, over-cap alert) + `:138-158` + `bulk-action-bar-spacer.test.tsx` (ResizeObserver spacer) ; wrapper `directory-with-bulk.tsx:195-217` (owns selection, `clearSelectionNonce`).
- Shared cap: `src/lib/members-bulk-constants.ts` — `export const BULK_CAP = 100;`.
- Current queue (what PR2 rewrites): `src/components/broadcast/admin/queue-table-client.tsx` (579 lines) + RSC wrapper `queue-table.tsx`.
- Focus helper: `useDialogFinalFocus` from `src/components/broadcast/reason-confirmation-dialog.tsx:76-94`.
- Progress: `BulkProgressIndicator` from `src/app/(staff)/admin/members/_components/bulk-progress-indicator.tsx:44` (accepts `namespace` — pass `admin.broadcasts.queue.bulk`).

---

## File structure (created / modified)

- **Modify** `src/components/broadcast/admin/queue-table-client.tsx` — remove virtualization; adopt `<Table>`; dual-render desktop table + `<QueueCardList>`; lift selection out (accept `enableSelection`, `onSelectionChange`, `clearSelectionNonce`); remove the internal sticky-top `role="region"` bar.
- **Create** `src/components/broadcast/admin/queue-card-list.tsx` — mobile card list, shares the `table` instance.
- **Create** `src/components/broadcast/admin/queue-bulk-action-bar.tsx` — fixed-bottom `role="toolbar"` bar; owns the `handleBulkApprove` fan-out (moved from the client), the ResizeObserver spacer, the `BULK_CAP` over-cap alert.
- **Create** `src/components/broadcast/admin/queue-with-bulk.tsx` — wrapper owning `selectedIds` + `clearSelectionNonce`; composes `<QueueTableClient>` + `<QueueBulkActionBar>`.
- **Modify** `src/components/broadcast/admin/queue-table.tsx` — render `<QueueWithBulk>` (passing the enriched rows + labels) instead of `<QueueTableClient>` directly.
- **Modify** `src/components/broadcast/admin/queue-filters.tsx` — WS-G: group status chips (in-review vs terminal), keep Reset adjacent.
- **Modify** `src/components/broadcast/admin/approve-dialog.tsx` — M1: fold recipient count into the announced `aria-describedby`.
- **Modify** `src/components/broadcast/admin/sla-banner.tsx` — M3 (optional): suppress the compact "within —h" line when `decisionCount === 0`.
- **Modify** `src/i18n/messages/{en,th,sv}.json` — new bulk-toolbar + card-label keys.
- **Tests**: `tests/unit/broadcast/queue-card-list.test.tsx`, `queue-bulk-action-bar.test.tsx`, `queue-with-bulk.test.tsx`, `queue-filters-grouping.test.tsx`, `approve-dialog-describedby.test.tsx`; update `queue-table-client-a11y.test.tsx`; extend `tests/e2e/admin-review-queue.spec.ts`.

---

### Task 1: i18n keys for the bulk toolbar + card labels

**Files:**
- Modify: `src/i18n/messages/en.json` (canonical) + `th.json` + `sv.json` — under `admin.broadcasts.queue`

**Interfaces:**
- Produces: keys `bulk.toolbarLabel`, `bulk.selectedCount` (ICU plural), `bulk.clear`, `bulk.approveSelected`, `bulk.overCap`, `bulk.overCapHelper`, `card.actionsLabel`, `card.audienceLabel`, `card.recipientsLabel`, `card.submittedLabel`, `card.statusLabel` — consumed by Tasks 3–6.

- [ ] **Step 1: Add keys to `en.json`** under the existing `admin.broadcasts.queue` object (the PR1 `bulk.selected` ICU key already exists — add alongside it):

```json
"bulk": {
  "selected": "{count, plural, one {# selected} other {# selected}}",
  "toolbarLabel": "Bulk actions for selected broadcasts",
  "selectedCount": "{count, plural, one {# selected} other {# selected}}",
  "clear": "Clear",
  "approveSelected": "Approve selected",
  "overCap": "Selection limited to {max}",
  "overCapHelper": "You selected {count} — only the first {max} will be actioned."
},
"card": {
  "actionsLabel": "Actions",
  "audienceLabel": "Audience",
  "recipientsLabel": "Recipients",
  "submittedLabel": "Submitted",
  "statusLabel": "Status"
}
```

- [ ] **Step 2: Mirror into `th.json`** (classifier counts, NO grammatical plural, no faux-italic):

```json
"bulk": {
  "selected": "{count, plural, other {เลือกแล้ว # รายการ}}",
  "toolbarLabel": "การดำเนินการแบบกลุ่มสำหรับบรอดแคสต์ที่เลือก",
  "selectedCount": "{count, plural, other {เลือกแล้ว # รายการ}}",
  "clear": "ล้าง",
  "approveSelected": "อนุมัติรายการที่เลือก",
  "overCap": "จำกัดการเลือกไว้ที่ {max} รายการ",
  "overCapHelper": "คุณเลือก {count} รายการ — จะดำเนินการเฉพาะ {max} รายการแรกเท่านั้น"
},
"card": {
  "actionsLabel": "การดำเนินการ",
  "audienceLabel": "กลุ่มผู้รับ",
  "recipientsLabel": "ผู้รับ",
  "submittedLabel": "ส่งเมื่อ",
  "statusLabel": "สถานะ"
}
```

- [ ] **Step 3: Mirror into `sv.json`** (SV plural; keep button strings short — the bar `whitespace-nowrap`s them):

```json
"bulk": {
  "selected": "{count, plural, one {# markerad} other {# markerade}}",
  "toolbarLabel": "Massåtgärder för valda utskick",
  "selectedCount": "{count, plural, one {# markerad} other {# markerade}}",
  "clear": "Rensa",
  "approveSelected": "Godkänn valda",
  "overCap": "Urvalet begränsat till {max}",
  "overCapHelper": "Du valde {count} — endast de första {max} åtgärdas."
},
"card": {
  "actionsLabel": "Åtgärder",
  "audienceLabel": "Målgrupp",
  "recipientsLabel": "Mottagare",
  "submittedLabel": "Skickat",
  "statusLabel": "Status"
}
```

- [ ] **Step 4: Verify parity** — `pnpm check:i18n` → `[check:i18n] OK`. If a `bulk`/`card` object already exists in one locale, MERGE keys into it (don't duplicate the object).

- [ ] **Step 5: Commit**

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "feat(broadcasts): i18n keys for fixed-bottom bulk toolbar + mobile card labels"
```

---

### Task 2: Drop the dead virtualization

**Files:**
- Modify: `src/components/broadcast/admin/queue-table-client.tsx` (remove: import line 31, `VIRTUALIZE_THRESHOLD` line 39, `shouldVirtualize` line 262, `useVirtualizer` block 265-271, the virtualized return branch 529-578)
- Test: `tests/unit/broadcast/queue-table-client-a11y.test.tsx` (add a no-virtualization assertion)

**Interfaces:**
- Produces: a `queue-table-client.tsx` that renders every row unconditionally through the single non-virtualized `<table>` path (still hand-rolled at this point — Task 3 swaps in `<Table>`).

- [ ] **Step 1: Add a failing test** to `queue-table-client-a11y.test.tsx` asserting all rows render (no padding-row virtualization). Mirror the file's existing harness (real `NextIntlClientProvider` + `en.json`, `vi.mock('next/navigation'…useRouter)`, `PointerEvent` polyfill, `vi.useRealTimers()`):

```tsx
it('renders every row without virtualization padding rows', () => {
  const rows = Array.from({ length: 12 }, (_, i) => makeRow({ broadcastId: `b${i}`, subject: `Subject ${i}` }));
  const { container } = render(
    <Provider><QueueTableClient rows={rows} readOnly={false} columnLabels={LABELS} /></Provider>,
  );
  const bodyRows = container.querySelectorAll('tbody tr');
  expect(bodyRows).toHaveLength(12);              // exactly the data rows
  expect(container.querySelector('[data-testid="virtual-padding-top"]')).toBeNull();
});
```
(If the current virtualized branch used a different padding marker, assert instead that `tbody tr` count === data length — the point is: no synthetic padding rows.)

- [ ] **Step 2: Run to verify it fails** (or passes trivially): `pnpm vitest run tests/unit/broadcast/queue-table-client-a11y.test.tsx`. If it already passes (because 12 < 100 never virtualizes), that confirms the branch is dead — proceed; the test now guards against re-introduction.

- [ ] **Step 3: Delete the virtualization** — remove from `queue-table-client.tsx`: the `useVirtualizer` import (line 31), `const VIRTUALIZE_THRESHOLD = 100` (39), `const shouldVirtualize = rows.length > VIRTUALIZE_THRESHOLD` (262), the `useVirtualizer({...})` block (265-271), and collapse the `if (!shouldVirtualize) { return (...) } return (<virtualized>)` split (509-578) into a single return of the non-virtualized table. Remove `tableRef`/`rowVirtualizer` refs if now unused. Keep `headerRow`, `handleBulkApprove`, the sticky-top bar, and the announcer for now.

- [ ] **Step 4: Run tests** — `pnpm vitest run tests/unit/broadcast/queue-table-client-a11y.test.tsx` → PASS; `pnpm typecheck` → no unused-symbol / TS errors (strict). `pnpm lint` on the file → clean (no unused imports).

- [ ] **Step 5: Commit**

```bash
git add src/components/broadcast/admin/queue-table-client.tsx tests/unit/broadcast/queue-table-client-a11y.test.tsx
git commit -m "refactor(broadcasts): drop dead row virtualization (never fired at pageSize 50)"
```

---

### Task 3: Adopt the shared `<Table>` primitive (desktop path)

**Files:**
- Modify: `src/components/broadcast/admin/queue-table-client.tsx` (replace hand-rolled `<div><table><thead><tbody>` 481-504 + `headerRow` 396-417 with `@/components/ui/table.tsx` + `flexRender`)
- Test: `tests/unit/broadcast/queue-table-client-a11y.test.tsx`

**Interfaces:**
- Consumes: `Table, TableHeader, TableBody, TableRow, TableHead, TableCell` from `@/components/ui/table`.
- Produces: desktop table rendered via the shared primitive (focusable `role="region"` scroll container, sticky `bg-card` header, `--table-row-height` rows).

- [ ] **Step 1: Add a failing test** — assert the shared primitive is used:

```tsx
it('renders through the shared Table primitive (focusable region + sticky header)', () => {
  const { container } = render(
    <Provider><QueueTableClient rows={[makeRow({ broadcastId: 'b1' })]} readOnly={false} columnLabels={LABELS} /></Provider>,
  );
  expect(container.querySelector('[data-slot="table"]')).not.toBeNull();
  const region = container.querySelector('[data-slot="table-container"]');
  expect(region).toHaveAttribute('tabindex', '0');
  expect(region).toHaveAttribute('role', 'region');
  expect(container.querySelector('[data-slot="table-header"]')).toHaveClass('sticky');
});
```

- [ ] **Step 2: Run to verify it fails**: `pnpm vitest run tests/unit/broadcast/queue-table-client-a11y.test.tsx` → FAIL (`data-slot="table"` absent; still hand-rolled).

- [ ] **Step 3: Replace the markup.** Import `{ Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'` and `{ flexRender } from '@tanstack/react-table'`. Replace the hand-rolled block with:

```tsx
<Table aria-label={columnLabels.tableAria}>
  <TableHeader>
    {table.getHeaderGroups().map((hg) => (
      <TableRow key={hg.id}>
        {hg.headers.map((h) => (
          <TableHead key={h.id} scope="col">
            {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
          </TableHead>
        ))}
      </TableRow>
    ))}
  </TableHeader>
  <TableBody>
    {table.getRowModel().rows.map((row) => (
      <TableRow key={row.id} data-state={row.getIsSelected() ? 'selected' : undefined}>
        {row.getVisibleCells().map((cell) => (
          <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
        ))}
      </TableRow>
    ))}
  </TableBody>
</Table>
```
Delete the now-unused manual `headerRow` JSX (396-417) and the `min-w-[920px]` wrapper. Keep the `useReactTable` instance + column defs untouched. Wrap the whole desktop `<Table>` in `<div className="hidden md:block">` (prepares Task 4's dual-render — the card list arrives next).

- [ ] **Step 4: Run tests** → PASS. `pnpm typecheck` + `pnpm lint` clean. Confirm the existing a11y tests (24px checkboxes, indeterminate header, aria-live announcer) still pass — the announcer + bar are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/components/broadcast/admin/queue-table-client.tsx tests/unit/broadcast/queue-table-client-a11y.test.tsx
git commit -m "refactor(broadcasts): adopt shared ui/table primitive for the queue desktop table"
```

---

### Task 4: Mobile `QueueCardList` fallback (dual-render, one table instance)

**Files:**
- Create: `src/components/broadcast/admin/queue-card-list.tsx`
- Modify: `src/components/broadcast/admin/queue-table-client.tsx` (render `<QueueCardList table={table} … className="md:hidden" />` beside the `hidden md:block` table)
- Test: `tests/unit/broadcast/queue-card-list.test.tsx`

**Interfaces:**
- Consumes: `table: Table<EnrichedQueueRow>` (the shared instance), `readOnly: boolean`, `columnLabels` (for card field labels), `className?: string`.
- Produces: `export function QueueCardList(props: QueueCardListProps): React.JSX.Element` — reads `table.getRowModel().rows`, renders one `<Card role="group">` per row with subject link + member + status/age badges + recipient count + submitted-at + the select checkbox (24px) + per-row `ReviewActions`.

- [ ] **Step 1: Write the failing test** (standalone Harness building its own `useReactTable`, mirroring `pipeline-card-list.test.tsx`):

```tsx
import { render, screen, within } from '@testing-library/react';
import { useReactTable, getCoreRowModel } from '@tanstack/react-table';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { QueueCardList } from '@/components/broadcast/admin/queue-card-list';

function Harness({ rows }: { rows: EnrichedQueueRow[] }) {
  const table = useReactTable({
    data: rows, columns: [], getCoreRowModel: getCoreRowModel(),
    enableRowSelection: (r) => r.original.actionable, getRowId: (r) => r.broadcastId,
  });
  return <QueueCardList table={table} readOnly={false} columnLabels={LABELS} />;
}

it('renders one card per row with labelled fields', () => {
  render(<NextIntlClientProvider locale="en" messages={enMessages}>
    <Harness rows={[makeRow({ broadcastId: 'b1', subject: 'Q3 Newsletter' })]} /></NextIntlClientProvider>);
  const list = screen.getByTestId('queue-card-list');
  expect(within(list).getByText('Q3 Newsletter')).toBeInTheDocument();
  expect(within(list).getByText(/Audience/)).toBeInTheDocument();          // card.audienceLabel
  expect(within(list).getByText(/Recipients/)).toBeInTheDocument();        // card.recipientsLabel
});
```

- [ ] **Step 2: Run to verify it fails**: `pnpm vitest run tests/unit/broadcast/queue-card-list.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Create `queue-card-list.tsx`** mirroring `pipeline-card-list.tsx` (persistent `<div data-testid="queue-card-list"><ul role="list">` of `<li><Card role="group" aria-label={row.subject} data-state={row.getIsSelected() ? 'selected' : undefined} className="data-[state=selected]:bg-muted"><CardContent>`). Per card, top row = select `Checkbox` (`min-h-[24px] min-w-[24px]`, only when `row.getCanSelect()` && !readOnly, `checked={row.getIsSelected()}` `onCheckedChange={() => row.toggleSelected()}`, `aria-label` reusing the client's select label) + subject as the existing subject link + status badge. Then labelled rows (a small `LabeledRow` local helper: `<div className="flex justify-between gap-2 text-sm"><span className="text-muted-foreground">{label}</span><span>{value}</span></div>`) for Audience (`row.original.segmentLabel`), Recipients (`row.original.recipientCount`), Submitted (`row.original.submittedAtLabel`), Status age (`row.original.ageBadge`). Bottom: `<div className="flex justify-end">` with the same per-row `ReviewActions` the desktop `actions` column renders (import + render once per card, guarded by `!readOnly`). Use `useTranslations('admin.broadcasts.queue.card')` for labels. NO second `useReactTable` — read only from the passed `table`.

- [ ] **Step 4: Wire the dual-render** in `queue-table-client.tsx` — after the `hidden md:block` desktop `<Table>`, render `<QueueCardList table={table} readOnly={readOnly} columnLabels={columnLabels} className="md:hidden" />`. Add `className` passthrough on the card list root.

- [ ] **Step 5: Run tests** → PASS; `pnpm vitest run tests/unit/broadcast/queue-table-client-a11y.test.tsx` still green (desktop assertions scope via `container.querySelector('tbody')` / `[data-slot="table"]`, unaffected by the extra `md:hidden` tree; if any query now matches two nodes, scope it to the table via `within(container.querySelector('[data-slot="table"]'))`). `pnpm typecheck` + `pnpm lint` clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/broadcast/admin/queue-card-list.tsx src/components/broadcast/admin/queue-table-client.tsx tests/unit/broadcast/queue-card-list.test.tsx tests/unit/broadcast/queue-table-client-a11y.test.tsx
git commit -m "feat(broadcasts): mobile QueueCardList fallback sharing one table instance"
```

---

### Task 5: Fixed-bottom `QueueBulkActionBar` (bar + fan-out + spacer + cap)

**Files:**
- Create: `src/components/broadcast/admin/queue-bulk-action-bar.tsx`
- Test: `tests/unit/broadcast/queue-bulk-action-bar.test.tsx`

**Interfaces:**
- Consumes: `selectedIds: string[]`, `onClear: () => void`, `readOnly: boolean` (bar renders nothing when `readOnly` or `selectedIds.length === 0`), `router` via `useRouter()` for `.refresh()` after the fan-out.
- Produces: `export function QueueBulkActionBar(props: QueueBulkActionBarProps): React.JSX.Element | null` — fixed-bottom `role="toolbar"` with `aria-live` count, `BULK_CAP` over-cap `role="alert"`, ResizeObserver spacer, and the `handleBulkApprove` fan-out (moved verbatim from `queue-table-client.tsx:285-394`, still `{decision:'send_now'}`).

- [ ] **Step 1: Write the failing test** — spacer + count + cap + fan-out. Mirror `bulk-action-bar-spacer.test.tsx`'s ResizeObserver stub:

```tsx
let roCb: ((e: unknown[]) => void) | undefined;
beforeEach(() => {
  roCb = undefined;
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: (e: unknown[]) => void) { roCb = cb; }
    observe() {} disconnect() {}
  });
});

it('renders a role=toolbar with an aria-live count and a ResizeObserver spacer', () => {
  const { container } = render(<Provider>
    <QueueBulkActionBar selectedIds={['b1','b2']} onClear={vi.fn()} readOnly={false} /></Provider>);
  const bar = screen.getByRole('toolbar');
  expect(bar).toHaveClass('fixed', 'bottom-0');
  expect(within(bar).getByText('2 selected')).toHaveAttribute('aria-live', 'polite');
  act(() => roCb?.([{ borderBoxSize: [{ blockSize: 68 }] }]));
  const spacer = container.querySelector('[aria-hidden="true"][data-testid="queue-bulk-spacer"]');
  expect(spacer).toHaveStyle({ height: '68px' });
});

it('shows an over-cap alert past BULK_CAP', () => {
  render(<Provider><QueueBulkActionBar selectedIds={Array.from({length:120},(_,i)=>`b${i}`)} onClear={vi.fn()} readOnly={false} /></Provider>);
  expect(screen.getByRole('alert')).toHaveTextContent(/Selection limited to 100/);
});

it('renders nothing when readOnly or empty', () => {
  const { container } = render(<Provider><QueueBulkActionBar selectedIds={[]} onClear={vi.fn()} readOnly={false} /></Provider>);
  expect(container.querySelector('[role="toolbar"]')).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**: `pnpm vitest run tests/unit/broadcast/queue-bulk-action-bar.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Create `queue-bulk-action-bar.tsx`.** Structure (mirror `bulk-action-bar.tsx:138-419`):
  - Early return `null` when `readOnly || selectedIds.length === 0`.
  - `const cappedIds = selectedIds.slice(0, BULK_CAP); const overCap = selectedIds.length > BULK_CAP;` (import `BULK_CAP` from `@/lib/members-bulk-constants`).
  - `useTranslations('admin.broadcasts.queue.bulk')`.
  - ResizeObserver spacer: `barRef` + `barHeight` state + the `:138-158` effect verbatim (round up; `offsetHeight` fallback). Spacer `<div data-testid="queue-bulk-spacer" style={{ height: barHeight }} aria-hidden="true" />` after the fixed bar.
  - Bar: `<div ref={barRef} className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm shadow-lg" role="toolbar" aria-label={t('toolbarLabel')}>` containing `<span className="text-sm font-medium" aria-live="polite">{t('selectedCount', { count: selectedIds.length })}</span>`, the over-cap alert block (`overCap && <div role="alert">{t('overCap',{max:BULK_CAP})}<…>{t('overCapHelper',{count:selectedIds.length,max:BULK_CAP})}</…></div>`), a Clear button (`onClick={onClear}`), and an "Approve selected" button (`whitespace-nowrap`) that runs `handleBulkApprove(cappedIds)`.
  - Move `handleBulkApprove` + `BULK_CHUNK = 5` here from the client, verbatim (still `{decision:'send_now'}`; keep the chunked `Promise.allSettled`, per-row outcome classification, toast, `router.refresh()`, and the "failed rows stay selected" behaviour — but selection now lives in the wrapper, so instead of mutating `rowSelection`, call `onClear()` on full success and surface failed ids via a toast/return for the wrapper to re-select in Task 6; for THIS task, on partial failure keep the bar mounted and toast the failed count). Reuse `useDialogFinalFocus` exactly as the members bar does if the approve opens a confirm — in PR2 it does NOT (no confirm until PR3), so a plain button is fine; do NOT add a confirm dialog here.
  - Optionally render `BulkProgressIndicator` (namespace `admin.broadcasts.queue.bulk`) while the fan-out is in flight.

- [ ] **Step 4: Run tests** → PASS. `pnpm typecheck` + `pnpm lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/broadcast/admin/queue-bulk-action-bar.tsx tests/unit/broadcast/queue-bulk-action-bar.test.tsx
git commit -m "feat(broadcasts): fixed-bottom role=toolbar bulk bar with spacer + BULK_CAP"
```

---

### Task 6: `QueueWithBulk` wrapper + rewire the client + RSC

**Files:**
- Create: `src/components/broadcast/admin/queue-with-bulk.tsx`
- Modify: `src/components/broadcast/admin/queue-table-client.tsx` (accept `enableSelection`, `onSelectionChange`, `clearSelectionNonce`; REMOVE the internal sticky-top `role="region"` bar + `handleBulkApprove` (moved to Task 5); keep the permanent `role="status"` announcer)
- Modify: `src/components/broadcast/admin/queue-table.tsx` (render `<QueueWithBulk>`)
- Test: `tests/unit/broadcast/queue-with-bulk.test.tsx`

**Interfaces:**
- `QueueTableClient` new props: `enableSelection?: boolean`, `onSelectionChange?: (ids: string[]) => void`, `clearSelectionNonce?: number`. It keeps its own uncontrolled `rowSelection`, calls `onSelectionChange(selectedIds)` in an effect when selection changes, and resets `setRowSelection({})` in an effect keyed on `clearSelectionNonce`.
- `QueueWithBulk` props: same enriched `rows` + `readOnly` + `columnLabels` the client took. Owns `const [selectedIds, setSelectedIds] = useState<string[]>([])` + `const [clearNonce, setClearNonce] = useState(0)`; renders `<QueueTableClient … enableSelection={!readOnly} onSelectionChange={setSelectedIds} clearSelectionNonce={clearNonce} />` + `<QueueBulkActionBar selectedIds={selectedIds} readOnly={readOnly} onClear={() => { setSelectedIds([]); setClearNonce((n) => n + 1); }} />`.

- [ ] **Step 1: Write the failing test** — selection lifts to the bar; Clear resets:

```tsx
it('lifts selection to the toolbar and clears both on Clear', async () => {
  const user = userEvent.setup();
  render(<Provider><QueueWithBulk rows={[makeRow({broadcastId:'b1'}), makeRow({broadcastId:'b2'})]} readOnly={false} columnLabels={LABELS} /></Provider>);
  const rowChecks = within(screen.getByRole('table').querySelector('tbody')!).getAllByRole('checkbox');
  await user.click(rowChecks[0]);
  const bar = await screen.findByRole('toolbar');
  expect(within(bar).getByText('1 selected')).toBeInTheDocument();
  await user.click(within(bar).getByRole('button', { name: /clear/i }));
  expect(screen.queryByRole('toolbar')).toBeNull();          // selection cleared → bar unmounts
});
```

- [ ] **Step 2: Run to verify it fails**: `pnpm vitest run tests/unit/broadcast/queue-with-bulk.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Add the lift props to `queue-table-client.tsx`.** Keep `rowSelection` local. Add:
```tsx
useEffect(() => { onSelectionChange?.(table.getSelectedRowModel().rows.map((r) => r.original.broadcastId)); }, [rowSelection, onSelectionChange, table]);
useEffect(() => { if (clearSelectionNonce !== undefined) setRowSelection({}); }, [clearSelectionNonce]);
```
REMOVE the internal sticky-top `role="region"` bar (445-474) and `handleBulkApprove`/`BULK_CHUNK` (285-394, now in Task 5's bar). KEEP the permanent `role="status"` announcer (it still reflects local selection — good for SR parity while ticking rows). Gate the `select` column + announcer on `enableSelection ?? !readOnly`.

- [ ] **Step 4: Create `queue-with-bulk.tsx`** (`'use client'`) per the Interfaces block above.

- [ ] **Step 5: Rewire the RSC** — in `queue-table.tsx`, replace `<QueueTableClient rows={enrichedRows} readOnly={readOnly} columnLabels={…} />` with `<QueueWithBulk rows={enrichedRows} readOnly={readOnly} columnLabels={…} />` (same props). No server-only imports leak into the wrapper (it's `'use client'`).

- [ ] **Step 6: Run tests** — `pnpm vitest run tests/unit/broadcast/queue-with-bulk.test.tsx tests/unit/broadcast/queue-table-client-a11y.test.tsx tests/unit/broadcast/queue-bulk-action-bar.test.tsx` → all PASS. Update `queue-table-client-a11y.test.tsx` if it asserted the old `role="region"` bar (retarget to the wrapper's `role="toolbar"` or move that assertion to `queue-with-bulk.test.tsx`). `pnpm typecheck` + `pnpm lint` + `pnpm vitest run tests/unit/architecture/broadcasts-barrel.test.ts` (the deep-import guard — the new components live under `src/components/broadcast/admin/**`, allowed) clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/broadcast/admin/queue-with-bulk.tsx src/components/broadcast/admin/queue-table-client.tsx src/components/broadcast/admin/queue-table.tsx tests/unit/broadcast/queue-with-bulk.test.tsx tests/unit/broadcast/queue-table-client-a11y.test.tsx
git commit -m "refactor(broadcasts): lift selection into QueueWithBulk wrapper, drop sticky-top bar"
```

---

### Task 7: WS-G — group status filter chips, keep Reset adjacent

**Files:**
- Modify: `src/components/broadcast/admin/queue-filters.tsx` (chip strip 233-255; Reset 317-328)
- Test: `tests/unit/broadcast/queue-filters-grouping.test.tsx`

**Interfaces:**
- Consumes: `BROADCAST_STATUSES` from `src/modules/broadcasts/domain/value-objects/broadcast-status.ts` (order: `draft, submitted, approved, sending, sent, rejected, cancelled, failed_to_dispatch, partially_sent, partial_delivery_accepted`).
- Produces: two visually-grouped chip clusters — **in-review** (`submitted, approved, sending, draft`) and **terminal** (`sent, rejected, cancelled, failed_to_dispatch, partially_sent, partial_delivery_accepted`) — with the Reset control adjacent to the strip, not shoved to the far edge by `ml-auto`.

- [ ] **Step 1: Write the failing test**:

```tsx
it('groups status chips into in-review and terminal clusters with Reset adjacent', () => {
  render(<Provider><QueueFilters {...baseProps} /></Provider>);
  const groups = screen.getAllByRole('group', { name: /in review|completed|terminal/i });
  expect(groups.length).toBeGreaterThanOrEqual(2);
  // Reset sits within the filter strip, not floated to the row's far right
  const reset = screen.getByRole('button', { name: /reset/i });
  expect(reset.className).not.toMatch(/\bml-auto\b/);
});
```

- [ ] **Step 2: Run to verify it fails**: `pnpm vitest run tests/unit/broadcast/queue-filters-grouping.test.tsx` → FAIL.

- [ ] **Step 3: Implement grouping.** In the status `fieldset`, split `BROADCAST_STATUSES` into `IN_REVIEW = ['submitted','approved','sending','draft']` and `TERMINAL = [...rest]` (derive `TERMINAL` by filtering, so a new status can't silently vanish). Render two `<div role="group" aria-label={t('statusGroup.inReview')}>` / `aria-label={t('statusGroup.terminal')}` clusters inside the existing `flex flex-wrap gap-2`, each mapping its subset through the SAME chip `<label>` markup (unchanged). Add the two `statusGroup.*` i18n keys to en/th/sv (fold into Task 1's set if implementing in order, or add here + re-run `check:i18n`). Move the Reset control so it is adjacent to the chip strip — drop `ml-auto` (keep `whitespace-nowrap`); if visual separation is still wanted, use a `gap`/spacer, not `ml-auto` that pushes it to the row edge (the renewals month-lens lesson).

- [ ] **Step 4: Run tests** → PASS. `pnpm check:i18n` (if keys added) → OK. `pnpm typecheck` + `pnpm lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/broadcast/admin/queue-filters.tsx tests/unit/broadcast/queue-filters-grouping.test.tsx src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "feat(broadcasts): group status filter chips (in-review vs terminal), Reset adjacent"
```

---

### Task 8: M1 — recipient count in the approve dialog's `aria-describedby` (+ M3 optional)

**Files:**
- Modify: `src/components/broadcast/admin/approve-dialog.tsx` (211-216)
- Modify (optional M3): `src/components/broadcast/admin/sla-banner.tsx` (compact line)
- Test: `tests/unit/broadcast/approve-dialog-describedby.test.tsx`

**Interfaces:**
- Produces: on open, a screen reader announces the recipient count as part of the dialog's accessible description.

- [ ] **Step 1: Write the failing test**:

```tsx
it('includes the recipient count in the dialog accessible description', () => {
  render(<Provider><ApproveDialog broadcastId="b1" open onOpenChange={() => {}} recipientCount={12} /></Provider>);
  const dialog = screen.getByRole('alertdialog');
  const describedById = dialog.getAttribute('aria-describedby');
  expect(describedById).toBeTruthy();
  const described = describedById!.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  expect(described).toMatch(/Reaches ~12 recipients/);
});
```

- [ ] **Step 2: Run to verify it fails**: `pnpm vitest run tests/unit/broadcast/approve-dialog-describedby.test.tsx` → FAIL (recipient `<p>` is a sibling, not in `aria-describedby`).

- [ ] **Step 3: Fold the recipient line into the described content.** Preferred minimal fix: render the recipient sentence as a second paragraph INSIDE `AlertDialogDescription` (Radix wires `aria-describedby` to that element), e.g.:
```tsx
<AlertDialogDescription>
  {t('description')}
  {recipientCount !== undefined ? (
    <span className="mt-2 block text-muted-foreground">{t('recipientCount', { count: recipientCount })}</span>
  ) : null}
</AlertDialogDescription>
```
(Use a `block` `<span>` — an inner `<p>` inside the description `<p>` is invalid HTML.) Delete the old sibling `<p>` (212-216). Keep the visual appearance identical.

- [ ] **Step 4 (optional M3): compact-SLA "—h" guard.** In `sla-banner.tsx`, when `compact` and `decisionCount === 0`, suppress the "Half decided within —h · 95% within —h" line (render nothing, or the dash-only fallback) so an all-`submitted` tenant with no decisions doesn't read "within —h". Add a component test for the `decisionCount === 0` compact case. (If time-boxed, defer with a `// TODO(PR3)` — but it is a one-branch guard; prefer to include.)

- [ ] **Step 5: Run tests** — `pnpm vitest run tests/unit/broadcast/approve-dialog-describedby.test.tsx tests/unit/broadcast/approve-dialog-recipient.test.tsx tests/unit/broadcast/sla-banner.test.tsx` → PASS (the PR1 `approve-dialog-recipient` test still green — the count text still renders). `pnpm typecheck` + `pnpm lint` clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/broadcast/admin/approve-dialog.tsx src/components/broadcast/admin/sla-banner.tsx tests/unit/broadcast/approve-dialog-describedby.test.tsx tests/unit/broadcast/sla-banner.test.tsx
git commit -m "fix(broadcasts): announce recipient count in approve-dialog description (a11y M1)"
```

---

### Task 9: E2E — full a11y sweep (desktop + mobile 360px + toolbar)

**Files:**
- Modify: `tests/e2e/admin-review-queue.spec.ts` (extend the decoupled `@a11y` describe from PR1)

**Interfaces:** none (test-only).

- [ ] **Step 1: Add assertions** to the independent (`mode:'default'`) `@a11y` describe added in PR1:
  - **Desktop table**: `/admin/broadcasts` renders a `[data-slot="table"]`; axe scan → 0 violations (already present — keep).
  - **Mobile card at 360px**: `await page.setViewportSize({ width: 360, height: 800 })`, reload, assert `[data-testid="queue-card-list"]` is visible and the desktop `[data-slot="table"]` is `hidden` (CSS `md:hidden`/`hidden md:block` — assert via `toBeHidden()`/`toBeVisible()`), then axe scan → 0 violations.
  - **Fixed-bottom toolbar**: with a `submitted` seed row (guard with `test.skip(!SEEDED_SUBMITTED_BROADCAST_ID, 'reason')`), tick its checkbox, assert `getByRole('toolbar')` is visible, its `aria-live` count reads "1 selected", and keyboard: `Tab` reaches the Clear/Approve buttons in DOM order (plain tab order, no roving-tabindex). Axe scan with the toolbar present → 0 violations.
  - Keep the negative invariant (no raw-enum leak) + `@i18n` EN/TH/SV (unchanged from PR1).

- [ ] **Step 2: Run against the worktree dev server** (once it's restarted — PR1 left it env-degraded): `E2E_BASE_URL=http://localhost:3101 pnpm test:e2e tests/e2e/admin-review-queue.spec.ts --grep "@a11y|@i18n" --project=chromium --workers=1`. Report pass/skip/fail honestly. If the server is still degraded, report DONE_WITH_CONCERNS: spec updated + `check:fixme`/typecheck/lint green but not executed.

- [ ] **Step 3: Gates** — `pnpm typecheck` · `pnpm lint` · `pnpm check:fixme` (no `test.fixme`/bare `.skip`) → PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/admin-review-queue.spec.ts
git commit -m "test(broadcasts): e2e a11y sweep — desktop table + mobile card 360px + toolbar"
```

---

## Final gates (before PR)

```bash
pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm check:layout && pnpm vitest run tests/unit/broadcast/ tests/unit/architecture/broadcasts-barrel.test.ts
```
All must pass. UI PR → an `enterprise-ux-designer` pass (desktop + mobile 360px + toolbar keyboard/SR + token AA both themes). No security review (no send/RBAC/endpoint change; bulk-approve still `{decision:'send_now'}` — the confirm/schedule/Undo is PR3).

## Self-review notes (PR2 spec coverage)

- WS-D drop virtualization → Task 2; shared `<Table>` → Task 3; mobile card → Task 4; fixed-bottom `role=toolbar` extract + `BULK_CAP` → Tasks 5–6.
- WS-G filter chip grouping → Task 7.
- PR1 Minors: M1 (aria-describedby) → Task 8; M2 (`role=region`→`toolbar`) → subsumed by Tasks 5–6 (the old sticky-top `role="region"` bar is deleted, replaced by the fixed-bottom `role="toolbar"`); M3 (compact-SLA "—h") → Task 8 optional.
- i18n new keys → Task 1 (+ Task 7 group labels).
- Deferred (NOT PR2): send-path confirm + bulk schedule + Undo toast (PR3); pagination Next/Prev UI; terminal-chip collapse decision.
