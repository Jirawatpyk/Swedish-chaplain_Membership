# Comprehensive Requirements Quality Checklist: F1 Auth & RBAC

**Purpose**: Unit tests for the F1 specification — validates that requirements
are complete, clear, consistent, measurable, and cover all scenarios. This
is NOT a test of the implementation; it is a test of whether the written
requirements are ready for implementation.

**Scope**: Combined coverage — Security + UX + Privacy + Audit + cross-cutting
requirement quality. Single file per user request (`Q1 = H`).

**Depth**: Standard (~28 items) — sized for PR review gate use.

**Audience**: Peer reviewer at PR time. Security-sensitive items ARE included
because F1 is governed by Constitution Principle I (NON-NEGOTIABLE) and normally
requires ≥2 reviewers per Constitution Principle IX / Gate 9. SweCham is a
solo-dev project at the F1 ship point, so F1 uses the **solo-maintainer
substitute clause** introduced in Constitution v1.3.0 (5 independent automated
checks — see `plan.md` § Complexity Tracking entry #3 and `security.md § 5`
sign-off block for the full deviation record). This checklist itself counts as
part of check #1 of the substitute (multiple automated review passes).

**Created**: 2026-04-09
**Feature**: [spec.md](../spec.md)
**Related**: [plan.md](../plan.md), [research.md](../research.md),
[security.md](../security.md), [`docs/ux-standards.md`](../../../docs/ux-standards.md)

**How to use**: During PR review, walk through each item and tick the box
if the requirement quality passes. Items marked `[Gap]` are flagged as
probably missing; if you tick them, you've confirmed the requirement IS
present (and you should leave a PR comment with the location). Items with
`[Spec §X]` traceability reference the specific section being validated —
open spec.md to that section to verify.

**Walk completed: 2026-04-09** — all 28 items evaluated. Real gaps were
fixed in-session (see `fix` annotations). Ticks below reflect the final
post-fix state.

---

## Requirement Completeness

- [x] CHK001 - Are all three user roles (`admin`, `manager`, `member`) defined with their exact permission boundaries and portal assignments? [Completeness, Spec §Clarifications Q4 + §Key Entities → Role] — ✅ PASS
- [x] CHK002 - Are all 16 audit event types enumerated with their trigger conditions and the actor/target identities in every case? [Completeness, Spec §User Story 7 scenario 1] — ✅ PASS
- [x] CHK003 - Are all email-dependent flows (password reset, invitation) specified with the resend affordance requirement and the webhook-driven delivery failure handling? [Completeness, Spec §FR-025 + research §6.1] — ✅ PASS
- [x] CHK004 - Is the bootstrap admin procedure stated at the requirement level (how the FIRST admin account ever comes into existence), or is it only described as an implementation detail in research.md? [Completeness, Gap, Spec §Assumptions "Bootstrap admin"] — ⚠ **INTENTIONAL** (spec §Assumptions explicitly defers to Plan phase; research §12 has the detail). Accepted as a deliberate boundary.
- [x] CHK005 - Are all session-termination triggers fully enumerated (sign-out, password change, role change, disable, idle, absolute, admin-force) AND mapped to corresponding audit events? [Completeness, Spec §FR-008 ↔ §User Story 7] — ✅ PASS (idle/absolute explicitly NOT audited with justification)
- [x] CHK006 - Is the PII inventory (email, IP, display name, hashed password, timestamps, source IP in audit log) explicitly documented in the spec, or only derivable from the data model? [Completeness, Gap at spec level] — ⚠ **INTENTIONAL** (spec FR-018 names the main PII fields inline; full inventory is in data-model.md § 7). Accepted — dedicated §PII subsection would be duplication.

## Requirement Clarity

- [x] CHK007 - Are ALL session-related thresholds stated as concrete numeric values — idle TTL 30 min, absolute TTL 12 h, lockout 5 attempts / 15 min, reset token 1 h, invitation token 7 days — and NOT as words like "reasonable", "short-lived", or "appropriate"? [Clarity, Spec §FR-005, §FR-008, §FR-009, §FR-013, §Resolved Clarifications Q3] — ✅ PASS
- [x] CHK008 - Is "read-only across every module" for the `manager` role defined precisely enough that a developer can decide, for any given endpoint, whether a manager is allowed to call it? [Clarity, Spec §Clarifications Q4] — ✅ PASS
- [x] CHK009 - Is "skeleton shimmer" in FR-020 specified with measurable visual properties (animation duration, colours, reduced-motion fallback), or does the spec rely entirely on the `docs/ux-standards.md` cross-reference without restating the measurable properties? [Clarity, Spec §FR-020 vs docs/ux-standards.md § 2.1] — ⚠ **INTENTIONAL** (spec FR-020 references ux-standards §2.1 for the canonical pattern; spec level keeps requirement, implementation in standards doc)
- [x] CHK010 - Is "destructive action" in FR-021 enumerated (disable, enable, change role — for F1) so that a reviewer can detect a missing confirmation dialog by inspection? [Clarity, Spec §FR-021] — ✅ PASS
- [x] CHK011 - Is the member portal placeholder landing page's content specified precisely enough that two designers given only the spec would produce equivalent layouts? [Clarity, Spec §User Story 5 scope decision + plan.md project structure roadmap] — ⚠ **INTENTIONAL** (spec describes scope/purpose; plan.md project structure has the 4-item roadmap detail)
- [x] CHK012 - Is "primary input" (the element that receives auto-focus per FR-024) defined for each auth screen — email field on sign-in, new password field on reset, etc.? [Ambiguity, Spec §FR-024] — ✅ **FIXED (G1)** — FR-024 now includes an explicit per-screen table mapping every auth screen to its primary input; on-error focus behaviour also specified.

## Requirement Consistency

- [x] CHK013 - Is the "at least one active admin always exists" rule (FR-011) consistent with the role-change rule (FR-010) and the self-service change-password rule (FR-019) — no edge case lets the admin count go to zero? [Consistency, Spec §FR-010 ∧ §FR-011 ∧ §FR-019] — ✅ **FIXED (G2)** — Edge Cases now includes the concurrent "last-admin" race with `SELECT FOR UPDATE` requirement
- [x] CHK014 - Do the i18n coverage rules match between spec (EN fails build, TH/SV warning per FR-014) and `docs/ux-standards.md` (three locales mandatory at release per § 12)? If they differ, is the stricter rule the one that applies? [Consistency, Spec §FR-014 ↔ ux-standards.md § 12] — ✅ **FIXED (G3)** — FR-014 now explicitly states precedence: ux-standards § 12 is stricter and wins at release; fallback applies only to dev/preview
- [x] CHK015 - Does every Functional Requirement (FR-001 through FR-025) have at least one corresponding Success Criterion (SC-001 through SC-017) that can verify it? If not, list the unmeasured FRs as gaps. [Consistency / Coverage, Spec §Functional Requirements ↔ §Success Criteria] — ✅ **FIXED (G4)** — Added SC-018 (FR-006/007), SC-019 (FR-016), SC-020 (FR-017), SC-021 (FR-019), SC-022 (FR-024)
- [x] CHK016 - Is the term "staff portal" vs "member portal" vs "member" (the role) used consistently throughout the spec, with no conflation between "a member user" and "the Member entity from F3"? [Consistency, Spec throughout] — ✅ PASS

## Acceptance Criteria Quality (Measurability)

- [x] CHK017 - Can SC-003 ("zero authorised-access violations") be verified by a deterministic automated test that enumerates every role × route combination, without requiring human judgement? [Measurability, Spec §SC-003] — ✅ PASS
- [x] CHK018 - Can SC-007 ("every user-facing string has a translation in EN/TH/SV") be verified by a static CI check (e.g., `scripts/check-i18n-coverage.ts`), and is the check's failure mode specified? [Measurability, Spec §SC-007] — ✅ PASS
- [x] CHK019 - Can SC-012 ("CLS remains 0.00 during skeleton → loaded transition") be measured by Lighthouse CI automatically, and does the spec state the measurement tool? [Measurability, Spec §SC-012] — ✅ PASS
- [x] CHK020 - Is SC-002 ("99% of reset emails arrive within 60 seconds") defined precisely enough that the monitoring system knows (a) how to measure "arrived", (b) over what time window, and (c) how bounces count? [Measurability, Spec §SC-002 + research §6.1] — ⚠ **MINOR** (research §6.1 defines "arrived" = Resend webhook `email.delivered`; spec could tighten but not blocking). Deferred to implementation.

## Scenario Coverage

- [x] CHK021 - Are requirements defined for the concurrent edge case where two admins try to demote the SAME third admin at the same time (race between two legitimate writes, not just self-demote)? [Coverage, Spec §User Story 4 scenario 5 + security.md T-10] — ✅ **FIXED (G2)** — same edit as CHK013
- [x] CHK022 - Are requirements defined for the scenario where a password reset email bounces (webhook reports `email.bounced`) — what does the user see on the waiting screen, and what does the operator see in alerts? [Coverage, Spec §FR-025 + research §6.1] — ✅ PASS
- [x] CHK023 - Are requirements defined for the edge case of a role change happening WHILE the affected user is in the middle of a multi-step flow (e.g., a form with unsaved data), and is data loss acknowledged? [Coverage, Gap, Spec §Edge Cases "Role change during active session"] — ✅ **FIXED (G5)** — Edge Cases now has a dedicated "Role change during a multi-step form" entry with the deliberate-trade-off rationale
- [x] CHK024 - Are requirements defined for the scenario where the rate-limit provider (Upstash) is unreachable — fail-open or fail-closed, and what is the in-memory fallback limit? [Coverage, Spec §FR-013 vs research §5 "Upstash outage behaviour"] — ⚠ **INTENTIONAL** (research §5 covers the fail-open + in-memory fallback; spec level says "resist brute force" and research documents the provider-outage contingency)

## Non-Functional Requirements

- [x] CHK025 - Are security requirements currently in research.md (CSRF Origin-check, timing-constant verify via dummy hash, HIBP breach check) represented at the spec level as testable FRs, or only buried in research.md and security.md? If only in research, is that the deliberate boundary? [Completeness, Spec §FR-013 vs research §4.1 + security.md T-03 / T-11] — ⚠ **INTENTIONAL** (spec says WHAT: "resist brute force and enumeration attacks"; research/security say HOW: CSRF Origin check, dummy-hash timing, HIBP). Boundary accepted; SC-019 now provides a measurable test hook for the timing-constant behaviour.
- [x] CHK026 - Are privacy requirements (PDPA + GDPR data subject rights) stated as user-facing obligations in the spec (what the USER can ask for), not just as an implementation assumption ("will be implementable without code changes")? [Clarity, Spec §FR-018] — ✅ **FIXED (G6)** — FR-018 now enumerates all six GDPR rights (access, rectification, erasure, portability, restriction, objection) + PDPA equivalents
- [x] CHK027 - Are audit retention requirements (≥5 years, append-only, immutability via DB grants) specified as observable constraints in the spec, or only as an implementation choice in data-model.md? [Completeness, Spec §FR-012 + §SC-011 vs data-model.md § 7.1] — ✅ PASS

## Dependencies & Cross-References

- [x] CHK028 - Does the spec explicitly declare its dependencies on the supporting documents (`docs/ux-standards.md`, `docs/observability.md`, `security.md`, `research.md`), so a PR reviewer knows which files to cross-check for FR-020 through FR-025 + SC-012 through SC-017? [Traceability, Spec §FR-020 through §FR-025 in-line links] — ⚠ **MINOR** (spec has inline ux-standards.md links in FR-020 through FR-024; observability.md and security.md are linked from plan.md rather than spec.md). Deferred — plan.md is the central navigation hub.

---

## Usage notes

- Total items: **28** (target 25-30 for Standard depth — met)
- Traceability references: **≥23/28** have `[Spec §X]` or related source reference (requirement ≥80% met)
- Every item asks about requirement **quality** (completeness / clarity / consistency / measurability / coverage), NOT about implementation behaviour.
- `[Gap]` marker indicates an item where the reviewer is specifically checking whether a requirement that SHOULD exist is actually present in the spec.
- Sibling checklists in `checklists/` directory:
  - `requirements.md` — spec-quality checklist produced by `/speckit.specify` (complementary; focuses on template-level completeness)
  - This file — domain-specific requirement quality for security + UX + privacy + audit

- Check items off as completed: `[x]`
- Leave PR comments inline when a box cannot be ticked
- Items numbered sequentially within this file (CHK001–CHK028)
