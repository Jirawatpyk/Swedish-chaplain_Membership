# DV-11 — Re-send Verification Email button (F3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a "Re-send verification email" button on the member-detail page that calls the existing resend route, shown only when the linked contact's email is unverified, and rate-limited.

**Architecture:** Mirror the existing F3 `ResendBouncedInviteButton` (client component → POST → toast → `router.refresh()`). The visible-gate is computed by a new page-local `_lib/resolve-contact-verification.ts` helper (mirroring `_lib/resolve-contact-subscriptions.ts`) that the page runs inside its existing `Promise.all`, injecting `deps.userEmails.isEmailVerified`; the page derives a per-contact `verificationPending` flag passed to `ContactBlock`. A per-`(actorUserId, contactId)` Upstash rate limit is added to the route.

**Tech Stack:** Next.js 16 RSC + client component, next-intl, sonner, Vitest + Testing Library (real `NextIntlClientProvider`), Upstash rate limiter.

## Global Constraints

- TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Use `pnpm`.
- **Do NOT modify `getMember`** (9 call sites + lean `buildMemberProbeDeps`). Verification status is derived in the page, not the domain `Contact`.
- Presentation reaches the F1 user-email check only through the injected callable into the `_lib` resolver (mirror `resolve-contact-subscriptions`), never a domain field.
- i18n keys MUST exist in all three locales `en` / `th` / `sv` (`en` canonical; `check:i18n` parity). Component tests use the real next-intl provider, so every rendered string must resolve.
- Branch `075-dv11-resend-verification` (off `main`), in the existing worktree `.claude/worktrees/dv11`. Run git via `git -C .claude/worktrees/dv11` or from inside the worktree.
- Conventional Commits; footer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: i18n keys for resendVerification (en/th/sv)

**Files:**
- Modify: `src/i18n/messages/en.json` (add under `admin.members.detail`, after the `inviteBounced` block ~line 1013)
- Modify: `src/i18n/messages/th.json` (same path)
- Modify: `src/i18n/messages/sv.json` (same path)

**Interfaces:**
- Produces: the i18n namespace `admin.members.detail.resendVerification` consumed by Task 4's button.

- [ ] **Step 1: Add the `en.json` block** (mirror the `inviteBounced` structure, lines 1000–1013):

```json
        "resendVerification": {
          "badge": "Email verification pending",
          "badgeAria": "Contact email verification pending",
          "resendLabel": "Re-send verification email",
          "resendSubmitting": "Sending…",
          "resendSuccess": "Verification email re-sent.",
          "errors": {
            "notFound": "Contact not found.",
            "noLinkedUser": "No portal account is linked to this contact.",
            "emailVerified": "This email has already been verified.",
            "rateLimited": "Too many re-sends. Please wait a few minutes and try again.",
            "serverError": "Something went wrong. Please try again."
          }
        },
```

- [ ] **Step 2: Add the `th.json` block** (same keys, Thai copy):

```json
        "resendVerification": {
          "badge": "รอยืนยันอีเมล",
          "badgeAria": "ผู้ติดต่อรอการยืนยันอีเมล",
          "resendLabel": "ส่งอีเมลยืนยันอีกครั้ง",
          "resendSubmitting": "กำลังส่ง…",
          "resendSuccess": "ส่งอีเมลยืนยันอีกครั้งแล้ว",
          "errors": {
            "notFound": "ไม่พบผู้ติดต่อ",
            "noLinkedUser": "ผู้ติดต่อนี้ยังไม่ได้ผูกบัญชีพอร์ทัล",
            "emailVerified": "อีเมลนี้ยืนยันแล้ว",
            "rateLimited": "ส่งซ้ำบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่",
            "serverError": "เกิดข้อผิดพลาด กรุณาลองใหม่"
          }
        },
```

- [ ] **Step 3: Add the `sv.json` block** (same keys, Swedish copy):

```json
        "resendVerification": {
          "badge": "E-postverifiering väntar",
          "badgeAria": "Kontaktens e-postverifiering väntar",
          "resendLabel": "Skicka verifieringsmejl igen",
          "resendSubmitting": "Skickar…",
          "resendSuccess": "Verifieringsmejl skickat igen.",
          "errors": {
            "notFound": "Kontakten hittades inte.",
            "noLinkedUser": "Inget portalkonto är kopplat till denna kontakt.",
            "emailVerified": "Denna e-post är redan verifierad.",
            "rateLimited": "För många omsändningar. Vänta några minuter och försök igen.",
            "serverError": "Något gick fel. Försök igen."
          }
        },
```

- [ ] **Step 4: Verify parity**

Run: `pnpm check:i18n`
Expected: PASS (no missing keys across en/th/sv).

- [ ] **Step 5: Commit**

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "i18n(members): add resendVerification keys (en/th/sv)"
```

---

### Task 2: `resolve-contact-verification` page-local loader (TDD)

**Files:**
- Create: `src/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-verification.ts`
- Test: `tests/unit/app/members/resolve-contact-verification.test.ts`

**Interfaces:**
- Consumes: an injected `isVerified: (userId: string) => Promise<Result<boolean, unknown>>` callable (production: `deps.userEmails.isEmailVerified`), a minimal logger, and `errKind`.
- Produces: `resolveContactVerification(args): Promise<{ pending: ReadonlySet<string> }>` — the set of `contactId`s whose linked user's email is **unverified**. Best-effort: a read error for a contact ⇒ that contact is **omitted** (treated as not-pending → button hidden).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/app/members/resolve-contact-verification.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { resolveContactVerification } from '@/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-verification';

const logger = { debug: vi.fn(), warn: vi.fn() };
const errKind = (e: unknown) => (e as Error)?.constructor?.name ?? 'Unknown';

function contact(id: string, linkedUserId: string | null, removedAt: Date | null = null) {
  return { contactId: id, linkedUserId, removedAt };
}

describe('resolveContactVerification', () => {
  it('marks a linked contact whose email is unverified as pending', async () => {
    const isVerified = vi.fn().mockResolvedValue(ok(false));
    const res = await resolveContactVerification({
      contacts: [contact('c1', 'u1')],
      memberId: 'm1',
      isVerified,
      logger,
      errKind,
    });
    expect(res.pending.has('c1')).toBe(true);
    expect(isVerified).toHaveBeenCalledWith('u1');
  });

  it('does NOT mark a verified linked contact', async () => {
    const isVerified = vi.fn().mockResolvedValue(ok(true));
    const res = await resolveContactVerification({
      contacts: [contact('c1', 'u1')],
      memberId: 'm1',
      isVerified,
      logger,
      errKind,
    });
    expect(res.pending.has('c1')).toBe(false);
  });

  it('skips contacts with no linkedUserId and removed contacts (no read)', async () => {
    const isVerified = vi.fn().mockResolvedValue(ok(false));
    const res = await resolveContactVerification({
      contacts: [contact('c1', null), contact('c2', 'u2', new Date())],
      memberId: 'm1',
      isVerified,
      logger,
      errKind,
    });
    expect(res.pending.size).toBe(0);
    expect(isVerified).not.toHaveBeenCalled();
  });

  it('defaults to not-pending when the read errors (button hidden on unknown)', async () => {
    const isVerified = vi.fn().mockResolvedValue(err({ code: 'repo.unexpected' }));
    const res = await resolveContactVerification({
      contacts: [contact('c1', 'u1')],
      memberId: 'm1',
      isVerified,
      logger,
      errKind,
    });
    expect(res.pending.has('c1')).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/app/members/resolve-contact-verification.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** (mirror `resolve-contact-subscriptions.ts` shape — injected callable + best-effort)

```typescript
// src/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-verification.ts
/**
 * DV-11 — per-contact email-verification resolver (visible-gate for the
 * "Re-send verification email" button). Mirrors resolve-contact-subscriptions:
 * the page injects the F1 `isEmailVerified` callable so this stays unit-testable
 * without a live read, and the page (presentation) never calls the port shape
 * directly. Best-effort: a read error for a contact omits it (button hidden on
 * unknown state — safer than offering a possibly no-op resend).
 */
import type { Result } from '@/lib/result';

export interface VerificationResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface VerifiableContact {
  readonly contactId: string;
  readonly linkedUserId: string | null;
  readonly removedAt: Date | null;
}

export type IsVerified = (userId: string) => Promise<Result<boolean, unknown>>;

export interface ResolveContactVerificationArgs {
  readonly contacts: ReadonlyArray<VerifiableContact>;
  readonly memberId: string;
  readonly isVerified: IsVerified;
  readonly logger: VerificationResolverLogger;
  readonly errKind: (e: unknown) => string;
}

export async function resolveContactVerification({
  contacts,
  memberId,
  isVerified,
  logger,
  errKind,
}: ResolveContactVerificationArgs): Promise<{ pending: ReadonlySet<string> }> {
  const pending = new Set<string>();
  const live = contacts.filter((c) => c.removedAt === null && c.linkedUserId);
  await Promise.all(
    live.map(async (c) => {
      try {
        const res = await isVerified(c.linkedUserId as string);
        if (res.ok) {
          if (res.value === false) pending.add(c.contactId);
        } else {
          logger.warn(
            { event: 'contact_verification_read_err', contactId: c.contactId, memberId },
            '[DV-11] isEmailVerified returned err — contact treated as not-pending',
          );
        }
      } catch (e) {
        logger.warn(
          { event: 'contact_verification_threw', errKind: errKind(e), contactId: c.contactId, memberId },
          '[DV-11] isEmailVerified threw — contact treated as not-pending',
        );
      }
    }),
  );
  return { pending };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/app/members/resolve-contact-verification.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-verification.ts" tests/unit/app/members/resolve-contact-verification.test.ts
git commit -m "feat(members): add resolve-contact-verification loader (DV-11)"
```

---

### Task 3: Wire the resolver into the page + thread `verificationPending` to ContactBlock

**Files:**
- Modify: `src/app/(staff)/admin/members/[memberId]/page.tsx` (the `Promise.all` block ~561–651; the `ContactBlock` prop type ~284–314; the `subscriptionFor` derivation ~656–659; the two `<ContactBlock …>` call sites ~1070–1102; the `ResendBouncedInviteButton` cluster ~412–414)

**Interfaces:**
- Consumes: `resolveContactVerification` (Task 2), `deps.userEmails.isEmailVerified`, `ResendVerificationButton` (Task 4).
- Produces: `ContactBlock` renders `<ResendVerificationButton>` when `canWrite && contact.linkedUserId && verificationPending`.

- [ ] **Step 1: Import the resolver + the button** (top of `page.tsx`)

```typescript
import { resolveContactVerification } from './_lib/resolve-contact-verification';
import { ResendVerificationButton } from '@/components/members/resend-verification-button';
```

- [ ] **Step 2: Add the resolve call to the existing `Promise.all`** — append a 5th element after `resolveContactSubscriptions(...)`:

```typescript
      // DV-11 — per-contact email-verification state for the visible-gate on the
      // "Re-send verification email" button. Injects the F1 isEmailVerified
      // callable so the resolver stays unit-testable; best-effort (read error →
      // contact omitted → button hidden).
      resolveContactVerification({
        contacts,
        memberId,
        isVerified: (userId) => deps.userEmails.isEmailVerified(userId),
        logger,
        errKind,
      }),
```

And add `verificationResult` to the destructured array:

```typescript
  const [
    pendingInvitationsByContactId,
    planLookup,
    memberPrefix,
    subscriptionResult,
    verificationResult,
  ] = await Promise.all([ /* …existing four…, plus the new fifth above */ ]);
```

- [ ] **Step 3: Add the per-contact derivation** (next to `subscriptionFor`, ~line 656):

```typescript
  const verificationPendingFor = (contactId: string): boolean =>
    verificationResult.pending.has(contactId);
```

- [ ] **Step 4: Add the prop to `ContactBlock`** (type block ~284–314):

```typescript
  /** DV-11 — true when the linked user's email is unverified → show the
   *  "Re-send verification email" button. */
  verificationPending: boolean;
```

- [ ] **Step 5: Render the button in the ContactBlock action cluster** (right after the `ResendBouncedInviteButton` block ~414):

```typescript
            {/* DV-11 — re-send verification email when the linked contact's
                email is still unverified (e.g. mid email-change). */}
            {canWrite && contact.linkedUserId && verificationPending && (
              <ResendVerificationButton memberId={memberId} contactId={contact.contactId} />
            )}
```

- [ ] **Step 6: Pass the prop at both `<ContactBlock>` call sites** (~1070 primary, ~1092 secondary):

```typescript
                  verificationPending={verificationPendingFor(primary.contactId)}
```
(and `secondary.contactId` for the secondary block.)

- [ ] **Step 7: Typecheck + lint + check:layout**

Run: `pnpm lint && pnpm check:layout`
Then a true typecheck (temp tsconfig excluding `.next`, non-incremental) — see CLAUDE.md.
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(staff)/admin/members/[memberId]/page.tsx"
git commit -m "feat(members): wire resend-verification visible-gate into member detail (DV-11)"
```

---

### Task 4: `ResendVerificationButton` component (TDD)

**Files:**
- Create: `src/components/members/resend-verification-button.tsx`
- Test: `tests/unit/components/members/resend-verification-button.test.tsx`

**Interfaces:**
- Consumes: i18n `admin.members.detail.resendVerification` (Task 1); POST `/api/members/:memberId/contacts/:contactId/resend-verification`.
- Produces: `<ResendVerificationButton memberId contactId />`.

- [ ] **Step 1: Write the failing test** (real `NextIntlClientProvider` + real `en.json`; mock `fetch` + `next/navigation` + `sonner`)

```tsx
// tests/unit/components/members/resend-verification-button.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { ResendVerificationButton } from '@/components/members/resend-verification-button';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function renderButton() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ResendVerificationButton memberId="m1" contactId="c1" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => vi.restoreAllMocks());

describe('ResendVerificationButton', () => {
  it('posts and toasts success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: /Re-send verification email/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Verification email re-sent.'));
  });

  it('toasts emailVerified on 409 not_eligible/email_verified', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'not_eligible', reason: 'email_verified' }),
    }));
    renderButton();
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This email has already been verified.'));
  });

  it('toasts notFound on flat 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404, json: async () => ({ error: 'not_found' }),
    }));
    renderButton();
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Contact not found.'));
  });

  it('toasts rateLimited on 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, json: async () => ({ error: 'rate_limited' }),
    }));
    renderButton();
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.admin.members.detail.resendVerification.errors.rateLimited));
  });

  it('toasts serverError on 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => ({ error: 'server_error' }),
    }));
    renderButton();
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Something went wrong. Please try again.'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/components/members/resend-verification-button.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component** (mirror `resend-bounced-invite-button.tsx`; handle 429 + the two not_eligible reasons; use the **flat** error shape)

```tsx
// src/components/members/resend-verification-button.tsx
'use client';

/**
 * DV-11 — re-send verification email button (FR-012c).
 * Shown on the member detail page next to a portal-linked contact whose email
 * is still unverified. Mirrors ResendBouncedInviteButton.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MailCheckIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Props = { readonly memberId: string; readonly contactId: string };

export function ResendVerificationButton({ memberId, contactId }: Props) {
  const t = useTranslations('admin.members.detail.resendVerification');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleClick() {
    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/members/${encodeURIComponent(memberId)}/contacts/${encodeURIComponent(contactId)}/resend-verification`,
        { method: 'POST' },
      );
      if (response.ok) {
        toast.success(t('resendSuccess'));
        router.refresh();
        return;
      }
      if (response.status === 429) {
        toast.error(t('errors.rateLimited'));
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: string; reason?: string };
      if (body.error === 'not_eligible') {
        toast.error(body.reason === 'email_verified' ? t('errors.emailVerified') : t('errors.noLinkedUser'));
      } else if (body.error === 'not_found') {
        toast.error(t('errors.notFound'));
      } else {
        toast.error(t('errors.serverError'));
      }
    } catch {
      toast.error(t('errors.serverError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleClick} disabled={submitting} className="gap-2">
      <MailCheckIcon className="h-4 w-4" aria-hidden="true" />
      {submitting ? t('resendSubmitting') : t('resendLabel')}
    </Button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/components/members/resend-verification-button.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/members/resend-verification-button.tsx tests/unit/components/members/resend-verification-button.test.tsx
git commit -m "feat(members): ResendVerificationButton component (DV-11)"
```

---

### Task 5: Rate-limit the resend-verification route (TDD)

**Files:**
- Modify: `src/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route.ts`
- Test: `tests/contract/members/resend-verification-rate-limit.test.ts`

**Interfaces:**
- Consumes: the existing shared rate limiter. **First read** how an existing `src/app/api/**` route applies a limit (grep `rateLimitedJson` / `rateLimiter.check` — e.g. an F4 invoice route or `src/app/api/auth/sign-in/route.ts`) and reuse that exact import + helper. The limiter call is `rateLimiter.check(key, max, windowSeconds) → { success, reset, ... }`.
- Produces: a `429 { error: 'rate_limited' }` (flat, matching this route's existing flat error shape) + `Retry-After` header when the per-`(actorUserId, contactId)` budget is exceeded; fail-soft (Upstash outage → request proceeds, handled inside the limiter's in-memory fallback).

- [ ] **Step 1: Write the failing test** (verify the 4th call within the window is 429; mock the limiter)

```typescript
// tests/contract/members/resend-verification-rate-limit.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// NOTE: mock the limiter module the route imports (adjust the path to match
// the import chosen in Step 3 after reading the existing rate-limit usage).
const check = vi.fn();
vi.mock('@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter', () => ({
  rateLimiter: { check: (...a: unknown[]) => check(...a) },
}));
// …mock requireAdminContext to return an admin gate, resolveTenantFromRequest,
// buildMembersDeps, and resendVerificationEmail (ok) per the repo's existing
// route-test patterns (see tests/contract/members/resend-verification.test.ts).

beforeEach(() => vi.restoreAllMocks());

describe('resend-verification rate limit', () => {
  it('returns 429 when the limiter denies', async () => {
    check.mockResolvedValue({ success: false, reset: Date.now() + 60_000 });
    const { POST } = await import('@/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route');
    const res = await POST(/* NextRequest stub */ {} as never, {
      params: Promise.resolve({ memberId: '…uuid…', contactId: '…uuid…' }),
    } as never);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('rate_limited');
  });

  it('proceeds (200) when the limiter allows', async () => {
    check.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });
    // …assert 200 with the existing success body shape.
  });
});
```

> Adjust the test scaffolding to match `tests/contract/members/resend-verification.test.ts` (the existing route test) for the admin-gate / deps mocks.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/contract/members/resend-verification-rate-limit.test.ts`
Expected: FAIL (no 429 branch yet).

- [ ] **Step 3: Add the limiter to the route** — after the admin gate resolves (`const { current, requestId } = gate;`) and after `contactId` is parsed, before calling `resendVerificationEmail`:

```typescript
  // DV-11 (security) — throttle re-sends per (admin, contact) to prevent
  // email-bombing a member's inbox. Fail-soft: the limiter falls back to an
  // in-memory bucket during an Upstash outage (never blocks a legit resend).
  const rl = await rateLimiter.check(
    `resend-verify:${current.user.id}:${contactId}`,
    3,
    3600, // 3 per hour
  );
  if (!rl.success) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))) } },
    );
  }
```

Add the import (matching the path confirmed in the Interfaces step):

```typescript
import { rateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
```

> If ESLint `no-restricted-imports` blocks crossing into `modules/auth/infrastructure`, use the same limiter import the F4 invoice routes use (grep `rateLimitedJson`), and return its 429 shape instead — keep the per-`(user,contact)` key + 3/hour.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/contract/members/resend-verification-rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route.ts" tests/contract/members/resend-verification-rate-limit.test.ts
git commit -m "feat(members): rate-limit resend-verification route 3/hr per admin+contact (DV-11)"
```

---

### Task 6: Full gate sweep + PR

- [ ] **Step 1: Run the gates**

```bash
pnpm lint
pnpm check:i18n
pnpm vitest run tests/unit/app/members/resolve-contact-verification.test.ts tests/unit/components/members/resend-verification-button.test.tsx tests/contract/members/resend-verification-rate-limit.test.ts tests/contract/members/resend-verification.test.ts
pnpm check:layout
```
Then a true typecheck (temp tsconfig excluding `.next`, non-incremental) as the FINAL gate.
Expected: all PASS.

- [ ] **Step 2: Push + open PR** (worktree off main; pre-push hook runs)

```bash
git -C .claude/worktrees/dv11 push -u origin 075-dv11-resend-verification
gh pr create -R Jirawatpyk/Swedish-chaplain_Membership --base main --head 075-dv11-resend-verification \
  --title "feat(members): re-send verification email button + rate limit (DV-11)" --body "…"
```

- [ ] **Step 3: After merge** — set DV-11 → `fixed` in `docs/Bug/spec-code-divergence-2026-06-16.md` (separate follow-up edit on main).

---

## Self-Review

- **Spec coverage:** loader (no getMember change) ✓ Task 2; visible-gate wiring ✓ Task 3; button + 409/404/429/500 handling ✓ Task 4; rate-limiter ✓ Task 5; i18n en/th/sv ✓ Task 1; unit-tier loader test (mocked, not live-Neon) ✓ Task 2.
- **Placeholders:** the only deferred detail is the exact rate-limiter import path (Task 5 Interfaces + the ESLint fallback note) — pinned to "reuse the existing route's limiter," with concrete fallback. All other steps carry real code.
- **Type consistency:** `resolveContactVerification` returns `{ pending: ReadonlySet<string> }`; page uses `verificationResult.pending.has(...)` and `verificationPendingFor`; `ContactBlock` prop `verificationPending: boolean`; button props `{memberId, contactId}` — consistent across tasks.
