# E-Blast Review-Queue UX — PR3 Implementation Plan (send-path confirmation ⚠️)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a recipient-total confirmation + send-now/schedule choice in front of the irreversible bulk-approve, and give both bulk and single send-now a 60-second Undo — so an admin can never send an E-Blast to the wrong audience by one stray click.

**Architecture:** Client-only behaviour layer on top of the UNCHANGED approve + cancel endpoints. The bulk "Approve selected" button now opens a `BulkApproveConfirmDialog` (recipient total + send-now/schedule radio + Bangkok-TZ schedule field via the shared `bangkok-datetime.ts` helper); on confirm, the existing chunked fan-out posts the chosen per-row decision (`{decision:'send_now'}` or `{decision:'schedule', scheduledFor}`). After any send-now approve (bulk or single), a shared "Sending in 60 s — Undo" toast fans out `POST /cancel` per approved id. Partial failures now keep exactly the failed rows selected (controlled re-select) so retry re-opens the dialog and re-validates the min-lead.

**Tech Stack:** Next.js 16 `'use client'`, React 19, `@tanstack/react-table@^8`, shadcn `AlertDialog` + `RadioGroup`, `@js-joda/core`+`timezone` (Asia/Bangkok, via the shared helper), `sonner@^1.7.4` (`toast` with `action`+`duration`), next-intl (EN/TH/SV ICU), Vitest + `@testing-library/react` + `NextIntlClientProvider`, Playwright + axe-core.

## Global Constraints

- **DO NOT change any server endpoint, schema, RBAC, or the DB.** This is a client-only feature. The approve endpoint (`POST /api/admin/broadcasts/[id]/approve`) and cancel endpoint (`POST /api/admin/broadcasts/[id]/cancel`) are UNCHANGED. Their contract tests (`tests/contract/broadcasts/post-admin-broadcasts-approve.contract.test.ts`, `…-cancel.contract.test.ts`) MUST stay green and MUST NOT be edited.
- **The approve endpoint's request body is EXACTLY** `{decision:'send_now'}` or `{decision:'schedule', scheduledFor:<ISO-8601 with offset>}` (zod `discriminatedUnion` on `decision`; `scheduledFor` = `z.string().datetime({offset:true}).refine(> now+5min)`). The field is **`scheduledFor`**, the value is a full ISO instant from `bangkokInputToIso(...)`. There is NO recipient/audience field — the displayed recipient total is **DISPLAY-ONLY and MUST NEVER appear in any request body** (tamper-safety; the server resolves the real recipient set at dispatch).
- **The cancel endpoint requires a non-empty reason**: `{cancellationReason: z.string().min(1).max(500)}` (the ADMIN path — `src/app/api/admin/broadcasts/[id]/cancel/route.ts`). The Undo click has no reason UI, so it MUST send a canned non-empty i18n string, or the request 400s.
- **Cancel is valid only while status is `submitted`/`approved`** (or `sending` with pending batches). Once the cron dispatches (≤ 60 s), cancel returns **409 `broadcast_cancel_too_late`** (`details.observedStatus`) — that is the "too late to undo" race, classify it distinctly, never surface it as a hard error.
- **Reuse, don't re-copy, the Bangkok-TZ logic**: use the shared `src/components/broadcast/bangkok-datetime.ts` helpers (`bangkokInputToIso(local): string|null`, `isoToBangkokInput(iso): string`, `bangkokMinInputAfterMinutes(min): string`). Do NOT copy `approve-dialog.tsx`'s inline duplicate, and do NOT modify that inline copy (leave the working single-approve schedule path alone except where Task 5 adds the Undo toast).
- **Keep the fan-out shape**: chunked `Promise.allSettled` over `cappedIds`, `BULK_CHUNK=5`, `credentials:'same-origin'`, `router.refresh()` after; per-row outcome classification into `{id, ok}` / `{id, ok:false, status, code}`.
- **Focus management**: the confirm dialog (whose trigger — the "Approve selected" button — unmounts when the bar clears on success) MUST wire `useDialogFinalFocus(triggerRef, fallbackFocusRef, closedViaSuccessRef)` → `#main-content`, mirroring `approve-dialog.tsx` (raise `closedViaSuccessRef.current = true` BEFORE the success/close path).
- **Semantic tokens only**; the send-now irreversible warning uses `text-destructive` (NOT `bg-destructive text-destructive-foreground` — if a filled destructive surface is ever used, add `dark:text-background`). TH: no faux-italic, classifier counts (no grammatical plural). `text-muted-foreground` stays the empty-`—` sentinel.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Conventional Commits. Never `git add -A` (stray `i18n_dump*.txt` at the worktree root — stage explicit paths only). Never `pnpm format`/prettier.
- **Gates before PR**: `pnpm lint` + `pnpm typecheck` (`NODE_OPTIONS=--max-old-space-size=8192`) + `pnpm check:i18n` + `pnpm check:layout` + `pnpm check:fixme` + `pnpm vitest run tests/unit/broadcast/ tests/unit/architecture/broadcasts-barrel.test.ts` + `pnpm vitest run tests/contract/broadcasts/`. **PR3 is the irreversible SEND path → ≥2 reviewers, one being `security-engineer`** (design § Risk classification) + the mandatory `enterprise-ux-designer` pass.

## Reference facts (read before implementing — from the PR3 recon)

- **Fan-out today** (`queue-bulk-action-bar.tsx:135-204`): `handleBulkApprove` posts hardcoded `{decision:'send_now'}` per `cappedIds`, classifies into `Outcome`, toasts `successAll`/`failureAll`/`partial`, calls `onPartialFailure(failedIds)` on partial. `QueueBulkActionBarProps` = `{selectedIds, onClear, readOnly, onPartialFailure?}` — NO recipient data (Task 2 adds it).
- **Approve success 200** body: `{broadcastId, status:'approved', approvedAt, scheduledFor, resendBroadcastId:null}`. **Approve errors**: 400 `invalid_body` (incl too-soon `scheduledFor`), 403 `forbidden` (manager), 404 `broadcast_not_found`, 409 `broadcast_invalid_state_transition`|`broadcast_concurrent_action_blocked` (`details.observedStatus`), 422 `broadcast_schedule_too_soon`, 500. Error body: `{error:{code, message, messageThai, details?}, correlationId}`.
- **Cancel success 200**: `{broadcastId, status:'cancelled', cancelledAt, reservationReleased:true}`. **Cancel errors**: 400 `invalid_body`, 403, 404 `broadcast_not_found`, 409 `broadcast_cancel_too_late`|`broadcast_concurrent_action_blocked`, 500. Same error-body shape.
- **`EnrichedQueueRow`** (`queue-table-client.tsx:84-105`): has `broadcastId: string` + `recipientCount: number` (plain).
- **`useDialogFinalFocus`** — `src/components/broadcast/reason-confirmation-dialog.tsx:76-94`, signature `(triggerRef?, fallbackFocusRef?, closedViaSuccessRef?) => () => HTMLElement|null`; pass its result to `<AlertDialogContent finalFocus={…}>`.
- **Undo toast precedent** — members `bulk-action-bar.tsx:314-336`: `toast.success(msg, { duration, action: { label, onClick } })` (sonner 1.7.4). Members uses 10 s; PR3 uses **60 s**.
- **Shared cap**: `BULK_CAP` (100) from `@/lib/members-bulk-constants` (already imported by the bar).
- **Test mock idiom** (`queue-bulk-action-bar.test.tsx`): `vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: routerRefresh }) }))`, `vi.mock('sonner', …)`, `vi.stubGlobal('fetch', …)`, `vi.stubGlobal('ResizeObserver', …)`, real `NextIntlClientProvider` + `enMessages`, `PointerEvent` polyfill, `vi.useRealTimers()`.

---

## File structure (created / modified)

- **Create** `src/components/broadcast/admin/bulk-approve-confirm-dialog.tsx` — the confirm dialog (recipient total + send-now/schedule radio + Bangkok schedule field + irreversible/over-cap warning + `finalFocus`).
- **Create** `src/components/broadcast/admin/send-now-undo.ts` — shared `cancelApprovedBroadcasts(ids, reason)` fan-out for the Undo toast.
- **Modify** `src/components/broadcast/admin/queue-bulk-action-bar.tsx` — add recipient-rows prop; "Approve selected" opens the confirm dialog; parameterize the fan-out per-row decision; show the send-now Undo toast; pass real `failedIds` up.
- **Modify** `src/components/broadcast/admin/queue-with-bulk.tsx` — thread `rows` to the bar; wire controlled re-select on partial failure (failed-rows-stay).
- **Modify** `src/components/broadcast/admin/queue-table-client.tsx` — add `reselectIds?`/`reselectNonce?` props + an effect that re-applies `rowSelection` to those ids.
- **Modify** `src/components/broadcast/admin/approve-dialog.tsx` — on single send-now success, show the shared Undo toast.
- **Modify** `src/i18n/messages/{en,th,sv}.json` — new `admin.broadcasts.queue.bulk.confirm.*` + `.undo.*` + `.progress.*` keys.
- **Tests**: `tests/unit/broadcast/bulk-approve-confirm-dialog.test.tsx`, `send-now-undo.test.ts`, extend `queue-bulk-action-bar.test.tsx` + `queue-with-bulk.test.tsx` + `approve-dialog-*.test.tsx`; extend `tests/e2e/admin-review-queue.spec.ts`.

---

### Task 1: i18n keys (confirm dialog + Undo + progress)

**Files:** Modify `src/i18n/messages/{en,th,sv}.json` under `admin.broadcasts.queue.bulk`.

**Interfaces:** Produces the keys consumed by Tasks 3–7. Nest a `confirm`, `undo`, and `progress` object under the existing `bulk` object (do NOT create a second `bulk`).

- [ ] **Step 1: Add to `en.json`** (canonical) inside `admin.broadcasts.queue.bulk`:

```json
"confirm": {
  "title": "Approve {count, plural, one {# broadcast} other {# broadcasts}}?",
  "recipientTotal": "Reaches ~{recipients, plural, one {# recipient} other {# recipients}} across {count, plural, one {# broadcast} other {# broadcasts}}.",
  "overCapNote": "Only the first {max} of {selected} selected will be approved.",
  "decisionLabel": "When to send",
  "sendNow": "Send now",
  "schedule": "Schedule",
  "sendNowWarning": "Emails send immediately and cannot be recalled.",
  "scheduleLabel": "Send at",
  "scheduleHelp": "At least 5 minutes from now. Time zone: Asia/Bangkok.",
  "schedulePreviewLabel": "Will be sent on:",
  "confirmSendNow": "Approve & send now",
  "confirmSchedule": "Approve & schedule",
  "cancel": "Cancel"
},
"undo": {
  "sendingSendNow": "Sending {count, plural, one {# broadcast} other {# broadcasts}} in 60s.",
  "action": "Undo",
  "reason": "Undone by admin from the review queue",
  "success": "Cancelled {count, plural, one {# broadcast} other {# broadcasts}}.",
  "tooLate": "Already sending — too late to undo {count, plural, one {# broadcast} other {# broadcasts}}.",
  "failed": "Couldn't undo {count, plural, one {# broadcast} other {# broadcasts}} — still approved."
},
"progress": {
  "label": "Approving…",
  "message": "Approving {done} of {total}…"
}
```

- [ ] **Step 2: Mirror into `th.json`** (classifier counts, no grammatical plural, no faux-italic):

```json
"confirm": {
  "title": "อนุมัติบรอดแคสต์ {count} รายการ?",
  "recipientTotal": "ส่งถึงผู้รับประมาณ {recipients} คน จาก {count} รายการ",
  "overCapNote": "จะอนุมัติเฉพาะ {max} รายการแรกจากที่เลือก {selected} รายการเท่านั้น",
  "decisionLabel": "กำหนดเวลาส่ง",
  "sendNow": "ส่งทันที",
  "schedule": "ตั้งเวลา",
  "sendNowWarning": "อีเมลจะถูกส่งทันทีและไม่สามารถเรียกคืนได้",
  "scheduleLabel": "ส่งเมื่อ",
  "scheduleHelp": "อย่างน้อย 5 นาทีจากนี้ เขตเวลา: Asia/Bangkok",
  "schedulePreviewLabel": "จะถูกส่งเมื่อ:",
  "confirmSendNow": "อนุมัติและส่งทันที",
  "confirmSchedule": "อนุมัติและตั้งเวลา",
  "cancel": "ยกเลิก"
},
"undo": {
  "sendingSendNow": "กำลังส่ง {count} รายการใน 60 วินาที",
  "action": "เลิกทำ",
  "reason": "เลิกทำโดยผู้ดูแลจากคิวตรวจสอบ",
  "success": "ยกเลิกแล้ว {count} รายการ",
  "tooLate": "กำลังส่งอยู่ — เลิกทำไม่ทัน {count} รายการ",
  "failed": "เลิกทำไม่สำเร็จ {count} รายการ — ยังอนุมัติอยู่"
},
"progress": {
  "label": "กำลังอนุมัติ…",
  "message": "อนุมัติแล้ว {done} จาก {total}…"
}
```

- [ ] **Step 3: Mirror into `sv.json`** (SV plural where the string counts):

```json
"confirm": {
  "title": "Godkänn {count, plural, one {# utskick} other {# utskick}}?",
  "recipientTotal": "Når ~{recipients, plural, one {# mottagare} other {# mottagare}} över {count, plural, one {# utskick} other {# utskick}}.",
  "overCapNote": "Endast de första {max} av {selected} valda godkänns.",
  "decisionLabel": "När ska det skickas",
  "sendNow": "Skicka nu",
  "schedule": "Schemalägg",
  "sendNowWarning": "E-post skickas omedelbart och kan inte återkallas.",
  "scheduleLabel": "Skicka",
  "scheduleHelp": "Minst 5 minuter från nu. Tidszon: Asia/Bangkok.",
  "schedulePreviewLabel": "Skickas den:",
  "confirmSendNow": "Godkänn & skicka nu",
  "confirmSchedule": "Godkänn & schemalägg",
  "cancel": "Avbryt"
},
"undo": {
  "sendingSendNow": "Skickar {count, plural, one {# utskick} other {# utskick}} om 60 s.",
  "action": "Ångra",
  "reason": "Ångrat av administratör från granskningskön",
  "success": "Avbröt {count, plural, one {# utskick} other {# utskick}}.",
  "tooLate": "Skickar redan — för sent att ångra {count, plural, one {# utskick} other {# utskick}}.",
  "failed": "Kunde inte ångra {count, plural, one {# utskick} other {# utskick}} — fortfarande godkända."
},
"progress": {
  "label": "Godkänner…",
  "message": "Godkände {done} av {total}…"
}
```

- [ ] **Step 4: Verify** — `pnpm check:i18n` → `[check:i18n] OK`. (TH deliberately omits ICU `plural` and uses a classifier count — that is house style, not a parity error; `check:i18n` checks key presence, not ICU shape.)

- [ ] **Step 5: Commit** — stage only the 3 message files; `feat(broadcasts): i18n keys for bulk-approve confirm dialog + send-now Undo`.

---

### Task 2: Thread recipient data to the bulk bar

**Files:** Modify `queue-bulk-action-bar.tsx` (props) + `queue-with-bulk.tsx` (pass it). Test: `tests/unit/broadcast/queue-bulk-action-bar.test.tsx`.

**Interfaces:**
- Consumes: `EnrichedQueueRow` (`recipientCount: number`).
- Produces: `QueueBulkActionBarProps` gains `readonly recipientByIdRows: ReadonlyArray<{ readonly broadcastId: string; readonly recipientCount: number }>;`. The bar derives `totalRecipients` = sum of `recipientCount` over the **capped** actioned ids.

- [ ] **Step 1: Write the failing test** — the bar exposes the recipient sum to its confirm (assert via the confirm dialog in Task 4; here just assert the prop is accepted + summed). Add to `queue-bulk-action-bar.test.tsx`:

```tsx
it('sums recipientCount over the capped selection', () => {
  render(<Provider><QueueBulkActionBar
    selectedIds={['b1','b2']} readOnly={false} onClear={vi.fn()}
    recipientByIdRows={[{broadcastId:'b1',recipientCount:10},{broadcastId:'b2',recipientCount:5}]}
  /></Provider>);
  // the total is surfaced when the confirm opens (Task 4) — for now assert the prop typechecks + the bar still renders the toolbar
  expect(screen.getByRole('toolbar')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**: `pnpm vitest run tests/unit/broadcast/queue-bulk-action-bar.test.tsx` → FAIL (unknown prop `recipientByIdRows`).

- [ ] **Step 3: Add the prop + derive the sum.** In `queue-bulk-action-bar.tsx`: add `recipientByIdRows` to `QueueBulkActionBarProps`; build `const recipientById = new Map(recipientByIdRows.map(r => [r.broadcastId, r.recipientCount]));` and `const totalRecipients = cappedIds.reduce((sum, id) => sum + (recipientById.get(id) ?? 0), 0);`. (Sum over `cappedIds`, not raw `selectedIds` — the total must match what will actually be actioned.)

- [ ] **Step 4: Wire from the wrapper.** In `queue-with-bulk.tsx`, pass `recipientByIdRows={rows.map(r => ({ broadcastId: r.broadcastId, recipientCount: r.recipientCount }))}` to `<QueueBulkActionBar>`. (`rows` is already in scope as a prop.)

- [ ] **Step 5: Run + gates** → PASS; `pnpm typecheck` + `pnpm lint` clean. Commit `feat(broadcasts): thread per-row recipient counts into the bulk bar` (stage the 2 components + the test).

---

### Task 3: `BulkApproveConfirmDialog` component

**Files:** Create `src/components/broadcast/admin/bulk-approve-confirm-dialog.tsx`. Test: `tests/unit/broadcast/bulk-approve-confirm-dialog.test.tsx`.

**Interfaces:**
- Produces:
```ts
export type BulkApproveDecision =
  | { readonly type: 'send_now' }
  | { readonly type: 'schedule'; readonly scheduledFor: string };  // ISO-8601 instant

export interface BulkApproveConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly broadcastCount: number;      // capped count actually actioned (min(selected, BULK_CAP))
  readonly selectedCount: number;       // raw selection (for the over-cap note)
  readonly cap: number;                 // BULK_CAP
  readonly totalRecipients: number;
  readonly onConfirm: (decision: BulkApproveDecision) => void;
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null>;
}
```
- Consumes: `bangkokInputToIso`, `bangkokMinInputAfterMinutes` from `@/components/broadcast/bangkok-datetime`; `useDialogFinalFocus` from `@/components/broadcast/reason-confirmation-dialog`; shadcn `AlertDialog*` + `RadioGroup`.

- [ ] **Step 1: Write the failing tests**:

```tsx
// render under NextIntlClientProvider + enMessages
it('shows the recipient total and broadcast count', () => {
  renderDialog({ broadcastCount: 3, selectedCount: 3, totalRecipients: 42 });
  expect(screen.getByText(/Reaches ~42 recipients across 3 broadcasts/)).toBeInTheDocument();
});
it('warns the send is irreversible in send-now mode (default)', () => {
  renderDialog({});
  expect(screen.getByText(/send immediately and cannot be recalled/)).toBeInTheDocument();
});
it('shows the over-cap note when selectedCount > cap', () => {
  renderDialog({ broadcastCount: 100, selectedCount: 120, cap: 100 });
  expect(screen.getByText(/Only the first 100 of 120 selected will be approved/)).toBeInTheDocument();
});
it('confirms send-now with {type:"send_now"}', async () => {
  const onConfirm = vi.fn();
  renderDialog({ onConfirm });
  await userEvent.click(screen.getByRole('button', { name: /Approve & send now/ }));
  expect(onConfirm).toHaveBeenCalledWith({ type: 'send_now' });
});
it('disables confirm until a valid (>5min) schedule time is entered', async () => {
  const onConfirm = vi.fn();
  renderDialog({ onConfirm });
  await userEvent.click(screen.getByRole('radio', { name: /Schedule/ }));
  const confirm = screen.getByRole('button', { name: /Approve & schedule/ });
  expect(confirm).toBeDisabled();                       // empty schedule
  // a far-future Bangkok wall-time enables it and confirms with an ISO scheduledFor
  const input = screen.getByLabelText(/Send at/);
  fireEvent.change(input, { target: { value: '2099-01-01T09:00' } });
  expect(confirm).toBeEnabled();
  await userEvent.click(confirm);
  expect(onConfirm).toHaveBeenCalledWith({ type: 'schedule', scheduledFor: expect.stringMatching(/^2099-01-01T02:00:00\.000Z$/) });
});
```
(`2099-01-01T09:00` Bangkok = `02:00Z` — verifies the shared helper's TZ conversion is used, not the browser TZ.)

- [ ] **Step 2: Run to verify it fails**: `pnpm vitest run tests/unit/broadcast/bulk-approve-confirm-dialog.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Implement the component.** Mirror `approve-dialog.tsx`'s AlertDialog + RadioGroup structure. Skeleton:

```tsx
'use client';
import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { bangkokInputToIso, bangkokMinInputAfterMinutes } from '@/components/broadcast/bangkok-datetime';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';

const MIN_LEAD_MS = 5 * 60 * 1000;

export function BulkApproveConfirmDialog(props: BulkApproveConfirmDialogProps): React.JSX.Element {
  const t = useTranslations('admin.broadcasts.queue.bulk.confirm');
  const [decision, setDecision] = useState<'send_now' | 'schedule'>('send_now');
  const [scheduledInput, setScheduledInput] = useState('');
  const minInput = useMemo(() => bangkokMinInputAfterMinutes(6), [props.open]);
  const scheduledIso = decision === 'schedule' ? bangkokInputToIso(scheduledInput) : null;
  const scheduleValid = decision === 'send_now'
    || (scheduledIso !== null && Date.parse(scheduledIso) > Date.now() + MIN_LEAD_MS);
  const closedViaSuccessRef = useRef(false);
  const finalFocus = useDialogFinalFocus(props.triggerRef, undefined, closedViaSuccessRef);

  const handleConfirm = () => {
    if (!scheduleValid) return;
    closedViaSuccessRef.current = true;
    props.onConfirm(decision === 'send_now' ? { type: 'send_now' } : { type: 'schedule', scheduledFor: scheduledIso! });
    props.onOpenChange(false);
  };

  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title', { count: props.broadcastCount })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('recipientTotal', { recipients: props.totalRecipients, count: props.broadcastCount })}
            {props.selectedCount > props.cap ? (
              <span className="mt-2 block text-destructive">{t('overCapNote', { max: props.cap, selected: props.selectedCount })}</span>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <RadioGroup value={decision} onValueChange={(v) => setDecision(v as 'send_now' | 'schedule')} aria-label={t('decisionLabel')}>
          <div className="flex items-center gap-2"><RadioGroupItem value="send_now" id="bulk-send-now" /><Label htmlFor="bulk-send-now">{t('sendNow')}</Label></div>
          <div className="flex items-center gap-2"><RadioGroupItem value="schedule" id="bulk-schedule" /><Label htmlFor="bulk-schedule">{t('schedule')}</Label></div>
        </RadioGroup>

        {decision === 'send_now' ? (
          <p className="text-sm text-destructive">{t('sendNowWarning')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            <Label htmlFor="bulk-scheduled-for">{t('scheduleLabel')}</Label>
            <input id="bulk-scheduled-for" type="datetime-local" min={minInput}
              value={scheduledInput} onChange={(e) => setScheduledInput(e.target.value)}
              className="rounded-md border px-2 py-1 text-sm" />
            <p className="text-xs text-muted-foreground">{t('scheduleHelp')}</p>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={!scheduleValid}>
            {decision === 'send_now' ? t('confirmSendNow') : t('confirmSchedule')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```
(Confirm the exact `AlertDialogAction`/`AlertDialogCancel`/`RadioGroup` import paths + whether `AlertDialogContent` accepts `finalFocus` by reading `src/components/ui/alert-dialog.tsx` + `approve-dialog.tsx` first. Use `Label`'s real import path. If `AlertDialogAction` doesn't accept `disabled`, use a plain `<Button>` inside the footer instead, mirroring `approve-dialog.tsx`.)

- [ ] **Step 4: Run tests** → PASS. `pnpm typecheck` + `pnpm lint` clean.

- [ ] **Step 5: Commit** — `feat(broadcasts): bulk-approve confirm dialog (recipient total + send-now/schedule)` (stage the component + test).

---

### Task 4: Wire the confirm dialog into the bar + parameterize the fan-out

**Files:** Modify `queue-bulk-action-bar.tsx`. Test: `tests/unit/broadcast/queue-bulk-action-bar.test.tsx`.

**Interfaces:**
- Consumes: `BulkApproveConfirmDialog` + `BulkApproveDecision` (Task 3), `totalRecipients` (Task 2).
- Produces: the "Approve selected" button opens the dialog; `handleBulkApprove(decision: BulkApproveDecision)` posts the chosen per-row body.

- [ ] **Step 1: Write the failing tests** (the load-bearing tamper-safety + schedule-body tests):

```tsx
it('opens the confirm dialog instead of approving immediately', async () => {
  renderBar({ selectedIds: ['b1'] });
  await userEvent.click(screen.getByRole('button', { name: /Approve selected/ }));
  expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();                 // no POST before confirm
});
it('send-now confirm posts exactly {decision:"send_now"} — NO recipient/total field', async () => {
  fetchMock.mockResolvedValue(okResponse());
  renderBar({ selectedIds: ['b1'], recipientByIdRows: [{broadcastId:'b1',recipientCount:99}] });
  await userEvent.click(screen.getByRole('button', { name: /Approve selected/ }));
  await userEvent.click(await screen.findByRole('button', { name: /Approve & send now/ }));
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toEqual({ decision: 'send_now' });           // tamper-safety: no recipients/total
});
it('schedule confirm posts {decision:"schedule", scheduledFor:<ISO>}', async () => {
  fetchMock.mockResolvedValue(okResponse());
  renderBar({ selectedIds: ['b1'] });
  await userEvent.click(screen.getByRole('button', { name: /Approve selected/ }));
  await userEvent.click(screen.getByRole('radio', { name: /Schedule/ }));
  fireEvent.change(screen.getByLabelText(/Send at/), { target: { value: '2099-01-01T09:00' } });
  await userEvent.click(screen.getByRole('button', { name: /Approve & schedule/ }));
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toEqual({ decision: 'schedule', scheduledFor: '2099-01-01T02:00:00.000Z' });
});
```

- [ ] **Step 2: Run to verify it fails**: → FAIL (the button still fans out directly; no dialog).

- [ ] **Step 3: Implement.** In `queue-bulk-action-bar.tsx`: add `const [confirmOpen, setConfirmOpen] = useState(false)` + `const approveBtnRef = useRef<HTMLButtonElement|null>(null)`. Change the "Approve selected" button `onClick` to `() => setConfirmOpen(true)` (ref it). Parameterize `handleBulkApprove(decision: BulkApproveDecision)`: build the per-row body `const rowBody = decision.type === 'send_now' ? { decision: 'send_now' } : { decision: 'schedule', scheduledFor: decision.scheduledFor };` and post `JSON.stringify(rowBody)`. Render `<BulkApproveConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} broadcastCount={cappedIds.length} selectedCount={selectedIds.length} cap={BULK_CAP} totalRecipients={totalRecipients} onConfirm={(d) => handleBulkApprove(d)} triggerRef={approveBtnRef} />`. The fan-out body MUST contain ONLY `decision` (+ `scheduledFor` for schedule) — never `totalRecipients`/recipients.

- [ ] **Step 4: Run tests** → PASS (esp. the tamper-safety `toEqual({decision:'send_now'})`). Confirm the existing fan-out tests (success/partial/cap) still pass — they now go through the dialog, so update them to click through the confirm first (send-now). `pnpm typecheck` + `pnpm lint` clean.

- [ ] **Step 5: Commit** — `feat(broadcasts): gate bulk approve behind the confirm dialog + per-row schedule payload` (stage the bar + test).

---

### Task 5: Shared send-now Undo helper + wire bulk & single

**Files:** Create `src/components/broadcast/admin/send-now-undo.ts`. Modify `queue-bulk-action-bar.tsx` + `approve-dialog.tsx`. Tests: `tests/unit/broadcast/send-now-undo.test.ts` + extend the bar test + `approve-dialog` test.

**Interfaces:**
- Produces:
```ts
export interface UndoResult { readonly cancelled: number; readonly tooLate: number; readonly failed: number; }
/** Fan-out POST /cancel per approved id with a canned reason. Never throws. */
export async function cancelApprovedBroadcasts(ids: readonly string[], cancellationReason: string): Promise<UndoResult>;
```

- [ ] **Step 1: Write the failing tests** for the helper (`send-now-undo.test.ts`, `vi.stubGlobal('fetch', …)`):

```ts
it('classifies 200 as cancelled, 409 too_late as tooLate, others as failed', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status:'cancelled' }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error:{ code:'broadcast_cancel_too_late' } }), { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error:{ code:'internal_error' } }), { status: 500 }));
  vi.stubGlobal('fetch', fetchMock);
  const r = await cancelApprovedBroadcasts(['a','b','c'], 'reason');
  expect(r).toEqual({ cancelled: 1, tooLate: 1, failed: 1 });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/api/admin/broadcasts/a/cancel');
  expect(JSON.parse(init.body)).toEqual({ cancellationReason: 'reason' });   // non-empty reason REQUIRED
});
```

- [ ] **Step 2: Run to verify it fails**: → FAIL (module not found).

- [ ] **Step 3: Implement `send-now-undo.ts`.** Fan out `POST /api/admin/broadcasts/${id}/cancel` (`credentials:'same-origin'`, `Content-Type: application/json`, body `{ cancellationReason }`), chunked by 5, `Promise.allSettled`. Classify: `res.ok` → cancelled; else read `body.error.code` — `broadcast_cancel_too_late` → tooLate; anything else (incl network reject, other 409, 4xx/5xx) → failed. Return the tallies. NEVER throw.

- [ ] **Step 4: Wire into the bulk bar.** After the approve fan-out completes in `handleBulkApprove`, when `decision.type === 'send_now'` AND there is ≥1 succeeded id, capture `const approvedIds = outcomes.filter(o => o.ok).map(o => o.id);` and show the Undo toast (import `toast` from `sonner`, `tUndo = useTranslations('admin.broadcasts.queue.bulk.undo')`):

```ts
if (decision.type === 'send_now' && approvedIds.length > 0) {
  toast(tUndo('sendingSendNow', { count: approvedIds.length }), {
    duration: 60_000,
    action: { label: tUndo('action'), onClick: async () => {
      const r = await cancelApprovedBroadcasts(approvedIds, tUndo('reason'));
      if (r.cancelled > 0) toast.success(tUndo('success', { count: r.cancelled }));
      if (r.tooLate > 0) toast.warning(tUndo('tooLate', { count: r.tooLate }));
      if (r.failed > 0) toast.error(tUndo('failed', { count: r.failed }));
      router.refresh();
    } },
  });
}
```
(Show the Undo toast IN ADDITION to the existing `successAll`/`partial` toast — the Undo is the actionable one. Schedule decisions get NO Undo toast.) Add a bar test: after a send-now confirm with all-success, a toast with an "Undo" action is shown, and clicking it POSTs `/cancel` per approved id with the canned reason (mock `toast` to capture the `action.onClick`, invoke it, assert the cancel fetch).

- [ ] **Step 5: Wire into single-approve.** In `approve-dialog.tsx`, on the send-now success branch (`res.ok` AND the submitted `decision === 'send_now'`), show the same Undo toast for the single `broadcastId` (reuse `cancelApprovedBroadcasts([broadcastId], tUndo('reason'))`). Do NOT show it on the schedule success branch. Keep the existing `toast.success` + close + refresh; ADD the Undo toast. Add a test in the approve-dialog suite (mock fetch + sonner) that a single send-now success yields an Undo toast whose action cancels that id.

- [ ] **Step 6: Run tests + gates** → all PASS. `pnpm typecheck` + `pnpm lint` clean. Commit `feat(broadcasts): 60s send-now Undo toast (bulk + single) via the cancel path` (stage `send-now-undo.ts`, the bar, `approve-dialog.tsx`, the 3 tests).

---

### Task 6: Failed-rows-stay retry (controlled re-select)

**Files:** Modify `queue-table-client.tsx` (add reselect props) + `queue-with-bulk.tsx` (wire it). Test: `tests/unit/broadcast/queue-with-bulk.test.tsx`.

**Interfaces:**
- Produces: `QueueTableClientProps` gains `readonly reselectIds?: readonly string[];` + `readonly reselectNonce?: number;`. An effect keyed on `reselectNonce` sets `rowSelection` to exactly those ids, so the shared instance (desktop + card + toolbar count) all reflect the failed set.

- [ ] **Step 1: Write the failing test** — after a partial failure, ONLY the failed rows stay selected (toolbar count matches, no desync):

```tsx
it('keeps only the failed rows selected after a partial bulk failure', async () => {
  // stub fetch: b1 ok, b2 500. Select both, approve (send-now), confirm.
  // assert the toolbar now reads "1 selected" and only b2's checkbox is checked.
});
```
(Drive via the real `QueueWithBulk` + a stubbed `fetch`; scope checkbox queries to `within(screen.getByRole('table').querySelector('tbody'))`.)

- [ ] **Step 2: Run to verify it fails**: → FAIL (today the wrapper clears the whole selection on partial failure — `queue-with-bulk.tsx:82-84`).

- [ ] **Step 3: Implement.** In `queue-table-client.tsx`, add the two props and:
```tsx
useEffect(() => {
  if (reselectNonce === undefined) return;
  setRowSelection(Object.fromEntries((reselectIds ?? []).map((id) => [id, true])));
}, [reselectNonce]);   // eslint-disable-line react-hooks/exhaustive-deps — nonce-gated, intentional
```
In `queue-with-bulk.tsx`, replace `handlePartialFailure` so it drives the failed set into the client instead of clearing: `const [reselectIds, setReselectIds] = useState<string[]>([]); const [reselectNonce, setReselectNonce] = useState(0);` and `const handlePartialFailure = (failedIds: string[]) => { setSelectedIds(failedIds); setReselectIds(failedIds); setReselectNonce((n) => n + 1); };`. Pass `reselectIds`+`reselectNonce` to `<QueueTableClient>`. Because the client re-applies `rowSelection` to exactly `failedIds`, the `onSelectionChange` mirror re-fires and the toolbar count re-syncs — no desync (this is the correct fix the PR2 seam was left for).

- [ ] **Step 4: Retry re-validates the schedule** — confirm (no code needed, assert in the test) that after failed-rows-stay, clicking "Approve selected" again re-opens the confirm dialog fresh (new `BulkApproveConfirmDialog` mount → empty schedule input → the min-lead is re-validated against the current clock). Add an assertion that the re-opened dialog's schedule confirm is disabled until a fresh valid time is entered.

- [ ] **Step 5: Run tests + gates** → PASS. `pnpm typecheck` + `pnpm lint` clean. Commit `feat(broadcasts): keep only failed rows selected after a partial bulk failure` (stage client + wrapper + test).

---

### Task 7 (optional-preferred): in-flight `BulkProgressIndicator`

**Files:** Modify `queue-bulk-action-bar.tsx`. Test: extend the bar test.

- [ ] **Step 1: Write the failing test** — while the fan-out is executing, a `role="status"` progress region announces "Approving…". 
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Reuse `BulkProgressIndicator` from `src/app/(staff)/admin/members/_components/bulk-progress-indicator.tsx` with `namespace="admin.broadcasts.queue.bulk.progress"` (it accepts a `namespace` prop), rendered while `executing`, wired to `done`/`total` if the component supports it (read its signature — if it only takes `action`/`total`, pass `total={cappedIds.length}` and the label key). If the component's prop shape doesn't fit the `admin.broadcasts.queue.bulk.progress` keys added in Task 1, render a minimal inline `<div role="status" className="sr-only">{tProgress('label')}</div>` instead — do NOT invent new i18n keys beyond Task 1's `progress.label`/`progress.message`.
- [ ] **Step 4: Run → PASS.** `pnpm typecheck` + `pnpm lint` clean.
- [ ] **Step 5: Commit** — `feat(broadcasts): in-flight progress announcement during bulk approve`. **If the `BulkProgressIndicator` prop shape can't be reused cleanly, implement the minimal inline `role="status"` version — do NOT skip the task with a TODO.**

---

### Task 8: E2E — bulk-approve confirm + schedule + Undo + tamper-safety

**Files:** Modify `tests/e2e/admin-review-queue.spec.ts` (a new `@bulk` describe, `mode:'default'`, seed-gated).

- [ ] **Step 1: Add assertions** (sign in as admin, `/admin/broadcasts`; guard the whole describe with `test.skip(!SEEDED_TWO_SUBMITTED, 'needs ≥2 submitted broadcasts')`):
  - **Confirm gate**: select ≥2 submitted rows → click "Approve selected" → assert a `role="alertdialog"` appears showing the recipient total, and NO approve network request fired yet (`page.waitForRequest` must NOT match before confirm).
  - **Tamper-safety (network)**: on send-now confirm, capture the approve POST via `page.on('request')` / `page.waitForRequest` and assert `request.postDataJSON()` equals `{ decision: 'send_now' }` — NO recipient/total key. (This is the e2e mirror of the unit tamper test.)
  - **Schedule**: pick Schedule + a valid Bangkok time → confirm → assert the POST body is `{ decision:'schedule', scheduledFor: <ISO with Z> }`.
  - **Undo**: after a send-now confirm, assert a toast with an "Undo" action appears; clicking Undo fires `POST …/cancel` with a non-empty `cancellationReason`.
  - **@a11y**: axe scan of the open confirm dialog → 0 violations; keyboard: focus lands in the dialog on open and returns to `#main-content` (not `<body>`) after confirm.
- [ ] **Step 2: Run** `E2E_BASE_URL=http://localhost:3101 pnpm test:e2e tests/e2e/admin-review-queue.spec.ts --grep "@bulk|@a11y" --project=chromium --workers=1`. Report pass/skip(with reason)/fail honestly. If the dev server is degraded or no 2-submitted seed exists, report DONE_WITH_CONCERNS with the spec committed + static gates green + the exact blocker — do NOT loop.
- [ ] **Step 3: Gates** — `pnpm typecheck` · `pnpm lint` · `pnpm check:fixme` → PASS.
- [ ] **Step 4: Commit** — `test(broadcasts): e2e bulk-approve confirm + schedule + Undo + no-recipient-in-body`.

---

## Final gates (before PR)

```bash
pnpm lint && NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck && pnpm check:i18n && pnpm check:layout && pnpm check:fixme && pnpm vitest run tests/unit/broadcast/ tests/unit/architecture/broadcasts-barrel.test.ts && pnpm vitest run tests/contract/broadcasts/
```
All pass. **PR3 is the irreversible SEND path → ≥2 reviewers, one being `security-engineer`** (verify: recipient total never in a request body; schedule min-lead re-validated server-side; cancel reason non-empty; no endpoint/RBAC change; the Undo can't cancel a broadcast the admin couldn't otherwise cancel — same RBAC) + the mandatory `enterprise-ux-designer` pass (confirm-dialog copy, focus return, TH/SV, 60s toast UX, over-cap note).

## Self-review notes (PR3 spec coverage)

- WS-F bulk confirm dialog (recipient total + send-now/schedule) → Tasks 2, 3, 4. Recipient total display-only + never-in-body → Task 4 (unit) + Task 8 (e2e). Bangkok schedule + 5-min min-lead reused → Task 3 (shared helper). Per-row `{decision:'send_now'|'schedule', scheduledFor}` → Task 4.
- WS-F send-now Undo (bulk + single) via cancel path, 409 too-late race → Task 5.
- Carry-forward (a) failed-rows-stay retry + re-validate min-lead on re-open → Task 6.
- Carry-forward (b) over-cap hard-confirm "only N of M will send" → Task 3 (`overCapNote`).
- Carry-forward (c) focus → `#main-content` via `useDialogFinalFocus` → Task 3.
- Carry-forward (d) in-flight progress → Task 7 (optional-preferred).
- Deferred (NOT PR3): a real bulk-cancel endpoint (Undo fans out per-id — acceptable at cap 100); extracting single-approve's inline Bangkok duplicate into the shared helper (leave the working single path untouched); pagination.
