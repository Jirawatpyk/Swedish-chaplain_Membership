# Chamber-OS UX Pattern Library

**Purpose**: canonical flows for recurring interactions so every feature treats destructive actions, bulk operations, multi-step wizards, unsaved changes, and bulk import/export consistently. Pairs with `docs/ux-standards.md` (visual primitives) and `docs/shadcn-customizations.md` (component deviations).

**Last updated**: 2026-04-24 — design-system audit C1 (P0)

**Status**: v0.1 — initial landing. Patterns evolve as features ship; each addition MUST update this file in the same PR.

---

## 1. Destructive Action Confirm

**When to use**: any action that deletes data, revokes access, cancels a subscription, issues a refund, archives a member, or otherwise cannot be undone via a normal Undo.

**When NOT to use**: reversible actions (soft archive, toggle active, reorder) — those use inline confirmation via toast + Undo button (pattern 1.1 below).

### 1.0 Canonical shape

```
[Trigger Button, variant=destructive or danger-ghost]
  → <AlertDialog>
      <AlertDialogTitle>{{specific, names the object}}</AlertDialogTitle>
      <AlertDialogDescription>{{consequence in plain language + scope}}</AlertDialogDescription>
      {{optional — InlineAlert tone=destructive for cascading effects}}
      {{optional — type-to-confirm input for TIER 2}}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant=destructive>{{exact verb}}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialog>
```

### 1.1 Three severity tiers

| Tier | Example | UI |
|---|---|---|
| **TIER 0 — reversible** | Archive member, deactivate plan | Inline button → toast "Archived. [Undo]" 10s window |
| **TIER 1 — confirm once** | Delete draft invoice, remove contact | AlertDialog, Cancel + destructive CTA; CTA disabled for 300ms to prevent accidental double-click |
| **TIER 2 — type-to-confirm** | Delete member + all history, cancel subscription with refund, revoke all sessions for tenant | AlertDialog + `<Input>` "Type DELETE to confirm" + destructive CTA disabled until input matches |

### 1.2 Microcopy rules

- Title names the object: "Delete invoice INV-2026-0042" — not "Are you sure?"
- Description states the **consequence** and the **scope** ("3 PDFs and all audit history will be removed. This cannot be undone.")
- CTA uses the **exact verb**: "Delete invoice", "Revoke access", "Issue refund" — never "OK" or "Confirm"
- For TIER 2, the confirmation token is the **literal action** in SCREAMING_SNAKE_CASE: DELETE / REVOKE / CANCEL

### 1.3 Accessibility

- AlertDialog traps focus; focus returns to the trigger on close
- CTA focused by default ONLY for TIER 0/1; TIER 2 focuses the type-to-confirm input first
- Screen readers hear title → description on open (`aria-describedby` wired by shadcn AlertDialog)
- Destructive CTA must carry `aria-describedby` pointing at the consequence description

---

## 2. Bulk Action

**When to use**: table/list surfaces where admins repeatedly act on the same type of object (members, invoices, contacts). Scale threshold: if ≥10% of daily work is one-at-a-time repetition, add bulk.

### 2.0 Canonical shape

```
[<FilterBar> with selection-aware <BulkActionBar> that appears on row selection]
  ↓
  <Checkbox> in header (select-all-visible vs select-all-matching)
  ↓
  <BulkActionBar> slides in sticky-bottom:
    "N selected"  [Clear]  [Action 1]  [Action 2]  [⋯ More]
  ↓
  For destructive bulk actions → route through pattern 1 (AlertDialog)
```

### 2.1 Select-all semantics

Two distinct affordances — do not conflate:

1. **Select all visible** (default checkbox in header) → selects only the currently rendered page. Counter shows "5 of 5 on this page selected".
2. **Select all matching** (secondary link in BulkActionBar) → explicit opt-in: "Select all 247 matching members". Counter shows "247 selected across all pages".

### 2.2 Progress + partial failure

Bulk operations MUST:

- Run server-side in a single transaction where possible (atomic) — Clean Architecture use case per action
- When partial failure is possible (e.g. bulk email send, bulk import), stream progress via `<Progress>` or `<ProgressBar>` and return a result summary: "189 succeeded · 3 failed · [Download error report CSV]"
- Use `<LiveRegion politeness="polite">` to announce progress milestones every 20% or every 5s (whichever is longer — avoid SR spam)
- On completion, dismiss the BulkActionBar and show a **single** toast — never per-item

### 2.3 Undo

- Bulk archive → Undo link in the completion toast (10s window, one-click restore all)
- Bulk delete TIER 2 → no Undo; state change is permanent
- Bulk status change → Undo link restores all previous statuses in one request

---

## 3. Multi-Step Wizard

**When to use**: flows where the user must complete ≥3 distinct decisions before any server-side effect, and branching logic depends on earlier answers (F5 PaySheet, F4 refund flow, onboarding).

**When NOT to use**: single-form-with-long-fields — use `<FormContainer>` + logical field grouping with `<Separator>` instead.

### 3.0 Canonical shape

```
┌───────────────────────────────────────────────┐
│  <Stepper>  1 ● ─ 2 ○ ─ 3 ○                   │
├───────────────────────────────────────────────┤
│  <StepHeading>Step 2 · Payment method</…>     │
│  <StepBody>{{one focused panel}}</StepBody>   │
├───────────────────────────────────────────────┤
│  [Cancel]            [← Back]  [Continue →]   │
└───────────────────────────────────────────────┘
```

### 3.1 Rules

- **≤5 steps.** More than 5 = the task is wrong-sized; split or remove.
- **One decision per step.** If two independent decisions sit side-by-side, they belong on one step with grouped fields; if they cascade, split.
- **No server effect until the final step.** Use client state. The last step's CTA label names the outcome: "Create invoice", "Issue refund", "Send invitation".
- **Review step.** Step N = read-only summary of every prior choice + edit links that jump back to the relevant step without losing data.
- **Persist progress** across reload when the wizard is long (>3 steps) or contains expensive work (file upload) — sessionStorage is fine for non-sensitive data; never persist PII.

### 3.2 Back + cancel semantics

- **Back** — preserves entered data on return
- **Cancel** — triggers pattern 4 (unsaved changes guard) if any field has been touched

### 3.3 Accessibility

- `<Stepper>` uses `aria-current="step"` on the active item (already wired in the primitive)
- Step heading is an `<h2>` so SR users can jump to it
- When advancing, focus moves to the step heading (NOT the first input) — SR announces heading; keyboard users can tab from there
- `<LiveRegion>` announces step transitions: "Step 2 of 4: Payment method"

---

## 4. Unsaved Changes Guard

**When to use**: any route or dialog where the user has mutable form state that would be lost on unmount / navigation.

### 4.0 Canonical shape

```
{{user clicks back / presses Esc / navigates}}
  ↓
  if (form.isDirty) {
    <AlertDialog>
      <AlertDialogTitle>Discard unsaved changes?</…>
      <AlertDialogDescription>Your changes to {{object}} will be lost.</…>
      <AlertDialogCancel>Keep editing</AlertDialogCancel>
      <AlertDialogAction variant=destructive>Discard changes</AlertDialogAction>
    </AlertDialog>
  } else {
    // navigate immediately, no prompt
  }
```

### 4.1 Rules

- Track dirty state via `form.formState.isDirty` (react-hook-form). Never guess via string comparison.
- Hook into three exits: **browser back/forward**, **in-app nav (`next/navigation`)**, **dialog close (Esc / backdrop / X button)**.
- The guard fires ONLY if dirty; no prompt on pristine forms (users hate false positives).
- Primary action = **Keep editing** (safe). Secondary = **Discard changes** (destructive).
- Never block the close with a modal that itself has a close button — the guard MUST be dismissable.

### 4.2 Autosave alternative

For long forms (wizard step, member edit), prefer autosave + `<LiveRegion>` "Saved · 2s ago" over an unsaved-changes prompt. Then the guard only fires for the narrow window between edit and autosave flush.

---

## 5. Export / Import (CSV)

**When to use**: bulk data interchange — admin exports members to CSV, imports a contact list, downloads a monthly invoice report.

### 5.0 Export canonical shape

```
[Export button in header overflow]
  → <Dropdown>
      ☐ Current page (N rows)
      ☐ All matching filters (M rows)
      ☐ Everything (K rows, no filters)
  → format: [CSV ▾] [Excel ▾] [JSON ▾]
  → [Download]
  ↓
  Server streams a signed URL; client triggers browser download
  ↓
  <Toast> "Exported 247 members to CSV. [Open]"
```

### 5.1 Export rules

- Filename: `{{tenant}}-{{entity}}-{{YYYYMMDD}}-{{HHmm}}.{{ext}}` — e.g. `swecham-members-20260424-1735.csv`
- Encoding: UTF-8 with BOM (for Excel compatibility on Windows)
- Dates: ISO 8601 in the payload, **never** Thai BE — UI formats on render
- Redaction: role=manager export redacts PII columns per Constitution Principle IV (PII minimisation)
- Audit: emit `{entity}_exported` audit event with row count + filter hash

### 5.2 Import canonical shape

```
Step 1 — <FileUpload> .csv / .xlsx (≤5 MB, ≤10k rows)
Step 2 — Column mapping: "Your column" → "Chamber-OS field"
Step 3 — Dry-run preview: "247 will be created · 12 updated · 3 errors [Download error report]"
Step 4 — Confirm (pattern 1 TIER 1) → streaming progress (pattern 2.2) → result toast
```

### 5.3 Import rules

- ALWAYS dry-run before commit; never apply changes from the upload step directly
- Surface every validation error with a row number and a human-readable reason
- Import is a TIER 1 destructive action (can create audit noise, duplicate rows) — confirm once
- Use `<Stepper>` (pattern 3) to structure the 4 steps
- Re-entry: if the user leaves after mapping, restore the mapping from sessionStorage so they can resume

---

## 6. Cross-references

- `docs/ux-standards.md` — §§ 2, 7, 15 (shimmer, focus, merge-gate checklist)
- `docs/shadcn-customizations.md` — primitive deviations
- `docs/design-system-audit.md` — the 19-gap backlog that surfaced this doc
- `src/components/ui/stepper.tsx` — wizard primitive
- `src/components/ui/progress.tsx` / `progress-bar.tsx` — bulk progress
- `src/components/ui/inline-alert.tsx` — in-step cascading-effect warning
- `src/components/ui/live-region.tsx` — step / progress SR announcements
- `src/components/ui/status-badge.tsx` — per-row state in bulk tables

---

## 7. Contributing

When a new pattern recurs ≥2 features, land it here before the second use. Template:

```
## N. Pattern name

**When to use / When NOT to use**
### N.0 Canonical shape (ASCII diagram)
### N.1 Rules (bullet list)
### N.2 Accessibility
### N.3 Microcopy
```

Open questions or proposed patterns not yet accepted → file under `docs/ux-research/` with a linked RFC before adding here.
