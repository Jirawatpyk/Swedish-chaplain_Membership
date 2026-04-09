# UX/UI Standards — Enterprise Grade

**Project**: SweCham / TSCC Membership System
**Status**: Active, project-wide
**Governance**: Derived from Constitution v1.2.0 Principle VI (Inclusive UX) — extends, does not supersede
**Applies to**: All features (F1–F9) — every pixel that a user sees

This document is the **authoritative UX/UI playbook** for the SweCham system.
Every feature spec and plan MUST conform to it. Every component MUST be
implemented to these rules before review sign-off.

If something here conflicts with Principle VI, Principle VI wins and this
document MUST be updated. If something here is silent, use shadcn/ui defaults.

---

## 1. Design Tokens & Theming

### 1.1 Component library

- **shadcn/ui** on **Radix UI** primitives for all interactive components.
- **Tailwind CSS v4** with the default shadcn theme as the starting point;
  brand colors applied via CSS custom properties in `src/app/globals.css`.
- **lucide-react** for all icons — tree-shaken, SVG, a11y-compatible.
- **No ad-hoc components.** Any new primitive requires a PR against the
  `src/components/ui/` directory plus a reviewer sign-off.

### 1.2 Colour tokens

- Defined in `src/app/globals.css` using CSS custom properties (shadcn format).
- **Light mode** and **dark mode** — both MUST be supported from day one.
- Token names follow shadcn convention: `--background`, `--foreground`,
  `--primary`, `--primary-foreground`, `--muted`, `--accent`, `--destructive`,
  `--border`, `--ring`, etc.
- **Contrast**: all text/background combinations MUST meet **WCAG 2.1 AA**
  (4.5:1 for normal text, 3:1 for large text) in BOTH modes — verified by
  automated tests.
- **Brand colours**: SweCham Swedish blue (#005293) and SweCham yellow
  (#FFCD00) as `--accent` and `--accent-foreground` respectively.

### 1.3 Type scale

| Token | Size | Line height | Use |
|---|---|---|---|
| `text-xs` | 12 px | 16 px | Meta, labels, timestamps |
| `text-sm` | 14 px | 20 px | Dense data, table cells, form labels |
| `text-base` | 16 px | 24 px | Default body — **minimum** for body copy |
| `text-lg` | 18 px | 28 px | Card titles, emphasis |
| `text-xl` | 20 px | 28 px | Section headings |
| `text-2xl` | 24 px | 32 px | Page titles |
| `text-3xl` | 30 px | 36 px | Dashboard hero numbers |

- **Fonts**: `Inter` (variable) for Latin scripts, `IBM Plex Sans Thai`
  (variable) for Thai. Loaded via `next/font` with `display: swap`.
- **Minimum body size**: 16 px — never smaller for body text to preserve
  readability (16 px also prevents iOS Safari from zooming on input focus).

### 1.4 Spacing scale

- Tailwind default spacing scale (4 px unit: `p-1 = 4px`, `p-2 = 8px`, ...).
- **Dense forms**: `gap-3 / gap-4` between fields.
- **Comfortable forms**: `gap-5 / gap-6` between fields.
- **Card padding**: `p-6` (24 px) default.

### 1.5 Radius

- `rounded-lg` (0.5 rem) for cards, panels, dialogs.
- `rounded-md` (0.375 rem) for buttons, inputs, badges.
- `rounded-full` for avatars and pills.

### 1.6 Elevation

- Avoid heavy shadows. Use `shadow-sm` for cards, `shadow-lg` for dialogs
  and popovers. No more than 3 elevation levels in one view.

### 1.7 Theming switcher

- **next-themes** for light/dark mode.
- Initial theme follows `prefers-color-scheme`; user preference overrides
  and persists in a cookie (not localStorage — cookie works with SSR).
- Theme switcher lives in the user menu (top-right of every authenticated
  shell).

---

## 2. Loading States — **Skeleton Shimmer** (mandatory)

Loading is a UX state, not an absence of UX. Every surface that waits on
data MUST show a **skeleton shimmer** placeholder — never a blank screen,
never just a spinner.

### 2.1 Skeleton shimmer — the canonical pattern

- Use `<Skeleton>` from `src/components/ui/skeleton.tsx` (shadcn-generated,
  extended with shimmer).
- The shimmer effect is a linear gradient sliding left-to-right across the
  placeholder, 1.5 s per cycle, `ease-in-out`.
- Base colour: `bg-muted`. Shimmer colour: `bg-muted-foreground/10`
  (light mode) / `bg-muted-foreground/15` (dark mode).
- Skeleton shapes MUST **match the real content layout** — same dimensions,
  same rounded corners, same count. A loaded card transitioning to a skeleton
  card should not shift the layout (CLS = 0).

**Tailwind config addition** (`tailwind.config.ts`):

```ts
// in theme.extend
keyframes: {
  shimmer: {
    '0%':   { transform: 'translateX(-100%)' },
    '100%': { transform: 'translateX(100%)' },
  },
},
animation: {
  shimmer: 'shimmer 1.5s ease-in-out infinite',
},
```

**Skeleton component** (`src/components/ui/skeleton.tsx`):

```tsx
import { cn } from '@/lib/cn';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md bg-muted',
        'motion-safe:after:absolute motion-safe:after:inset-0',
        'motion-safe:after:-translate-x-full motion-safe:after:animate-shimmer',
        'motion-safe:after:bg-gradient-to-r',
        'motion-safe:after:from-transparent motion-safe:after:via-muted-foreground/10 motion-safe:after:to-transparent',
        'motion-reduce:animate-pulse',
        className,
      )}
      aria-hidden="true"
      {...props}
    />
  );
}
```

Note the `motion-safe:` and `motion-reduce:` prefixes — users who set
`prefers-reduced-motion: reduce` see a gentle `animate-pulse` instead of a
moving shimmer (Principle VI compliance).

### 2.2 When to use skeletons vs spinners

| Scenario | Use |
|---|---|
| Initial page load, data being fetched on the server | Skeleton shimmer |
| Card or list item being loaded | Skeleton shimmer |
| Chart / dashboard widget loading | Skeleton shimmer (matching the chart's layout) |
| Form submission in progress (button pressed) | **Button spinner** (`<Loader2 className="animate-spin" />` inside the button) — not a skeleton |
| File upload in progress | **Progress bar** |
| Short sync wait (<100 ms) | No indicator — "instant" feel |

### 2.3 Minimum display duration

A skeleton MUST be visible for **at least 300 ms** once shown, even if data
arrives faster. This prevents the "flash of skeleton" — a sub-100 ms shimmer
that makes the UI feel glitchy.

Implementation: use a `useMinDelay(300)` hook that delays hiding the skeleton
until the minimum has elapsed.

### 2.4 Progressive loading

For pages with multiple independent data sources (e.g., staff dashboard with
4 cards), each card loads and replaces its own skeleton independently. Do
NOT wait for ALL data before showing ANYTHING.

Next.js 16 Cache Components + `<Suspense>` boundaries implement this
naturally — wrap each card in its own boundary.

### 2.5 Error replacement

If a data fetch fails, the skeleton MUST be replaced by an **error state**,
not silently removed. See § 4.

---

## 3. Empty States

Every list, table, or data surface MUST have a designed empty state.

### 3.1 Anatomy

```
┌─────────────────────────────────────────┐
│                                         │
│          [Icon, 48×48, muted]           │
│                                         │
│              Title                      │
│        (text-lg, semibold)              │
│                                         │
│         Explanatory sentence            │
│        (text-sm, muted, 1–2 lines)      │
│                                         │
│          [Primary action CTA]           │
│                                         │
└─────────────────────────────────────────┘
```

- **Icon** from lucide (e.g., `<Users />` for an empty user list).
- **Title** is descriptive, not apologetic ("No staff accounts yet", not
  "Sorry, nothing here").
- **Explanatory** tells the user why it's empty and what they can do.
- **CTA** is the obvious next action (e.g., "Invite first staff member").
- Copy localised in EN / TH / SV.

### 3.2 Member portal landing (F1 Q1=A placeholder)

The member portal placeholder landing page IS an empty state:

- Icon: `<FileText />` or similar
- Title: "Welcome, {name}"
- Explanatory: "Your membership details, invoices, and events will appear here as those features are added."
- CTA: none (nothing to do yet) — but show sign-out in the shell header.

---

## 4. Error States

### 4.1 Inline form validation

- Validation errors appear **below the field**, not in a separate summary,
  using `text-sm text-destructive` with a `<CircleAlert />` icon.
- Error text is **specific and actionable** ("Password must be at least 12
  characters long", not "Invalid password").
- Fields with errors get `aria-invalid="true"` and `aria-describedby` pointing
  to the error text id.
- Error text announced via `role="alert"` on first appearance.

### 4.2 Toast for global / async errors

- **Sonner** component (shadcn) for non-blocking toasts.
- Error toast: `sonner.error(message, { description, action })`
- Position: `top-right` on desktop, `top-center` on mobile.
- Auto-dismiss after 5 s by default; error toasts persist until dismissed
  by user action.
- Each toast has a "Dismiss" button for keyboard users.

### 4.3 Full-page error (500, network failure, unexpected)

- Replace the skeleton / loaded content with an **error card**:
  - Icon: `<AlertTriangle />` (muted-foreground colour)
  - Title: "Something went wrong"
  - Description: localised user-facing message (NOT the raw error)
  - Actions: "Retry" (primary) and "Go back" (secondary)
  - Show the `x-request-id` in a small mono-font at the bottom for support.

### 4.4 Email-dependent waiting screens (resend affordance)

Any screen that tells the user "check your email" (password reset
confirmation, invitation pending, verification link) MUST include a
**resend affordance** that:

- Appears **after 60 seconds** of the first email being triggered
- Shows a visible **countdown** before it is available ("You can resend in 45 seconds...")
- Rate-limits re-sends the same way as the original request
- Shows a **success toast** after a resend ("We sent a new link to your inbox")
- Shows an **inline warning card** if the delivery webhook reports a
  bounce or delay for that email: "Delivery to your inbox is delayed.
  Please check your spam folder or contact us at info@swecham.se if
  you don't see the email within 10 minutes."
- On persistent failure (e.g., 3 attempts in a row) shows a "Contact
  support" link with the request ID pre-filled in a mailto: URL

This is a spec-level requirement (FR-025, SC-017) — every email-dependent
flow ships with the resend pattern or the gate fails.

### 4.4 Error copywriting

- Plain language, localised in SV/EN/TH.
- **Never** expose stack traces, SQL errors, or raw server messages to users.
- Errors explain the **next action** ("Please try again", "Contact support
  if this continues").

---

## 5. Success Feedback

### 5.1 Toast for non-blocking success

- **Sonner** `sonner.success(message)` — auto-dismiss after 3 s.
- Used for: form saved, user invited, password changed, session rotated.
- NEVER used for critical security operations that need acknowledgement
  (use a modal confirmation screen instead).

### 5.2 Inline success

- When a form is submitted and the user stays on the same page, show a
  success message inline (same layout position as the error would be).
- Icon: `<CircleCheck />` in success colour.

### 5.3 Undo where applicable

- For reversible destructive actions (disable user, cancel invite), include
  an "Undo" button in the success toast that remains actionable for 8 s.
- Implementation: the mutation runs optimistically; Undo cancels before
  server commit OR issues an inverse operation.

---

## 6. Confirmation Dialogs

Any **destructive** or **irreversible** action MUST require confirmation via
a modal dialog.

### 6.1 Required for

- Disable account
- Re-enable account
- Change user role
- Delete anything (F2+)
- Issue refund (F5)
- Cancel event (F6)
- Send mass communication (F9)

### 6.2 Anatomy

- `<AlertDialog>` (shadcn primitive on Radix).
- **Title**: the action in plain language ("Disable account?")
- **Description**: the consequence ("Jane Admin will be signed out immediately and cannot sign in again until re-enabled.")
- **Buttons**:
  - Cancel (secondary, left-aligned on mobile / right-of-primary on desktop)
  - Confirm (destructive variant — red — for destructive actions, primary for neutral)
- Focus starts on **Cancel** (safer default).
- Escape key closes without action.
- Confirm button shows a spinner while the action runs; dialog stays open
  until the action completes or fails.

### 6.3 Typed confirmation for irreversible actions

For truly irreversible actions (F2+: delete member, delete event), require
the user to type a specific phrase (e.g., the entity name or `DELETE`) into
a confirmation input before the Confirm button enables.

---

## 7. Focus Management & Keyboard Navigation

### 7.1 Skip to content

Every page has a "Skip to main content" link as the first focusable element
in the DOM, visually hidden until focused. Targets `<main id="main-content">`.

### 7.2 Auto-focus

- Sign-in page: focus the email input on mount.
- Invitation / reset page: focus the new password input.
- Modal dialogs: focus the first actionable element (usually Cancel).
- After modal close: focus returns to the element that opened the modal.

### 7.3 Tab order

- Logical top-to-bottom, left-to-right.
- No `tabindex > 0` — rely on DOM order.
- `tabindex={-1}` only for programmatic focus (e.g., error summary).

### 7.4 Keyboard shortcuts

F1 (and every feature) supports these baseline shortcuts:

- **Tab / Shift+Tab** — move focus
- **Enter** — submit form or activate button
- **Space** — activate button or toggle checkbox
- **Escape** — close modal / popover / cancel inline edit
- **Cmd/Ctrl + K** — open command palette (F2+, stub in F1)

Power-user shortcuts (per feature) documented in a `?` help dialog.

### 7.5 Focus visible indicators

- `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`
  on every interactive element (inherited from shadcn defaults).
- The ring colour has ≥ 3:1 contrast against all backgrounds.

### 7.6 Screen reader landmarks

- `<header role="banner">`
- `<nav aria-label="Main navigation">`
- `<main id="main-content">`
- `<aside aria-label="Session">`
- `<footer role="contentinfo">`
- Region labels via `aria-labelledby` where visual context is required.

---

## 8. Session Indicator & Idle Warning

### 8.1 Always-visible user menu

Every authenticated shell (staff and member) has a user menu in the top-right:

- Avatar (initials fallback)
- Name (truncated on mobile)
- Role badge (`admin` / `manager` / `member`)
- Dropdown items: Account, Change password, Theme, **Sign out**

The user menu is accessible via `Tab` from any page and via `Alt+U` keyboard
shortcut.

### 8.2 Idle warning modal

Before the 30-minute idle timeout hits, show a warning modal:

- **Trigger**: 29 minutes of inactivity (1 minute before the hard idle timeout)
- **Title**: "Still there?"
- **Description**: "You'll be signed out in 60 seconds for your security."
- **Actions**:
  - **Stay signed in** (primary) — sends a heartbeat request to refresh `last_seen_at`, closes modal
  - **Sign out now** (secondary) — ends the session immediately
- **Countdown**: visible "XX seconds" that counts down in real time
- **On expiry**: the modal auto-signs the user out and redirects to the
  sign-in page with a friendly "Signed out due to inactivity" toast

This is a **required** feature for enterprise UX — surprising auto-sign-outs
are a top user complaint.

### 8.3 Session rotation notice

After a password change (current session is rotated per FR-019), show a
toast: "Password changed — your other sessions have been signed out."

---

## 9. Responsive Layout & Density

### 9.1 Mobile-first (mandatory)

- Every layout starts at **320 px width** and scales up.
- No horizontal scrolling at any viewport ≥ 320 px.
- No content truncation — long text wraps or uses `text-ellipsis` with
  `title` tooltip.
- Tappable targets MUST be **≥ 44 × 44 px** (WCAG 2.5.5 AAA) on mobile.

### 9.2 Breakpoints (Tailwind defaults)

- `sm` 640px — phablet / small tablet
- `md` 768px — tablet portrait
- `lg` 1024px — tablet landscape / small desktop
- `xl` 1280px — desktop
- `2xl` 1536px — large desktop

Enterprise admin screens typically render at `lg`+; mobile is member portal
priority.

### 9.3 Density modes (F2+)

F1 ships with **default density only**. From F2 onwards, staff screens
support three density modes: compact / default / comfortable, selectable
in the user menu.

### 9.4 Tables (F2+)

- Virtualised rows for > 100 rows (using TanStack Table).
- Sortable column headers with visible direction indicators.
- Filter chips above the table.
- Sticky header on scroll.
- Empty state per § 3.
- Loading state: skeleton rows matching the real row layout.

---

## 10. Motion & Animation

### 10.1 Respect reduced motion

- **Every** animation MUST have a `motion-reduce:` fallback.
- `prefers-reduced-motion: reduce` disables: shimmer, slide-in, scale
  transitions, toast slide, modal fade. Keeps only: colour transitions,
  opacity transitions ≤ 200 ms, `animate-pulse` as shimmer fallback.

### 10.2 Durations

- **Micro** (focus, hover): 150 ms
- **Transition** (modal, drawer): 200 ms
- **Emphasis** (shimmer cycle): 1 500 ms (but only with `motion-safe`)
- Never longer than 300 ms for user-initiated feedback.

### 10.3 Easing

- `ease-out` for entering (snappy start)
- `ease-in` for exiting
- `ease-in-out` for shimmer

---

## 11. Forms

### 11.1 Structure

- **Label above the field**, not floating or inline.
- **Required fields** marked with a visible `*` and `aria-required="true"`.
  The asterisk has `aria-hidden="true"` and the required-ness is conveyed
  via a legend or field description for screen readers.
- **Help text** below the field (`text-sm text-muted-foreground`) for
  any non-obvious field.
- **Inline errors** below the field (§ 4.1).
- **Submit button** at the bottom, with a secondary "Cancel" button to
  its left (desktop) or below (mobile).

### 11.2 Input behaviour

- **Enter** submits the form if focus is in any input (except `<textarea>`).
- **Escape** clears an input if it has focus (with undo via Ctrl+Z).
- **Autocomplete**: proper `autocomplete` attributes (`current-password`,
  `new-password`, `email`, etc.) so browsers and password managers work.
- **Input modes**: `inputmode="email"` on email fields, `inputmode="numeric"`
  on numeric fields — triggers the right mobile keyboard.

### 11.3 Validation timing

- **On blur**: validate individual field.
- **On submit**: validate all fields + show summary of errors at top if > 1.
- **Never** validate on keypress (feels nagging).

### 11.4 Password strength indicator

For new-password fields: show a live strength meter (3 states: weak /
acceptable / strong) that updates as the user types. Weak blocks submit;
acceptable and strong allow submit. Strength rules are defined in the
auth domain layer, not the UI.

---

## 12. Internationalisation (i18n) UX

### 12.1 Three locales from day one

- **English** (default / fallback), **Thai**, **Swedish** — per Constitution V.
- Locale switcher in user menu; URL is locale-prefixed (`/en`, `/th`, `/sv`).

### 12.2 Content length

- Thai text is often longer than English. Layouts MUST accommodate
  +50% text length without clipping.
- Swedish text is often longer too (compound words).
- Buttons: use `flex` layout that grows with content, not fixed widths.

### 12.3 Date & time display

- `en-GB` format in English: `9 April 2026, 14:23`
- `sv-SE` format in Swedish: `9 april 2026 14:23`
- `th-TH` format in Thai: `9 เมษายน 2569 14:23` (Buddhist Era, BE = CE + 543)
- All formatted via `Intl.DateTimeFormat` with the correct locale.

### 12.4 Currency

- Primary: **THB** via `Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' })`
- Also support SEK, EUR, USD when explicitly set on an entity.

### 12.5 Number formatting

- Never hardcode decimal separators. Always `Intl.NumberFormat(locale)`.

---

## 13. Iconography

- **Lucide React** exclusively. No mixed icon sets.
- Icons used purely for decoration: `aria-hidden="true"`.
- Icons that convey meaning: `<span className="sr-only">description</span>`
  inside the icon's container, or `aria-label` on the interactive wrapper.
- Size: default 16 × 16 for inline, 20 × 20 for buttons, 24 × 24 for
  section headers, 48 × 48 for empty states.

---

## 14. Copywriting Standards

- **Plain language**, grade-school reading level where possible.
- **Active voice** ("We signed you out" not "You were signed out").
- **You** for the user, **we** for the system only when attribution matters.
- **Positive framing** ("Let's reset your password" not "You forgot your password").
- **Brevity** — every word earns its place. Cut ruthlessly.
- **Sentence case** for buttons, titles, labels ("Sign in" not "Sign In").
- **Localised** in all three languages — NO copy ships without translations
  (per Constitution V).

---

## 15. Acceptance Criteria — every auth screen in F1 MUST pass

- [ ] Renders at 320 × 568 px (iPhone SE 1st gen) without horizontal scroll
- [ ] Renders at 1920 × 1080 px without ugly stretching
- [ ] Passes `@axe-core/playwright` WCAG 2.1 AA automated scan
- [ ] All user-visible strings have EN + TH + SV translations
- [ ] Skeleton shimmer shown on first-load data sections (if any)
- [ ] Empty state designed and tested (if applicable to the screen)
- [ ] Error states designed and tested (field, form, page)
- [ ] Toast shown on success (if non-blocking)
- [ ] Confirmation dialog shown for destructive actions
- [ ] Auto-focus on the primary input on mount
- [ ] Enter submits the form
- [ ] Escape closes any open modal / popover
- [ ] Focus-visible ring on every interactive element
- [ ] Dark mode renders correctly
- [ ] Screen reader: landmarks announced, errors announced, flow navigable
- [ ] `prefers-reduced-motion` honoured (shimmer → pulse, transitions → none)
- [ ] Session user menu visible on authenticated shells (if applicable)
- [ ] Idle-warning modal tested (staff shell only for F1)

---

## 16. Required shadcn/ui primitives (install checklist)

From the [shadcn CLI](https://ui.shadcn.com), the following primitives are
installed for F1:

```bash
pnpm dlx shadcn@latest add \
  alert alert-dialog avatar badge button card dialog \
  dropdown-menu form input label select separator \
  skeleton sonner tabs toast tooltip
```

Plus custom extensions:
- `skeleton.tsx` — extended with shimmer animation (§ 2.1)
- `idle-warning-dialog.tsx` — composed from `alert-dialog` (§ 8.2)
- `user-menu.tsx` — composed from `dropdown-menu` + `avatar` (§ 8.1)
- `empty-state.tsx` — composed from `card` + lucide icon (§ 3.1)
- `skip-to-content.tsx` — plain `<a>` with focus styles (§ 7.1)

---

## 17. Review gate additions

Every PR touching UI MUST tick all applicable items from § 15 (auth screen
checklist) or the equivalent checklist for non-auth screens. Reviewers:
refuse to merge UI PRs that leave boxes unchecked.
