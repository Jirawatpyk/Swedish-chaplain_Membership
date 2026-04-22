---
name: 008 Invite-Link-Member UX Patterns
description: Key UX findings from 008-invite-link-member review — MemberPicker aria wiring, i18n copy patterns, disabled-state SR double-announce
type: project
---

MemberPicker combobox shipped in 008 with known follow-up items.

**Why:** Review of invite-user-dialog + member-picker revealed 3 apply-now fixes and 4 flagged follow-ups.

**How to apply:** When reviewing any future combobox-in-dialog pattern, check these same failure modes.

## Fixed in commit 31c4a64

- `aria-describedby` prop added to `MemberPickerProps` — callers must pass the external help-text paragraph ID when picker is enabled; disabled state uses its own internal `disabledHintId` instead
- Disabled trigger was rendering `disabledHint` in both the visible button text AND a `sr-only` span — fixed by showing placeholder text in button, letting sr-only span carry the hint
- i18n copy: "record" (DB jargon) removed from all 3 locales; "member company" preferred over "member" for label to distinguish org vs user-member
- `noMembersFound`: all 3 locales now include a search-hint sub-sentence per § 3.1

## Pending follow-ups (not in this commit)

- 🔴 E9: `opt.status` in CommandItem renders raw enum — use `admin.members.directory.filters.status.*` i18n keys
- 🟡 E2: `/api/members?q=` query should default `status=active` filter — 5000+ members in search with no filter = hard to find archived ones polluting results  
- 🟡 IA B-shortcut: `/admin/members/[id]` should have "Invite user…" action that pre-fills memberId in InviteUserDialog
- 🟡 E5: Popover-in-Dialog on mobile < 640px — Base UI portal renders outside Dialog; needs manual QA on iOS Safari

## Catalogue decisions

- Smart Feature #4 (Command Palette): MemberPicker uses cmdk CommandInput but does NOT auto-focus CommandInput on popover open — add `autoFocus` on CommandInput when open=true
- Smart Feature #2 (At-Risk): API returns `status` field; `risk_score` not yet returned — could add inactive indicator as low-lift at-risk hint in picker rows (F8 work)
- New proposal: "Email already exists as contact on member X — link to existing?" inline suggestion — not in 21-item catalogue, flag before implementing
