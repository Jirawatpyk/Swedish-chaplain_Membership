# Chamber-OS Code Conventions

This document captures the conventions that **survive across features and refactors**, supplementing — not duplicating — the authoritative sources:

- `.specify/memory/constitution.md` — the 10 principles + quality gates (governance)
- `CLAUDE.md` — Spec Kit workflow, tech-stack lock-ins, secrets policy
- `docs/ux-standards.md` — enterprise UX playbook
- `docs/shadcn-customizations.md` — primitive modifications
- `docs/observability.md` — SLOs, metrics, alerts, runbooks

Use this doc for **cross-cutting code-style + comment + naming conventions** that recur in PRs and reviews and that we want to standardise to reduce review-cycle friction.

**Last updated**: 2026-05-16 (added Review-Tag Rot Policy per F6 Phase 9 staff-review R-S04).

---

## 1. Review-Tag Rot Policy

### Problem

Through a Spec Kit feature's `/speckit-review` cycles (typically 3 rounds + a deferred-closure batch), reviewers leave inline comments tagged with the round + finding ID, e.g.:

```ts
// Round-2 code-H1 closure — verify URL path's eventId matches…
// Round-1 ux-H3 — server 409 `event_archived` reason → localised…
// Round-3 type-M — zod schema with `.uuid()` runtime-validates server response…
```

These tags are excellent **forensic provenance during the active review cycle** — they let the next reviewer instantly cross-reference a code change with the report that motivated it. But they **rot quickly once the feature ships**:

- Future readers no longer have ready access to the review reports
- A refactor that touches the tagged section leaves the tag pointing at unrelated code
- Tag-IDs (`code-H1`, `type-M`, `ux-H3`) are opaque to anyone who did not live the review cycle

### Policy

**During an active feature branch** (pre-`/speckit-ship`): inline review tags are **encouraged**. They are the lingua franca of the round-by-round review process; stripping them mid-cycle makes it harder for the next reviewer to verify that a finding has been addressed.

**Before `/speckit-ship`** (e.g., during a `/speckit.simplify` pass or the final `/speckit-verify-run` checklist sweep): inline review tags should be **trimmed or rewritten**, following these rules:

1. **If the tag still labels a *decision* whose rationale would be lost without it** — rewrite the tag to describe the *why*, not the *review ID*. The decision survives; the bureaucratic provenance goes.

   ```ts
   // BEFORE (rots):
   // Round-2 code-H1 closure — verify URL path's eventId matches…

   // AFTER (survives):
   // Path-eventId guard — refuse BEFORE any mutation so a misrouted URL
   // cannot leave partial state committed. (Earlier post-commit check was a
   // silent-success bug — see specs/.../reviews/review-…md § Round-2 H1.)
   ```

2. **If the tag labels a *change that is now self-evident*** (e.g., the code reads correctly without further explanation) — delete the tag entirely.

   ```ts
   // BEFORE (noise):
   // Round-1 err-M5 — typed 500 instead of unhandled rejection
   try { … } catch (e) { return 500 + structured-log }

   // AFTER:
   try { … } catch (e) { return 500 + structured-log }
   ```

3. **If the file has a *Review-fix log* in its header docblock** (e.g., 16-entry table mapping `Round-N X-Y` tags to plain-English descriptions) — keep the header table during active development, but during the pre-ship trim pass either:
   - **Distil** it down to the 2-3 decisions whose *why* is non-obvious (and rewrite per rule 1), OR
   - **Move** the full table into `specs/<feature>/reviews/README.md` so the file gets clean and the provenance stays addressable from one canonical location.

4. **Always preserve** the link from in-code comments back to the spec / FR identifier (`FR-014`, `SC-002`, `Principle I sub-clause 3`). Those identifiers are **stable** across review cycles and are looked up against `spec.md` + `constitution.md`, both of which live forever.

### Why not just keep all the tags forever?

Three reasons:

- **Tag opacity to new contributors**: `Round-2 code-H1` means nothing to a teammate joining six months after ship. `path-eventId guard prevents silent-success on misrouted URLs` is timeless.
- **Refactor drift**: a tag-anchored comment that gets cut-and-pasted during a refactor now points at the wrong line of the wrong file. The *why* it captured is gone too if the tag was the only explanation.
- **Review-cycle fatigue**: when every code change carries 3-5 review tags, the signal/noise ratio for new comments collapses. Future reviewers skim past `Round-2 code-H1` because they assume "already-reviewed" — even if the surrounding code has since changed.

### Applies to all features

This policy applies to **every** Spec Kit feature from this point forward (F6 onwards). Earlier features (F1-F5, F7, F8) carry review tags as historical artefacts; we do not retroactively trim them, but new edits to those files SHOULD follow rule 1 (rewrite tags to capture the *why*).

---

## 2. Comment-Anchor Citation Pattern

When one piece of code refers to another file/function/section, prefer **section anchors** over line numbers:

```ts
// GOOD — survives refactor:
// Mirrors archive-event's `ORDER BY matched_member_id ASC` invariant
// at `archive-event.ts § "Sorted-key lock acquisition"`.

// BAD — rots on next edit:
// Mirrors archive-event.ts:46-52.
```

When you write such an anchor:

1. Make sure the **target file** actually contains a banner comment matching the anchor text. If it doesn't, add one in the same PR.
2. Prefer the function name or a 2-4 word topic tag as the anchor — never a sentence.
3. Anchors are not formal; you don't need a tool to validate them. The rule is just "search-friendly + survives line-number drift."

---

## 3. Brand-Boundary Comment Convention

Smart constructors that wrap an untrusted string into a branded type (`asEventId`, `asUserId`, `asTenantId`, …) live in the Domain layer with **length-only validation**. The *source* of the trust must be documented at the call site:

```ts
const eventId = asEventId(eventIdFromPath); // brand-boundary: UUID_V4 regex at path-param check above
const memberId = asMemberId(parsed.data.newMatchedMemberId); // brand-boundary: zod UUID_V4 refine at BodySchema definition
```

This makes it trivial for a reviewer to verify that **every untrusted input becomes a brand only after passing a real validator** — without having to chase the chain across files.

When the source is a tool that already returns the brand (e.g., `adminOnlyWriterGuard` returns `UserId`), no `// brand-boundary:` comment is required — the type IS the proof.

---

## 4. Result<T, E> vs. throw

- **Application layer (`src/modules/*/application/`)**: every fallible operation returns `Result<T, E>`. Never throw from a use-case. The discriminated-union error type is part of the use-case's public contract.
- **Infrastructure layer (`src/modules/*/infrastructure/`)**: may throw at the boundary with external systems (pg-driver, Stripe SDK, Resend SDK) but adapters catch + wrap into `Result<T, RepoError>` before returning to Application.
- **Domain layer (`src/modules/*/domain/`)**: pure functions — no Result, no throw. Invariants are enforced by branded types + the type system.
- **Presentation layer (route handlers / server actions / client components)**: handles `Result.err` via discriminator exhaustive `switch` + `const _exhaustive: never = result.error`. A throw escaping a use-case is a bug + reaches the 500 catch-all.

The `runInTenantWithRollbackOnErr` wrapper (see `src/lib/events-admin-deps.ts`) bridges Application Result.err → tx throw → DB rollback. Use it for any use-case that mutates more than one row.

---

## 5. Named Constants Over Magic Literals

If the literal carries a **semantic meaning** that is not obvious from context, extract it into a named const with a doc comment explaining the why:

```ts
// GOOD:
export const F6_FISCAL_YEAR_START_MONTH = 1 as const;
// (doc explains: F6 anchors to calendar year per FR-016, NOT tenant fiscal year)
deriveFiscalYear(event.startDate.toISOString(), F6_FISCAL_YEAR_START_MONTH);

// BAD:
deriveFiscalYear(event.startDate.toISOString(), 1);
// (1 = ? January? An option? A flag?)
```

Bool literals, array indexes, and obvious unit conversions (`60_000` for "one minute in ms" with a `_` separator) are exempt.

Pin literal types with `as const` where downstream APIs require literal-type narrowing (e.g., union types like `FiscalYearStartMonth = 1 | 2 | … | 12`) — saves an explicit cast at every call site.

---

## 6. ESLint Disables Must Carry a Reason

`// eslint-disable-next-line` / `// eslint-disable` SHALL include the rule name and a one-sentence rationale linking to the precedent that legitimises the suppression:

```ts
// eslint-disable-next-line react-hooks/set-state-in-effect -- spinner must flip
// synchronously for immediate user feedback (mirrors
// bundle-change-warning-dialog.tsx:51-77 precedent).
useEffect(() => { setLoading(true); … }, [query]);
```

A bare `eslint-disable` with no reason is treated as a finding at the next code review.

---

## 7. Sources & Cross-References

- Review-tag rot policy precedent: F6 Phase 9 staff-review review-20260516-155013.md R-S04
- Comment-anchor pattern: F6 Phase 9 Round-2 comments-M2 closure
- Brand-boundary pattern: F6 Phase 9 Round-1 + Round-2 type-H2 closures
- Named-constants precedent: F6 Phase 9 staff-review R-S03 (`F6_FISCAL_YEAR_START_MONTH`)
