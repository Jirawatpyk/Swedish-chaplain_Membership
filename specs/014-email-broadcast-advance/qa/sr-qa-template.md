# F7.1a Manual Screen-Reader QA Template (T135)

**Purpose**: Manual screen-reader verification of 5 F7.1a surfaces per SC-008 + Constitution Principle VI WCAG 2.1 AA gate.
**Operator**: copy this file to `sr-qa-2026-{date}.md` on ship-day, fill in findings.
**SR choices**: NVDA on Windows (Chrome/Edge/Firefox) OR VoiceOver on macOS (Safari) — at least one is mandatory; both encouraged for high-confidence.
**Pre-condition**: Section A + B.1 + B.2 of ship-day-checklist.md complete. Staging env has all 4 F7.1a flags ON.

---

## SR QA acceptance criteria (per surface)

For each surface, verify:

1. **Reachability** — every interactive control is reachable via Tab key (not just mouse).
2. **Announcement** — SR announces each element's role + name + state (e.g., "Retry batches, button, focused").
3. **Order** — Tab order matches visual reading order; no skipped elements; no out-of-order focus.
4. **Focus visibility** — visible focus ring on every focused element (per F4 design system).
5. **State transitions** — opening a dialog announces it (via `role="alertdialog"` or `role="dialog"` + `aria-labelledby`); closing restores focus to the trigger.
6. **Error announcements** — validation errors announced via `role="alert"` or `aria-live="polite"`.
7. **Loading states** — long operations announce via `aria-busy="true"` or `role="status"` + `aria-live="polite"`.

---

## Surface 1 — Admin batch breakdown

**Route**: `/admin/broadcasts/[id]` for a `partially_sent` broadcast
**Pre-condition**: seed a `partially_sent` broadcast via SQL fixture OR US1 flow

### Test path
1. Navigate to the route via member list → broadcast detail
2. Locate the batch breakdown collapsible (`<details>` element)
3. Expand the breakdown → verify per-batch table rows announced
4. Tab through to the Retry button
5. Press Enter → AlertDialog opens

### Verification
- [ ] `<details>/<summary>` expansion announced ("expanded" / "collapsed")
- [ ] Per-batch table rows announced with: batch_index, recipient_range, status, dispatched_at
- [ ] Status badges announced (sent / failed / pending / cancelled)
- [ ] aria-live polite summary line announced when batch count updates
- [ ] Retry button reaches via Tab; "Retry failed batches, button" announced
- [ ] If `manual_retry_count >= 3`: button disabled + announced as "Retry failed batches, button, disabled"

**Findings**: `<TBD>`
**Result**: PASS / FAIL — `<TBD>`

---

## Surface 2 — Admin retry confirmation modal

**Trigger**: Retry button on Surface 1

### Test path
1. Click Retry → AlertDialog opens
2. Verify focus enters dialog
3. Read budget-remaining line
4. Tab to Cancel button → Tab to Submit button
5. Press Esc → dialog closes + focus restores to Retry button

### Verification
- [ ] Dialog announces on open: title + role=alertdialog OR role=dialog + aria-labelledby
- [ ] Focus enters dialog (focus-trap)
- [ ] Budget-remaining line announced ("2 of 3 manual retries remaining")
- [ ] Warning copy about duplicate-email risk announced
- [ ] Tab cycles Cancel ↔ Submit only (focus-trap holds)
- [ ] Esc closes dialog + focus restores to Retry button
- [ ] On successful submit: toast `retrySuccess` announced via aria-live=polite

**Findings**: `<TBD>`
**Result**: PASS / FAIL — `<TBD>`

---

## Surface 3 — Admin image-source allowlist editor

**Route**: `/admin/broadcasts/settings`
**Pre-condition**: `FEATURE_F71A_US2_IMAGES=true` (staging)

### Test path
1. Navigate to settings page
2. SR reads the table headings + existing rows (e.g., `resend.com` with "Default" badge)
3. Tab to the hostname input → type `cdn.example.com`
4. Tab to Add button → press Enter → row appears
5. Tab to Remove button on a non-default row → press Enter → confirmation; press Enter again → row removed
6. Try to Remove a default row → button disabled OR confirmation rejected with `cannot_remove_default` banner

### Verification
- [ ] Table headings announced (Hostname, Source, Actions)
- [ ] Default-row marker announced ("Default" badge)
- [ ] Form input has associated `<label>` — "Hostname, edit" announced
- [ ] Add button announced as "Add hostname to allowlist, button"
- [ ] Remove button announced contextually with the hostname value
- [ ] Error banner on `cannot_remove_default` announced via role="alert"
- [ ] Toast on success/failure announced via aria-live=polite

**Findings**: `<TBD>`
**Result**: PASS / FAIL — `<TBD>`

---

## Surface 4 — Admin template library + editor

**Route**: `/admin/broadcasts/templates` + `/admin/broadcasts/templates/[id]/edit`
**Pre-condition**: `FEATURE_F71A_US7_TEMPLATES=true` (staging)

### Test path
1. Navigate to template library
2. SR reads list headings + existing seeded rows (5 starter templates × 3 locales = 15 rows; filter pills allow narrowing)
3. Tab to a filter pill ("Starter only") → press Enter → list narrows
4. Tab to Edit button on a seeded row → press Enter → editor page loads
5. SR announces the editor confirmation banner ("This is a starter template seeded by the platform...")
6. Tab to Name / Subject / Body / Save → navigate the Tiptap editor with arrow keys
7. Save → return to list with success toast

### Verification
- [ ] List headings announced (Name, Subject preview, Started-from count, Last modified)
- [ ] Starter badge announced ("Starter" — distinct from regular rows)
- [ ] Filter pills announced with `aria-pressed` state
- [ ] Edit page confirmation banner announced via role="status" or role="alert"
- [ ] Tiptap editor: text content readable + editable via arrow keys + Enter
- [ ] Form fields have associated labels (Name, Subject)
- [ ] Save button announced; disabled state announced when form invalid
- [ ] Success toast announced via aria-live=polite

**Findings**: `<TBD>`
**Result**: PASS / FAIL — `<TBD>`

---

## Surface 5 — Member template picker dropdown

**Route**: `/portal/broadcasts/new` (compose page)
**Pre-condition**: `FEATURE_F71A_US7_TEMPLATES=true`

### Test path
1. Navigate to compose page → first compose action is the template picker
2. SR reads the picker trigger button ("Choose a template, combobox")
3. Press Enter or Space → dropdown opens
4. SR announces first option in list
5. Type to filter → list narrows; SR announces remaining count
6. Arrow Down through options → each option announced with role=option + aria-selected
7. Press Enter on a template → draft populates; focus restores to trigger button
8. Press Esc on a re-opened dropdown → closes without selection; focus restores

### Verification
- [ ] Trigger button: role=combobox, aria-expanded toggles, aria-controls references listbox
- [ ] Dropdown: role=listbox; options role=option
- [ ] Active descendant: aria-activedescendant points to the highlighted option
- [ ] Starter badge announced inline on starter templates
- [ ] Typeahead filter announced ("Showing 3 of 5 templates")
- [ ] On selection: draft populates + announcement (e.g., "Template 'Monthly Newsletter' applied")
- [ ] Esc closes; focus restored to trigger
- [ ] Tab cycles only visible items (filtered-out items skipped per T157 tab-order policy)

**Findings**: `<TBD>`
**Result**: PASS / FAIL — `<TBD>`

---

## Summary

| Surface | Result | Critical findings |
|---------|--------|-------------------|
| 1. Admin batch breakdown | TBD | TBD |
| 2. Admin retry confirmation modal | TBD | TBD |
| 3. Admin image-source allowlist editor | TBD | TBD |
| 4. Admin template library + editor | TBD | TBD |
| 5. Member template picker dropdown | TBD | TBD |

**Overall**: PASS / FAIL — `<TBD>`

**Ship-blocking findings**: TBD (any control unreachable; focus trap broken; critical text missing; AlertDialog not announced).
**F7.1b backlog findings**: TBD (warnings; cosmetic; non-critical).

**Reviewer**: `<name>` — `<date>`
**Sign-off**: `<signature/email>`
