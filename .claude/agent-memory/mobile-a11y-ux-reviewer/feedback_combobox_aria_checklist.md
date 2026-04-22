---
name: Combobox ARIA required attributes checklist
description: Canonical set of ARIA attributes required on every cmdk+Popover combobox trigger in Chamber-OS
type: feedback
---

Every `role="combobox"` trigger in Chamber-OS (cmdk inside Popover) must carry ALL of these:

1. `role="combobox"` — on the trigger button
2. `aria-expanded={open}` — boolean, not string
3. `aria-haspopup="listbox"` — NOT just `"true"`; must specify listbox
4. `aria-controls` — must point to the `CommandList` element id (the listbox), NOT the `CommandInput` id
5. `aria-labelledby` — id of the visible `<Label>` above the picker
6. `aria-describedby` — when disabled, point to an `sr-only` hint span (NOT rely on visible placeholder text inside trigger)

**Why:** Missing `aria-haspopup` and wrong `aria-controls` target are common in cmdk-based pickers and both fail WCAG 4.1.2 Name, Role, Value. Found missing in MemberPicker, fixed in commit 09cb398.

**How to apply:** Use as a literal checklist when reviewing any Popover+cmdk combobox. All 6 must be present or it is a Blocker.
