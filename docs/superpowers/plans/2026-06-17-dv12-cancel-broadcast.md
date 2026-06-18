# DV-12 — Cancel Broadcast button (F7, admin + member) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Cancel broadcast" control on the admin review surface (reason required, reachable for `submitted` **and** `approved`) and on the member portal broadcast detail (reason optional, own broadcasts), both calling the existing cancel routes.

**Architecture:** One shared client `CancelBroadcastDialog` (mirrors `reject-dialog.tsx`) parameterized by endpoint + i18n namespace + `reasonRequired`; reads `body.error.code` to split the two 409s. Admin renders it via a **sibling** `<AdminCancelAction>` on the detail page (gated `(submitted|approved) && !manager`, independent of the Approve/Reject `ReviewActions` mount). Member renders it via `<MemberCancelAction>` on `/portal/broadcasts/[id]`. Cancel cap = 500 (not reject's 2000).

**Tech Stack:** Next.js 16 RSC + client components, next-intl, sonner, AlertDialog (Base UI), Vitest + Testing Library (real `NextIntlClientProvider`).

## Global Constraints

- TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). `pnpm`.
- Cancel reason cap **500** (admin required 1–500, member optional ≤500). The error envelope is `{error:{code,message,messageThai,details?},correlationId}`; `broadcast_cancel_too_late` and `broadcast_concurrent_action_blocked` are BOTH HTTP 409 — discriminate on `body.error.code`.
- Cancellable statuses: `submitted` | `approved` only. Cancel hidden for the read-only manager.
- Destructive UX (ux-standards §6.2): member dialog (optional reason) focuses **Cancel** initially; admin (required reason) focuses the textarea (mirror reject). `finalFocus` chain `triggerRef ?? #main-content` on the success-path unmount. Member portal `#main-content` needs `tabIndex={-1}`.
- i18n keys in `en`/`th`/`sv`; component tests use the real next-intl provider.
- Branch `076-dv12-cancel-broadcast` off `main` (a NEW worktree, created AFTER DV-11/PR-A merges). Conventional Commits; footer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 0: Branch + worktree (after PR-A merges)

- [ ] Create the worktree off the latest `main` (which now includes DV-11):

```bash
git fetch origin
git worktree add ".claude/worktrees/dv12" -b 076-dv12-cancel-broadcast origin/main
# set up node_modules junction + (no .env.local needed for unit tests/commit)
```
Run all subsequent `git`/`pnpm` from this worktree.

---

### Task 1: i18n keys (admin errors/toast + member namespace) — en/th/sv

**Files:** Modify `src/i18n/messages/{en,th,sv}.json`.

**Interfaces:** Produces `admin.broadcasts.cancelDialog.errors.*`, `admin.broadcasts.toast.{cancelled,cancelError,cancelTooLate}`, and the full `portal.broadcasts.detail.cancelDialog.*` + `portal.broadcasts.detail.toast.*`.

- [ ] **Step 1: `en.json` — extend `admin.broadcasts.cancelDialog`** (it currently lacks an `errors` subtree) by adding:

```json
          "errors": {
            "reasonRequired": "A non-empty reason is required.",
            "reasonTooLong": "Reason exceeds 500 characters."
          }
```

- [ ] **Step 2: `en.json` — extend `admin.broadcasts.toast`** with:

```json
          "cancelled": "Broadcast cancelled. The member has been notified.",
          "cancelError": "Could not cancel the broadcast. Please try again.",
          "cancelTooLate": "This broadcast can no longer be cancelled — it has already started sending or completed."
```

- [ ] **Step 3: `en.json` — add the member namespace** under `portal.broadcasts.detail`:

```json
        "cancelButton": "Cancel broadcast",
        "cancelDialog": {
          "title": "Cancel this broadcast?",
          "description": "Once cancelled it cannot be re-sent. You can still view it in your history.",
          "reasonLabel": "Reason (optional)",
          "reasonPlaceholder": "Optional — why are you cancelling…",
          "reasonHelp": "Up to 500 characters.",
          "confirm": "Cancel broadcast",
          "cancel": "Keep it",
          "errors": { "reasonTooLong": "Reason exceeds 500 characters." }
        },
        "toast": {
          "cancelled": "Broadcast cancelled.",
          "cancelError": "Could not cancel the broadcast. Please try again.",
          "cancelTooLate": "This broadcast can no longer be cancelled — it has already started sending."
        }
```

- [ ] **Step 4: Mirror Steps 1–3 in `th.json` and `sv.json`** (Thai / Swedish copy — keep keys identical). Thai for admin toast e.g. `"cancelled": "ยกเลิก E-Blast แล้ว แจ้งสมาชิกเรียบร้อย"`, `"cancelTooLate": "ยกเลิกไม่ได้แล้ว — เริ่มส่งหรือเสร็จสิ้นแล้ว"`; member dialog title `"ยกเลิก E-Blast นี้?"` etc. (Use the existing `cancelDialog`/`rejectDialog` Thai/Swedish copy as the tone reference.)

- [ ] **Step 5: Parity**

Run: `pnpm check:i18n`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "i18n(broadcasts): cancel dialog errors + toast + member namespace (DV-12)"
```

---

### Task 2: Shared `CancelBroadcastDialog` component (TDD)

**Files:**
- Create: `src/components/broadcast/cancel-broadcast-dialog.tsx`
- Test: `tests/unit/broadcasts/components/cancel-broadcast-dialog.test.tsx`

**Interfaces:**
- Produces: `<CancelBroadcastDialog broadcastId open onOpenChange endpoint namespace toastNamespace reasonRequired triggerRef? fallbackFocusRef? />`.
  - `endpoint`: `/api/admin/broadcasts/${id}/cancel` or `/api/broadcasts/${id}/cancel`.
  - `namespace`: `admin.broadcasts.cancelDialog` or `portal.broadcasts.detail.cancelDialog`.
  - `toastNamespace`: `admin.broadcasts.toast` or `portal.broadcasts.detail.toast`.
  - `reasonRequired`: admin `true`, member `false`.

- [ ] **Step 1: Write the failing test** (real provider; mock fetch/router/sonner; cover success, 409 too-late, 409 concurrent, over-cap, member optional-reason success, focus target)

```tsx
// tests/unit/broadcasts/components/cancel-broadcast-dialog.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { CancelBroadcastDialog } from '@/components/broadcast/cancel-broadcast-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function renderAdmin(extra: Partial<React.ComponentProps<typeof CancelBroadcastDialog>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <CancelBroadcastDialog
        broadcastId="b1" open onOpenChange={vi.fn()}
        endpoint="/api/admin/broadcasts/b1/cancel"
        namespace="admin.broadcasts.cancelDialog"
        toastNamespace="admin.broadcasts.toast"
        reasonRequired
        {...extra}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => vi.restoreAllMocks());

describe('CancelBroadcastDialog (admin)', () => {
  it('cancels and toasts success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    renderAdmin();
    await userEvent.type(screen.getByLabelText(/Reason for cancellation/i), 'duplicate');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel broadcast' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(en.admin.broadcasts.toast.cancelled));
  });

  it('splits 409 too-late vs concurrent on body.error.code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: { code: 'broadcast_cancel_too_late' } }),
    }));
    renderAdmin();
    await userEvent.type(screen.getByLabelText(/Reason for cancellation/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel broadcast' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.admin.broadcasts.toast.cancelTooLate));
  });

  it('renders the over-cap error when reason > 500', async () => {
    renderAdmin();
    await userEvent.type(screen.getByLabelText(/Reason for cancellation/i), 'a'.repeat(501));
    expect(screen.getByRole('alert')).toHaveTextContent(en.admin.broadcasts.cancelDialog.errors.reasonTooLong);
  });
});

describe('CancelBroadcastDialog (member, optional reason)', () => {
  it('confirms with an empty reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <CancelBroadcastDialog
          broadcastId="b1" open onOpenChange={vi.fn()}
          endpoint="/api/broadcasts/b1/cancel"
          namespace="portal.broadcasts.detail.cancelDialog"
          toastNamespace="portal.broadcasts.detail.toast"
          reasonRequired={false}
        />
      </NextIntlClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel broadcast' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(en.portal.broadcasts.detail.toast.cancelled));
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run tests/unit/broadcasts/components/cancel-broadcast-dialog.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Write the component** (mirror reject-dialog; cap 500; `reasonRequired`; `body.error.code` split; focus mode)

```tsx
// src/components/broadcast/cancel-broadcast-dialog.tsx
'use client';

/**
 * DV-12 — shared Cancel-broadcast confirmation dialog (admin + member).
 * Mirrors reject-dialog. Reason cap 500. Admin reason required (textarea
 * focus); member optional (Cancel focus). Reads body.error.code to split
 * the two 409s (too-late vs concurrent).
 */
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const MAX_REASON_LENGTH = 500;

export interface CancelBroadcastDialogProps {
  readonly broadcastId: string;
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly endpoint: string;
  readonly namespace: string;
  readonly toastNamespace: string;
  readonly reasonRequired: boolean;
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null>;
  readonly fallbackFocusRef?: React.RefObject<HTMLElement | null>;
}

export function CancelBroadcastDialog({
  broadcastId, open, onOpenChange, endpoint, namespace, toastNamespace,
  reasonRequired, triggerRef, fallbackFocusRef,
}: CancelBroadcastDialogProps): React.ReactElement {
  const t = useTranslations(namespace);
  const tToast = useTranslations(toastNamespace);
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  // Admin (required reason) focuses the textarea on open (mirror reject).
  useEffect(() => {
    if (!open || !reasonRequired) return undefined;
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => textareaRef.current?.focus());
    });
    return () => { window.cancelAnimationFrame(raf1); if (raf2) window.cancelAnimationFrame(raf2); };
  }, [open, reasonRequired]);

  function handleOpenChange(next: boolean) { if (!next) setReason(''); onOpenChange(next); }

  const trimmed = reason.trim();
  const overCap = reason.length > MAX_REASON_LENGTH;
  const valid = reasonRequired ? trimmed.length >= 1 && !overCap : !overCap;

  function onConfirm() {
    if (!valid || pending) return;
    startTransition(async () => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reason.trim() ? { cancellationReason: reason } : {}),
        });
        if (res.ok) { toast.success(tToast('cancelled')); onOpenChange(false); router.refresh(); return; }
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        if (res.status === 409 && body.error?.code === 'broadcast_cancel_too_late') {
          toast.error(tToast('cancelTooLate')); onOpenChange(false); router.refresh();
        } else if (res.status === 409) {
          toast.error(tToast('cancelError')); onOpenChange(false); router.refresh();
        } else {
          toast.error(tToast('cancelError'));
        }
      } catch { toast.error(tToast('cancelError')); }
    });
  }

  const finalFocus = useCallback(
    (): HTMLElement | null =>
      triggerRef?.current ?? fallbackFocusRef?.current ??
      (typeof document !== 'undefined' ? document.getElementById('main-content') : null),
    [triggerRef, fallbackFocusRef],
  );

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        className="max-w-lg"
        finalFocus={finalFocus}
        {...(reasonRequired ? {} : { initialFocus: cancelRef })}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="cancel-reason">{t('reasonLabel')}</Label>
          <Textarea
            id="cancel-reason" ref={textareaRef} value={reason}
            onChange={(e) => setReason(e.target.value)} placeholder={t('reasonPlaceholder')}
            rows={4} disabled={pending}
            aria-describedby="cancel-reason-help cancel-reason-counter" aria-invalid={overCap}
          />
          <p id="cancel-reason-help" className="text-xs text-muted-foreground">{t('reasonHelp')}</p>
          <p id="cancel-reason-counter" aria-live="polite"
             className={cn('text-xs', overCap ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
            {reason.length} / {MAX_REASON_LENGTH}
          </p>
          {overCap ? <p className="text-xs text-destructive" role="alert">{t('errors.reasonTooLong')}</p> : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={pending}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!valid || pending}
            className={cn('bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive')}
            onClick={(e) => { e.preventDefault(); onConfirm(); }}
          >
            {t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

> Verify `AlertDialogContent` forwards `initialFocus` and `AlertDialogCancel` forwards `ref` (Base UI — reject-dialog already uses `finalFocus`; `initialFocus` is the sibling prop). If `AlertDialogCancel` does not forward a ref, wrap focus via the primitive's `initialFocus` selector or an `onOpenAutoFocus` handler.

- [ ] **Step 4: Run test to verify it passes** — `pnpm vitest run tests/unit/broadcasts/components/cancel-broadcast-dialog.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/broadcast/cancel-broadcast-dialog.tsx tests/unit/broadcasts/components/cancel-broadcast-dialog.test.tsx
git commit -m "feat(broadcasts): shared CancelBroadcastDialog (DV-12)"
```

---

### Task 3: Admin Cancel sibling + wire into the detail page (TDD)

**Files:**
- Create: `src/components/broadcast/admin/admin-cancel-action.tsx`
- Modify: `src/app/(staff)/admin/broadcasts/[id]/page.tsx` (add the sibling near the `ReviewActions` block ~243)
- Test: `tests/unit/broadcasts/components/admin-cancel-action.test.tsx`

**Interfaces:** Produces `<AdminCancelAction broadcastId />` — a destructive-outline trigger button + the shared dialog (admin endpoint, `reasonRequired`).

- [ ] **Step 1: Write the failing test** (renders the trigger; opening shows the dialog title)

```tsx
// tests/unit/broadcasts/components/admin-cancel-action.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { AdminCancelAction } from '@/components/broadcast/admin/admin-cancel-action';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

it('opens the cancel dialog', async () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminCancelAction broadcastId="b1" />
    </NextIntlClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: en.admin.broadcasts.cancelDialog.confirm }));
  expect(await screen.findByText(en.admin.broadcasts.cancelDialog.title)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Write the component**

```tsx
// src/components/broadcast/admin/admin-cancel-action.tsx
'use client';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CancelBroadcastDialog } from '@/components/broadcast/cancel-broadcast-dialog';

export function AdminCancelAction({ broadcastId }: { readonly broadcastId: string }): React.ReactElement {
  const t = useTranslations('admin.broadcasts.cancelDialog');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button variant="destructive-outline" ref={triggerRef} onClick={() => setOpen(true)}>
        <Ban className="mr-1 size-4" aria-hidden="true" />
        {t('confirm')}
      </Button>
      <CancelBroadcastDialog
        broadcastId={broadcastId} open={open} onOpenChange={setOpen}
        endpoint={`/api/admin/broadcasts/${broadcastId}/cancel`}
        namespace="admin.broadcasts.cancelDialog" toastNamespace="admin.broadcasts.toast"
        reasonRequired triggerRef={triggerRef}
      />
    </>
  );
}
```

- [ ] **Step 4: Wire into the admin detail page** — add a sibling block right after the existing `ReviewActions` block (~line 246), gated independently so `approved` is covered and the Approve/Reject `!sanitisedBody.error` coupling does not hide Cancel:

```typescript
{(broadcast.status === 'submitted' || broadcast.status === 'approved') && !isReadOnlyManager ? (
  <div className="flex justify-end">
    <AdminCancelAction broadcastId={broadcast.broadcastId as string} />
  </div>
) : null}
```
Import: `import { AdminCancelAction } from '@/components/broadcast/admin/admin-cancel-action';`

- [ ] **Step 5: Run the component test → PASS** + `pnpm lint && pnpm check:layout`.

- [ ] **Step 6: Commit**

```bash
git add src/components/broadcast/admin/admin-cancel-action.tsx "src/app/(staff)/admin/broadcasts/[id]/page.tsx" tests/unit/broadcasts/components/admin-cancel-action.test.tsx
git commit -m "feat(broadcasts): admin Cancel action for submitted|approved (DV-12)"
```

---

### Task 4: Member Cancel action + wire into portal detail (TDD)

**Files:**
- Create: `src/app/(member)/portal/broadcasts/[id]/_components/member-cancel-action.tsx`
- Modify: `src/app/(member)/portal/broadcasts/[id]/page.tsx` (render after the delivery Card ~237, only when `status ∈ {submitted, approved}`)
- Test: `tests/unit/broadcasts/components/member-cancel-action.test.tsx`

**Interfaces:** Produces `<MemberCancelAction broadcastId />` — trigger + shared dialog (member endpoint, optional reason). The page gates rendering on status; ownership is already enforced by `getMemberBroadcast`.

- [ ] **Step 1: Write the failing test** (mirrors Task 3's open-dialog test, member namespace).

```tsx
// tests/unit/broadcasts/components/member-cancel-action.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { MemberCancelAction } from '@/app/(member)/portal/broadcasts/[id]/_components/member-cancel-action';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

it('opens the member cancel dialog', async () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MemberCancelAction broadcastId="b1" />
    </NextIntlClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: en.portal.broadcasts.detail.cancelButton }));
  expect(await screen.findByText(en.portal.broadcasts.detail.cancelDialog.title)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Write the component**

```tsx
// src/app/(member)/portal/broadcasts/[id]/_components/member-cancel-action.tsx
'use client';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CancelBroadcastDialog } from '@/components/broadcast/cancel-broadcast-dialog';

export function MemberCancelAction({ broadcastId }: { readonly broadcastId: string }): React.ReactElement {
  const t = useTranslations('portal.broadcasts.detail');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex justify-end">
      <Button variant="destructive-outline" ref={triggerRef} onClick={() => setOpen(true)}>
        <Ban className="mr-1 size-4" aria-hidden="true" />
        {t('cancelButton')}
      </Button>
      <CancelBroadcastDialog
        broadcastId={broadcastId} open={open} onOpenChange={setOpen}
        endpoint={`/api/broadcasts/${broadcastId}/cancel`}
        namespace="portal.broadcasts.detail.cancelDialog" toastNamespace="portal.broadcasts.detail.toast"
        reasonRequired={false} triggerRef={triggerRef}
      />
    </div>
  );
}
```

- [ ] **Step 4: Wire into the member portal page** — after the delivery-breakdown Card (~line 237), before `</DetailContainer>`:

```tsx
{(broadcast.status === 'submitted' || broadcast.status === 'approved') ? (
  <MemberCancelAction broadcastId={broadcast.broadcastId as string} />
) : null}
```
Import: `import { MemberCancelAction } from './_components/member-cancel-action';`

- [ ] **Step 5: Run the component test → PASS** + `pnpm lint && pnpm check:layout`.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(member)/portal/broadcasts/[id]/_components/member-cancel-action.tsx" "src/app/(member)/portal/broadcasts/[id]/page.tsx" tests/unit/broadcasts/components/member-cancel-action.test.tsx
git commit -m "feat(broadcasts): member Cancel action on portal broadcast detail (DV-12)"
```

---

### Task 5: Portal `#main-content` focus target

**Files:** Modify `src/app/(member)/portal/layout.tsx` (~line 98).

- [ ] **Step 1: Add `tabIndex={-1}`** so the dialog `finalFocus` fallback + skip-link target works:

```tsx
<main
  className="flex-1 pb-[calc(var(--bottom-tab-height)+env(safe-area-inset-bottom))] lg:pb-0"
  id="main-content"
  tabIndex={-1}
>
```

- [ ] **Step 2: Lint + commit**

```bash
git add "src/app/(member)/portal/layout.tsx"
git commit -m "fix(portal): make #main-content focusable for dialog finalFocus (DV-12)"
```

---

### Task 6: Full gate sweep + PR

- [ ] **Step 1: Gates**

```bash
pnpm lint
pnpm check:i18n
pnpm vitest run tests/unit/broadcasts/components/cancel-broadcast-dialog.test.tsx tests/unit/broadcasts/components/admin-cancel-action.test.tsx tests/unit/broadcasts/components/member-cancel-action.test.tsx
# regression net: keep the existing cancel route/use-case + cross-member/cross-tenant tests green
pnpm vitest run tests/unit/broadcasts/application/cancel-broadcast.test.ts
pnpm check:layout
```
Then a true typecheck (temp tsconfig excl `.next`, non-incremental) as the FINAL gate.
Expected: all PASS.

- [ ] **Step 2: e2e sanity** (if a preview is available): the existing `tests/e2e/broadcast-cancel-too-late.spec.ts` must stay green; add a `@journey`-style click of the new Cancel button only if time permits.

- [ ] **Step 3: Push + PR**

```bash
git -C .claude/worktrees/dv12 push -u origin 076-dv12-cancel-broadcast
gh pr create -R Jirawatpyk/Swedish-chaplain_Membership --base main --head 076-dv12-cancel-broadcast \
  --title "feat(broadcasts): cancel-broadcast button (admin + member) (DV-12)" --body "…"
```

- [ ] **Step 4: After merge** — set DV-12 → `fixed` in `docs/Bug/spec-code-divergence-2026-06-16.md`.

---

## Self-Review

- **Spec coverage:** admin reachable for submitted+approved via a sibling gate (not the submitted-only ReviewActions) ✓ Task 3; member own-broadcast cancel ✓ Task 4; `body.error.code` 409 split ✓ Task 2; cap 500 ✓ Task 2; cancelDialog.errors.* + toast.* + member namespace ✓ Task 1; member focus-Cancel + finalFocus ✓ Task 2; portal `#main-content` tabIndex ✓ Task 5; regression net kept ✓ Task 6.
- **Placeholders:** the only verify-during-impl note is whether `AlertDialogCancel` forwards a `ref` / `AlertDialogContent` accepts `initialFocus` (Task 2 — with a concrete fallback). Thai/Swedish copy in Task 1 Step 4 follows the existing cancelDialog/rejectDialog tone (translate the en strings). All code steps carry real code.
- **Type consistency:** `CancelBroadcastDialog` props (`endpoint`/`namespace`/`toastNamespace`/`reasonRequired`/`triggerRef`) used identically by `AdminCancelAction` and `MemberCancelAction`; both wrappers take `{ broadcastId }`; page gates both on `status ∈ {submitted, approved}`.
