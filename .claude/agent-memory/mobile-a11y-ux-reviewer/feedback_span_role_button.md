---
name: Avoid span role=button — use native button
description: Chamber-OS codebase anti-pattern: using <span role="button"> instead of <button> for interactive clear/icon controls
type: feedback
---

Never use `<span role="button" tabIndex={0}>` for interactive controls in this codebase.

**Why:** Native `<button>` gives implicit ARIA role, handles Enter/Space natively via browser, correct focus management, and correct TypeScript type for `useRef<HTMLButtonElement>`. A `span` with `role="button"` requires manual `onKeyDown` for Enter/Space, and a `useRef<HTMLButtonElement>` pointing at a `<span>` is a TypeScript type mismatch. Found in MemberPicker clear button (PR #008-invite-link-member, fixed in 09cb398).

**How to apply:** When reviewing any component that has an icon-only or inline interactive element, check that it uses a real `<button type="button">` not a `<span>` or `<div>` with `role="button"`. Flag as a Blocker (WCAG 4.1.2).
