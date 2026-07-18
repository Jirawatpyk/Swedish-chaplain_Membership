# Invoice Settings UX Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 1061-line single-scroll invoice-settings form into a two-column sticky-section-nav layout (6 grouped sections + sticky save bar), splitting the form into per-section presentational sub-components — without changing the PATCH payload, save logic, or any tax guard.

**Architecture:** `InvoiceSettingsForm` stays the single `<form>` and the single owner of all field state, the submit handler, dirty tracking, and the prefix-change dialog. Six presentational, controlled sub-components render field groups. A left `SectionNav` (desktop rail / mobile "jump to" control) scroll-spies the sections. A `StickySaveBar` appears when dirty and triggers the **same** `handleSubmit` via `form.requestSubmit()`, so every existing tax guard still runs. Page container widens to `DetailContainer` (72rem).

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, shadcn/Base UI, lucide-react, next-intl, Vitest, Playwright + axe-core, IntersectionObserver.

## Global Constraints

- Package manager **pnpm**; dev/start **port 3100**.
- **No change to the PATCH `/api/tenant-invoice-settings` body** — the object built in `handleSubmit` (invoice-settings-form.tsx:308–345) stays identical.
- **The sticky Save MUST route through the single `handleSubmit`** (`form.requestSubmit()`), never a separate PATCH call. These 6 submit-handler guards MUST still fire: prefix-change dialog; `'RE'` reserved receipt-prefix; seller branch-pairing (`BRANCH_CODE_RE`); VAT 0–30; SWIFT/account regex; currency `^[A-Z]{3}$`.
- **All field state stays in the orchestrator**; sub-components are controlled + never conditionally unmounted (full-body PATCH would otherwise overwrite tax fields with empty values).
- Container: page and its `loading.tsx` BOTH use `DetailContainer` (72rem). No raw `max-w-[...]`, no exemption. `pnpm check:layout` must pass.
- i18n EN canonical + TH + SV; `pnpm check:i18n` must pass; no hardcoded strings.
- Icons lucide only; touch targets ≥ 44px; WCAG 2.1 AA; `prefers-reduced-motion` respected; sticky bar uses `env(safe-area-inset-bottom)` and must not obscure the focused field (WCAG 2.4.11).

---

### Task 1: Dirty-state helper

**Files:**
- Create: `src/components/invoices/invoice-settings/form-dirty.ts`
- Test: `tests/unit/components/invoices/form-dirty.test.ts`

**Interfaces:**
- Produces: `isDirty(initial: Record<string, unknown>, current: Record<string, unknown>): boolean` — true if ANY key differs (`!Object.is`). Both records share the same key set (all primitives/null).

- [ ] **Step 1: Failing test**

```ts
// tests/unit/components/invoices/form-dirty.test.ts
import { describe, it, expect } from 'vitest';
import { isDirty } from '@/components/invoices/invoice-settings/form-dirty';

describe('isDirty', () => {
  const base = { a: 'x', b: 7, c: false, d: null };
  it('false when identical', () => expect(isDirty(base, { ...base })).toBe(false));
  it('true on a changed string', () => expect(isDirty(base, { ...base, a: 'y' })).toBe(true));
  it('true on null → value', () => expect(isDirty(base, { ...base, d: 'set' })).toBe(true));
  it('true on boolean flip', () => expect(isDirty(base, { ...base, c: true })).toBe(true));
});
```

- [ ] **Step 2: Run → fail**

Run: `pnpm vitest run tests/unit/components/invoices/form-dirty.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/components/invoices/invoice-settings/form-dirty.ts
/** True when any shared key differs between the two flat records. */
export function isDirty(
  initial: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  for (const key of Object.keys(current)) {
    if (!Object.is(initial[key], current[key])) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run → pass**

Run: `pnpm vitest run tests/unit/components/invoices/form-dirty.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/invoices/invoice-settings/form-dirty.ts tests/unit/components/invoices/form-dirty.test.ts
git commit -m "feat(invoices): dirty-state helper for invoice settings"
```

---

### Task 2: useScrollSpy hook

**Files:**
- Create: `src/components/invoices/invoice-settings/use-scroll-spy.ts`
- Test: `tests/unit/components/invoices/use-scroll-spy.test.tsx`

**Interfaces:**
- Produces: `useScrollSpy(sectionIds: readonly string[]): string | null` — the id of the section nearest the top of the viewport, via `IntersectionObserver`. Handles a short final section by falling back to "the last section that has entered" when none are intersecting near the top.

- [ ] **Step 1: Failing test** (jsdom lacks IntersectionObserver — mock it)

```tsx
// tests/unit/components/invoices/use-scroll-spy.test.tsx
import { renderHook, act } from '@testing-library/react';
import { useScrollSpy } from '@/components/invoices/invoice-settings/use-scroll-spy';

let cb: (entries: any[]) => void;
beforeEach(() => {
  cb = () => {};
  (globalThis as any).IntersectionObserver = class {
    constructor(fn: any) { cb = fn; }
    observe() {} disconnect() {} unobserve() {}
  };
  document.body.innerHTML = '<section id="s1"></section><section id="s2"></section>';
});

it('returns the id of the most-visible intersecting section', () => {
  const { result } = renderHook(() => useScrollSpy(['s1', 's2']));
  act(() => cb([
    { target: document.getElementById('s2'), isIntersecting: true, intersectionRatio: 0.9, boundingClientRect: { top: 10 } },
    { target: document.getElementById('s1'), isIntersecting: false, intersectionRatio: 0, boundingClientRect: { top: -200 } },
  ]));
  expect(result.current).toBe('s2');
});
```

- [ ] **Step 2: Run → fail**

Run: `pnpm vitest run tests/unit/components/invoices/use-scroll-spy.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/components/invoices/invoice-settings/use-scroll-spy.ts
'use client';
import { useEffect, useState } from 'react';

export function useScrollSpy(sectionIds: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(sectionIds[0] ?? null);
  useEffect(() => {
    const els = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      // rootMargin lifts the "active" band toward the top; the negative
      // bottom margin lets a short LAST section win once it scrolls near top.
      { rootMargin: '-20% 0px -70% 0px', threshold: [0, 0.1, 0.5, 1] },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sectionIds]);
  return active;
}
```

- [ ] **Step 4: Run → pass**

Run: `pnpm vitest run tests/unit/components/invoices/use-scroll-spy.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/invoices/invoice-settings/use-scroll-spy.ts tests/unit/components/invoices/use-scroll-spy.test.tsx
git commit -m "feat(invoices): scroll-spy hook for section nav"
```

---

### Task 3: SectionNav (desktop rail + mobile jump control)

**Files:**
- Create: `src/components/invoices/invoice-settings/section-nav.tsx`
- Test: `tests/unit/components/invoices/section-nav.test.tsx`

**Interfaces:**
- Consumes: `useScrollSpy`.
- Produces: `<SectionNav sections={[{ id, labelKey }]} />` where each `id` matches a section anchor in the form.

**Design contract (spec §4.1, §6.2):**
- Desktop (`hidden md:block`): `<nav aria-label>` of buttons; active button `aria-current="location"`. Click → `document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' })` then move focus to the section heading (`getElementById(id)?.querySelector('[data-section-heading]')?.focus()` — heading has `tabIndex={-1}`).
- Mobile (`md:hidden`): a labelled native `<select>` ("Jump to section…") whose `onChange` does the same scroll+focus.
- Nav is NOT `aria-live`.

- [ ] **Step 1: Failing test**

```tsx
// tests/unit/components/invoices/section-nav.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { SectionNav } from '@/components/invoices/invoice-settings/section-nav';

const sections = [
  { id: 'organization', labelKey: 'sections.organization' },
  { id: 'tax', labelKey: 'sections.tax' },
] as const;

it('scrolls to and focuses a section on nav click', () => {
  document.body.innerHTML =
    '<section id="organization"><h2 data-section-heading tabindex="-1">Org</h2></section>' +
    '<section id="tax"><h2 data-section-heading tabindex="-1">Tax</h2></section>';
  const scrollSpy = vi.fn();
  (HTMLElement.prototype as any).scrollIntoView = scrollSpy;
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SectionNav sections={sections as any} />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /tax/i }));
  expect(scrollSpy).toHaveBeenCalled();
  expect(document.querySelector('#tax [data-section-heading]')).toHaveFocus();
});
```

- [ ] **Step 2: Run → fail**

Run: `pnpm vitest run tests/unit/components/invoices/section-nav.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** per the design contract (desktop `<nav>` + mobile `<select>`, both calling a shared `goTo(id)` that scrolls + focuses `[data-section-heading]`; active id from `useScrollSpy(sections.map(s => s.id))`; labels via `t(labelKey)` under `admin.invoiceSettings`).

- [ ] **Step 4: Run → pass**

Run: `pnpm vitest run tests/unit/components/invoices/section-nav.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/invoices/invoice-settings/section-nav.tsx tests/unit/components/invoices/section-nav.test.tsx
git commit -m "feat(invoices): sticky section nav with scroll-spy + focus management"
```

---

### Task 4: StickySaveBar

**Files:**
- Create: `src/components/invoices/invoice-settings/sticky-save-bar.tsx`
- Test: `tests/unit/components/invoices/sticky-save-bar.test.tsx`

**Interfaces:**
- Produces: `<StickySaveBar visible submitting onSave />` — `onSave` is wired by the orchestrator to `formRef.current?.requestSubmit()`.

**Design contract (spec §4.3, §6.2):**
- Renders `null` when `!visible`. When visible: a fixed bottom region `role="region"` `aria-label` (announce-once — NOT `aria-live`) showing the "unsaved changes" copy + a ≥44px Save button (`aria-busy={submitting}`). Bottom padding `env(safe-area-inset-bottom)`. `motion-safe:` slide-in only.

- [ ] **Step 1: Failing test**

```tsx
// tests/unit/components/invoices/sticky-save-bar.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { StickySaveBar } from '@/components/invoices/invoice-settings/sticky-save-bar';

const wrap = (ui: React.ReactNode) =>
  render(<NextIntlClientProvider locale="en" messages={messages}>{ui}</NextIntlClientProvider>);

it('is hidden when not visible', () => {
  const { container } = wrap(<StickySaveBar visible={false} submitting={false} onSave={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

it('calls onSave when the Save button is clicked', () => {
  const onSave = vi.fn();
  wrap(<StickySaveBar visible submitting={false} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  expect(onSave).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run → fail**

Run: `pnpm vitest run tests/unit/components/invoices/sticky-save-bar.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
'use client';
import { useTranslations } from 'next-intl';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function StickySaveBar({
  visible, submitting, onSave,
}: { readonly visible: boolean; readonly submitting: boolean; readonly onSave: () => void }) {
  const t = useTranslations('admin.invoiceSettings');
  if (!visible) return null;
  return (
    <div
      role="region"
      aria-label={t('stickyBar.label')}
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur motion-safe:animate-in motion-safe:slide-in-from-bottom"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex max-w-[72rem] items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm text-muted-foreground">{t('stickyBar.unsaved')}</span>
        <Button type="button" onClick={onSave} disabled={submitting} aria-busy={submitting} className="min-h-11">
          {submitting && <Loader2Icon aria-hidden className="mr-2 h-4 w-4 motion-safe:animate-spin" />}
          {t('actions.save')}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run → pass**

Run: `pnpm vitest run tests/unit/components/invoices/sticky-save-bar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/invoices/invoice-settings/sticky-save-bar.tsx tests/unit/components/invoices/sticky-save-bar.test.tsx
git commit -m "feat(invoices): sticky save bar (dirty-gated, single submit path)"
```

---

### Task 5: Unsaved-changes navigate-away guard

**Files:**
- Create: `src/components/invoices/invoice-settings/use-unsaved-guard.ts`
- Test: `tests/unit/components/invoices/use-unsaved-guard.test.tsx`

**Interfaces:**
- Produces: `useUnsavedGuard(dirty: boolean): void` — registers a `beforeunload` handler while `dirty` (covers reload / tab-close / external nav). In-app soft-nav guard is best-effort and out of scope for this hook (documented).

- [ ] **Step 1: Failing test**

```tsx
// tests/unit/components/invoices/use-unsaved-guard.test.tsx
import { renderHook } from '@testing-library/react';
import { useUnsavedGuard } from '@/components/invoices/invoice-settings/use-unsaved-guard';

it('adds a beforeunload listener when dirty and removes it when clean', () => {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  const { rerender, unmount } = renderHook(({ d }) => useUnsavedGuard(d), { initialProps: { d: true } });
  expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  rerender({ d: false });
  expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  unmount();
});
```

- [ ] **Step 2: Run → fail**

Run: `pnpm vitest run tests/unit/components/invoices/use-unsaved-guard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/components/invoices/invoice-settings/use-unsaved-guard.ts
'use client';
import { useEffect } from 'react';

export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
```

- [ ] **Step 4: Run → pass**

Run: `pnpm vitest run tests/unit/components/invoices/use-unsaved-guard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/invoices/invoice-settings/use-unsaved-guard.ts tests/unit/components/invoices/use-unsaved-guard.test.tsx
git commit -m "feat(invoices): beforeunload guard while form is dirty"
```

---

### Task 6: Extract the 6 section sub-components

**Files (create, all under `src/components/invoices/invoice-settings/sections/`):**
- `organization-section.tsx` (currency, legal_name_th/en, brand_name, tax_id, address_th/en, seller_is_head_office + seller_branch_code)
- `tax-vat-section.tsx` (vat_percent, registration_fee)
- `numbering-section.tsx` (invoice/credit-note/receipt prefixes, receipt_mode read-only, fiscal_year_start_month, default_net_days, pro_rate_policy)
- `document-notes-section.tsx` (wht_note_th/en, termination_notice_th/en, auto_email_enabled)
- `payment-section.tsx` (bank block + payment_instructions_th/en)
- `branding-section.tsx` (logo upload)

**Interfaces (each section):**
- Props: the section's state slice + setters + `disabled: boolean` (+ `onLogoChange`/`uploadingLogo`/`logoError` for branding). **Controlled + presentational only — no local field state, no PATCH, no validation logic.**
- Each section root is `<section id="<sectionId>" aria-labelledby>` containing a heading with `data-section-heading tabIndex={-1}` (the nav focus target) and the existing `<fieldset>`/`<legend>` markup **moved verbatim** from `invoice-settings-form.tsx`.

**Design contract:** This is a mechanical extraction — copy each field's existing JSX (labels, hints, char counters, `aria-*`, `min-h-11`, patterns) from `invoice-settings-form.tsx` into the matching section file, replacing the local `useState` reads/writes with the props passed in. The **seller head-office toggle + conditional `seller_branch_code` input MUST stay together** in `organization-section.tsx`. Do NOT change any input attribute, validation hint, or field id.

- [ ] **Step 1: Write a smoke render test per section** (example for organization; repeat pattern for the others)

```tsx
// tests/unit/components/invoices/sections/organization-section.test.tsx
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { OrganizationSection } from '@/components/invoices/invoice-settings/sections/organization-section';

it('renders the seller branch input only when not head office', () => {
  const props = { /* all slice props; sellerIsHeadOffice: false */ } as any;
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrganizationSection {...props} disabled={false} />
    </NextIntlClientProvider>,
  );
  expect(screen.getByLabelText(/branch code/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run → fail**, then extract each section, wiring props. Run each section test.

Run: `pnpm vitest run tests/unit/components/invoices/sections/`
Expected: PASS once all sections are extracted.

- [ ] **Step 3: Commit**

```bash
git add src/components/invoices/invoice-settings/sections/ tests/unit/components/invoices/sections/
git commit -m "refactor(invoices): extract 6 presentational settings sections"
```

---

### Task 7: Refactor the orchestrator (state, requestSubmit, first-invalid focus, dirty)

**Files:**
- Modify: `src/components/invoices/invoice-settings-form.tsx`

**Design contract (spec §4.3, §4.4, §6.3):**
- Keep ALL `useState`, `handleSubmit`, `doPatch`, the prefix-change `AlertDialog`, and the body-building object **unchanged**.
- Add `const formRef = useRef<HTMLFormElement>(null)` on the `<form>`.
- Build `currentValues` + `initialRecord` (same key set) and `const dirty = isAdmin && isDirty(initialRecord, currentValues)`; `useUnsavedGuard(dirty)`.
- Render the two-column shell: `<SectionNav sections={SECTIONS} />` + the 6 `<*Section>` components (passing state slices). Keep the bottom `<Button type="submit">` as the always-reachable Save (spec §4.3 "keep a reachable Save affordance"). Render `<StickySaveBar visible={dirty} submitting={submitting} onSave={() => formRef.current?.requestSubmit()} />`.
- On a **blocked** submit (validation early-return), after `setError(...)`, focus the first invalid field: `formRef.current?.querySelector<HTMLElement>(':invalid, [aria-invalid="true"]')?.focus()` and `scrollIntoView`. Wire each early-return branch to also mark its field (set an `aria-invalid` or rely on native `:invalid`).
- `SECTIONS` constant = `[{id:'organization',labelKey:'sections.organization'}, {id:'tax',labelKey:'sections.tax'}, {id:'numbering',labelKey:'sections.numbering'}, {id:'notes',labelKey:'sections.documentNotes'}, {id:'payment',labelKey:'sections.payment'}, {id:'branding',labelKey:'sections.branding'}]`.

- [ ] **Step 1: Write the full-body-invariance test**

```tsx
// tests/unit/components/invoices/invoice-settings-fullbody.test.tsx
// Asserts the PATCH body is byte-identical whether or not a section was scrolled/re-rendered.
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { InvoiceSettingsForm } from '@/components/invoices/invoice-settings-form';

it('sticky Save routes through the same handleSubmit (fetch PATCH fires once, full body)', async () => {
  const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({}), { status: 200 }) as any);
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InvoiceSettingsForm initialValues={FIXTURE} currentUserRole="admin" exists={true} />
    </NextIntlClientProvider>,
  );
  fireEvent.change(screen.getByLabelText(/brand name/i), { target: { value: 'NewBrand' } });
  fireEvent.click(await screen.findByRole('button', { name: /save/i })); // sticky bar Save
  const call = fetchSpy.mock.calls.find(([url]) => String(url).includes('/api/tenant-invoice-settings'));
  expect(call).toBeTruthy();
  const body = JSON.parse((call![1] as RequestInit).body as string);
  expect(body).toHaveProperty('tax_id'); // full body, not a partial
  expect(body.brand_name).toBe('NewBrand');
});
```

(Define `FIXTURE` as a complete `InvoiceSettingsFormInitialValues` object.)

- [ ] **Step 2: Run → fail** (sticky Save / two-column not yet wired)

Run: `pnpm vitest run tests/unit/components/invoices/invoice-settings-fullbody.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Refactor the orchestrator** per the design contract. Verify the pre-existing prefix-dialog + PII-post-method tests still pass.

- [ ] **Step 4: Run → pass (incl. existing tests)**

Run: `pnpm vitest run tests/unit/components/invoices/ && pnpm typecheck`
Expected: PASS — including `invoice-settings-form.test.tsx` and `pii-forms-post-method.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/components/invoices/invoice-settings-form.tsx tests/unit/components/invoices/invoice-settings-fullbody.test.tsx
git commit -m "feat(invoices): two-column sticky-nav orchestrator; sticky Save via requestSubmit; first-invalid focus"
```

---

### Task 8: Page container + loading skeleton → DetailContainer + two-column

**Files:**
- Modify: `src/app/(staff)/admin/settings/invoicing/page.tsx`
- Modify: `src/app/(staff)/admin/settings/invoicing/loading.tsx`

- [ ] **Step 1: Swap the container** in `page.tsx`: replace `import { FormContainer } from '@/components/layout'` + `<FormContainer>` with `DetailContainer`. The two-column layout lives inside `InvoiceSettingsForm` (nav rail + form), so the page just wraps the `PageHeader` + `Card` in `DetailContainer`.

- [ ] **Step 2: Match `loading.tsx`** — swap it to `DetailContainer` too and add a left-rail skeleton (`<Skeleton className="hidden h-64 w-48 md:block" />`) beside the form-field skeletons.

- [ ] **Step 3: Verify the layout gate**

Run: `pnpm check:layout`
Expected: PASS (page + loading both `DetailContainer`).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(staff)/admin/settings/invoicing/page.tsx" "src/app/(staff)/admin/settings/invoicing/loading.tsx"
git commit -m "feat(invoices): widen invoice-settings to DetailContainer for the section-nav layout"
```

---

### Task 9: i18n keys for sections + nav + sticky bar

**Files:**
- Modify: `src/i18n/messages/{en,th,sv}.json` under `admin.invoiceSettings`

**Interfaces:**
- New keys: `sections.organization`, `sections.documentNotes`, `sections.payment`, `sections.branding` (reuse existing `sections.tax`, `sections.numbering`, `sections.identity` where applicable — audit the existing `sections.*` first and only add the missing ones); `nav.label` ("Settings sections"); `nav.jumpTo` ("Jump to section…"); `stickyBar.label` ("Save changes"); `stickyBar.unsaved` ("You have unsaved changes").

- [ ] **Step 1: Add missing keys to `en.json`, mirror into `th.json` + `sv.json`.** Thai: `stickyBar.unsaved` = "มีการเปลี่ยนแปลงที่ยังไม่บันทึก"; `nav.jumpTo` = "ไปที่หมวด…". Swedish: `stickyBar.unsaved` = "Du har osparade ändringar".

- [ ] **Step 2: Verify parity**

Run: `pnpm check:i18n`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "feat(invoices): i18n keys for section nav + sticky save bar"
```

---

### Task 10: E2E — navigation, sticky-save prefix dialog, full-body invariance, axe

**Files:**
- Create: `tests/e2e/invoices/invoice-settings.spec.ts`

**Design contract (spec §4.3, §6.3):**
- Sign in as admin, go to `/admin/settings/invoicing`.
- (a) Click a section nav item → the target section heading receives focus.
- (b) Change the invoice prefix, click Save **from the sticky bar** → the §87 prefix-change confirmation dialog appears (proves the single-submit path preserves the guard).
- (c) After confirming, intercept the PATCH and assert the body carries the full identity (e.g. `tax_id`, `legal_name_th`) unchanged.
- (d) `@a11y` axe scan.

- [ ] **Step 1: Write the spec**

```ts
// tests/e2e/invoices/invoice-settings.spec.ts
import { test, expect } from '@playwright/test';
import { signInAsAdmin } from '../helpers/auth';

test('@a11y invoice settings: nav focus + sticky Save keeps the prefix-change dialog', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/admin/settings/invoicing');

  // (a) nav → focus section heading
  await page.getByRole('button', { name: /numbering/i }).click();
  await expect(page.locator('#numbering [data-section-heading]')).toBeFocused();

  // (b) change a prefix and Save from the sticky bar → dialog fires
  await page.getByLabel(/invoice.*prefix/i).fill('INVX');
  await page.locator('[role="region"][aria-label]').getByRole('button', { name: /save/i }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();

  // (c) confirm → PATCH carries the full body
  const patch = page.waitForRequest((r) => r.url().includes('/api/tenant-invoice-settings') && r.method() === 'PATCH');
  await page.getByRole('button', { name: /confirm/i }).click();
  const body = (await patch).postDataJSON();
  expect(body).toHaveProperty('tax_id');
  expect(body).toHaveProperty('legal_name_th');
});
```

- [ ] **Step 2: Run E2E**

Run: `pnpm test:e2e --workers=1 --grep "invoice settings"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/invoices/invoice-settings.spec.ts
git commit -m "test(invoices): e2e — section-nav focus, sticky-save prefix dialog, full-body PATCH + axe"
```

---

## Final verification (run before opening the PR)

```bash
pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm check:layout \
  && pnpm vitest run tests/unit/components/invoices \
  && pnpm test:e2e --workers=1 --grep "invoice settings"
```

All green → the invoice-settings surface is ready. The PATCH body and all 6 tax guards are unchanged (E2E proves the sticky Save still fires the §87 dialog), and the form is now a navigable, 6-section, single-save layout.
