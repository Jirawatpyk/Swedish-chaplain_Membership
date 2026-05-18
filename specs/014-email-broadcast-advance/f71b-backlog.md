# F7.1b Backlog — Deferred from F7.1a per Strategy B (Critique 2026-05-18)

**Status**: Backlog — re-spec'd into a new feature branch when promoted.
**Trigger to promote**: 4-6 weeks of F7 MVP + F7.1a production data showing tenant demand for any of these capabilities.
**Source**: Original F7.1 spec (8 USs) split by Strategy B decision per `critiques/critique-20260518-003047.md` § Verdict.

**Update 2026-05-18**: US7 (Multi-template library) was promoted BACK into F7.1a after maintainer committed to writing starter content directly (no compliance-liaison-blocker). The US7 section in this document is preserved BELOW as historical reference but the work has moved to F7.1a's `spec.md § US7` + `starter-templates.md`.

---

## Why deferred

Strategy B (chosen by maintainer) splits the original F7.1 8-US bundle into:
- **F7.1a** (active): US1 (50k pagination) + US2 (image embedding with allowlist) — both P1 priorities with clear evidence of need.
- **F7.1b** (this backlog): US3, US4, US5, US6, US8 — wait for production data from F7 MVP + F7.1a before committing engineering. (US7 was originally deferred here but promoted back to F7.1a on 2026-05-18 — see Update note above.)

Rationale (from critique P1, X1):
- F7 MVP shipped 2026-05-03; F7.1 spec'd 2026-05-17 — only 15 days of production data
- No signal on whether members hit the 5,000-recipient cap, complain about missing images, want attachments, etc.
- 8-US bundle commits ~250 tasks before any feedback loop closes → risk of building features no one uses
- US5 specifically: low product value (default OFF, opt-in) AND high engineering complexity → worst value:effort in the portfolio

---

## Promotion criteria (per-US)

| US | Promote to F7.1b when |
|----|----------------------|
| **US3** (Per-contact opt-in) | ≥1 chamber admin requests it OR ≥3 unsubscribe complaints cite "wrong contact at company" |
| **US4** (Attachments) | ≥5 events/quarter where chamber events team asks "can I attach the agenda?" |
| **US5** (Open/click tracking) | ≥1 chamber's board demands "show me what worked" |
| **US6** (Saved segments) | First tenant onboards with >1000 members AND uses ≥4 distinct segment patterns |
| ~~US7~~ | ~~Promoted to F7.1a 2026-05-18~~ |
| **US8** (PII scanner) | Compliance officer audit finds ≥1 broadcast leaked PII to recipients |

---

## US3 — Per-Contact Opt-In (Priority: P2)

**Original placement**: F7.1 US3.
**Why P2**: Improves authoring + GDPR/PDPA story but doesn't unblock new tenants.

A member company often has multiple contacts in F3 (e.g., CEO, CFO, marketing lead). F7 MVP only sends to each company's `primary_contact_email`, so secondary contacts never receive the chamber's E-Blasts. US3 adds a per-contact `receive_broadcasts` opt-in flag (default OFF, member-managed via portal).

**Key FRs preserved for re-spec**:
- F3 `contacts.receive_broadcasts` boolean (default FALSE for new contacts post-ship; backfill TRUE for existing primary contacts at ship time per Clarifications round-2 Q5)
- Segment resolver gates ALL contacts (primary + secondary) by the flag
- Self-exclusion extends from member to all of their contacts
- Member portal toggle UI + admin member-detail view
- One-click unsubscribe also flips flag (defence in depth)

**Critical note for re-spec**: Per critique E13, the migration backfill needs **chunked-row strategy** (NOT single-tx UPDATE) to support tenants >10k members.

---

## US4 — Attachments (Priority: P2)

**Original placement**: F7.1 US4.
**Why P2**: Common chamber use case (PDF agenda) but recipient experience equivalent to "link to chamber asset bucket" (critique X4).

Chambers often need to attach a PDF agenda, sponsorship deck, or event flyer to an E-Blast. F7 MVP forbids attachments. US4 supports up to 10 files per broadcast (25 MB combined) via Vercel Blob + ClamAV scanning.

**Key FRs preserved for re-spec**:
- 10 files / 25 MB combined cap per Clarifications round-1 Q4
- Strict MIME allowlist: PDF, image, Office documents, plain text
- Forbidden: executables, HTML, scripts, archives (no recursive scan)
- Scan via self-hosted ClamAV (same scanner as US2 in F7.1a)
- 5-minute scan timeout per FR-027
- Co-terminate retention with broadcast row per Clarifications round-2 Q3
- Content-hash dedup per tenant

**Critical note for re-spec**: Per critique X4 / P8, evaluate **"link to asset bucket" alternative** (member uploads to chamber bucket; email contains link, not MIME attachment). Saves significant engineering surface.

---

## US5 — Engagement Tracking (Priority: P3)

**Original placement**: F7.1 US5.
**Why X1 deferred**: Low product value (default OFF, opt-in) + high engineering complexity. Worst value:effort ratio.

Per-tenant opt-in for open + click tracking. Two independent toggles per Clarifications round-1 Q5.

**Key FRs preserved for re-spec**:
- Two independent toggles: `broadcast_open_tracking_enabled` + `broadcast_click_tracking_enabled` (both default OFF)
- Open-tracking is privacy-fraught (silent pixel fire); click-tracking acceptable under GDPR Art. 6(1)(f) legitimate interest (explicit click = consent)
- Aggregated counts only — NO per-recipient surface
- 90-day retention on per-recipient event data
- Per-link breakdown shown to admin (per Clarifications round-2 Q4)
- Unique recipient-link click semantics (exclude unsubscribe link, include img-wrapped clicks)
- Webhook ingestion at scale needs async queue / batch INSERT (critique E3)

**Critical note for re-spec**: Per critique X1, US5 may never see adoption at chamber scale. Re-evaluate need before re-speccing.

---

## US6 — Saved Segments (Priority: P3)

**Original placement**: F7.1 US6.
**Why P2 deferred**: SweCham scale (131 members) likely zero adoption (critique P7).

Admin authoring of saved segments composed of 1-4 AND-only filter rows (tier, status, country, joined_at, last_renewed_at).

**Key FRs preserved for re-spec**:
- Tenant-scoped, admin-named, 1-4 filter rows (AND-only — full visual query-builder is F7.2+)
- Field allowlist: tier (in/not_in), status (in/not_in), country (in/not_in), joined_at (>=/<=/between), last_renewed_at (>=/<=)
- Preview count ≤2s p95 at 10k members
- Cannot delete/rename while referenced by in-flight broadcast
- Reuse F7 MVP downstream rules (dedup + suppression + self-exclude)

**Critical note for re-spec**: Per critique E9, needs **compound index `contacts(tenant_id, receive_broadcasts, member_id) WHERE receive_broadcasts = true`** to hit ≤2s p95. Depends on US3 schema (`receive_broadcasts` column) → spec US3 + US6 together.

---

## US7 — Multi-Template Library (Priority: P2) — PROMOTED BACK TO F7.1a

**Status**: ✅ **Promoted to F7.1a on 2026-05-18** — maintainer wrote 5 starter templates × 3 locales directly (see `starter-templates.md`); compliance-liaison content review deferred to post-ship admin refinement (admins edit via FR-016 template-CRUD UI). The Original placement / Why deferred / FRs / Critical note sections below are HISTORICAL — see `spec.md § US7` for the active spec and `starter-templates.md` for the seeded content.

**Original placement**: F7.1 US7 (promoted from "Out of Scope" mid-spec discussion).
**Why P2 originally deferred (no longer applies)**: Per critique P4, US7 needs starter library content (compliance liaison review) to deliver value; engineering is cheap but content is the bottleneck. RESOLVED 2026-05-18: maintainer authored content directly.

Admin-authored templates (NOT member-authored in this scope) with snapshot semantics (template edit doesn't mutate drafts already started from it).

**Key FRs preserved for re-spec**:
- Admin CRUD on templates; tenant-scoped name uniqueness
- Snapshot at draft-start time; subsequent template edits don't propagate
- Template body subject to F7 MVP sanitiser + F7.1a image-source allowlist (US2)
- Audit events: `broadcast_template_created/updated/deleted`
- `started_from_template_id` on broadcast audit row for analytics
- Migration seeds 3-5 starter templates per tenant (per critique P4) — content authored by compliance liaison

**Critical note for re-spec**: Bundle US7 with starter-template content production. Empty library = zero adoption.

---

## US8 — Pre-Submit PII Detector (Priority: P2)

**Original placement**: F7.1 US8 (promoted from "Out of Scope" — compliance-driven).
**Why P2 deferred**: Per critique P6, warning fatigue risk if FP rate ≥5% — defeats purpose; needs longer baseline observation before committing.

Deterministic versioned pattern detector for Thai national ID, Swedish personnummer, phones, credit cards, IBAN, email-flooding. Soft warning + member ack-and-send + admin acknowledgement checkbox.

**Key FRs preserved for re-spec**:
- Pattern set v1.0: 8 pattern types (Thai ID Mod 11, Swedish personnummer Luhn, Thai/Swedish/EU phones, credit card Luhn, IBAN MOD-97, email flooding)
- Soft warning + two-click "Submit anyway" (no auto-block)
- Admin approve guard: PII-flagged broadcast requires admin acknowledgement checkbox (per Clarifications round-1 Q3 / FR-063)
- Silent-audit invariant: detector ALWAYS runs + audit event ALWAYS emitted regardless of UI warning toggle
- Raw matched values NEVER persist — only redacted previews + counts
- Detector version pinned for forensic determinism
- Two-layer testing: fast-check property + labelled-fixture acceptance (per critique H5)
- Latency ≤300ms p95 for 200 KB body

**Critical note for re-spec**: Per critique P6, add admin dashboard tile "warning shown / acked" rate; trigger pattern-version review when rate >50%.

---

## Reusable artefacts from current F7.1 work

When F7.1b is promoted, these can be lifted directly:
- `contracts/deferred-f71b/contact-broadcast-opt-in.md` — US3
- `contracts/deferred-f71b/broadcast-attachment.md` — US4
- `contracts/deferred-f71b/tracking-settings.md` — US5
- `contracts/deferred-f71b/saved-segment.md` — US6
- ~~`contracts/deferred-f71b/broadcast-template.md` — US7~~ (no longer in deferred-f71b/; moved back to `contracts/broadcast-template.md` per F7.1a promotion 2026-05-18)
- `contracts/deferred-f71b/pii-detector.md` — US8

All 10 Clarifications resolutions (2 sessions, 2026-05-17) preserved in `spec.md § Clarifications` — re-applicable on US3-US8 re-spec.

---

## Critique findings still pending (for F7.1b re-spec)

From `critiques/critique-20260518-003047.md` — items that apply to US3-US8 only:

| ID | Severity | Applies to | Finding |
|----|----------|-----------|---------|
| E13 | 🎯 | US3 | F3 backfill scale ceiling — needs chunked migration |
| P4 | 💡 | US7 | Seed 3-5 starter templates (not just 1) |
| P5 | 💡 | US3 | Primary contact on member-create defaults TRUE |
| P6 | 💡 | US8 | Warning fatigue measurement + admin dashboard tile |
| P7 | 💡 | US6 | Likely zero adoption at SweCham scale; defer per-tenant |
| P11 | 💡 | (US1 — keep in F7.1a) | Cancel mid-dispatch UX |
| E3 | 💡 | US5 | Engagement webhook burst handling |
| E6 | 💡 | US4 | Attachment filename XSS |
| E7 | 💡 | US5 | DPIA addendum tracking pixel specifics |
| E9 | 💡 | US6 | Saved-segment compound index |
| E10 | 💡 | US5 | Engagement events unbounded growth |
| X2 | 💡 | US7 | Seed starter library |
| X3 | 💡 | US3 | Chunked backfill day-1 |
| X4 | 💡 | US4 | Link-to-asset-bucket alternative |

---

## Promotion procedure

When ready to promote F7.1b (or subsets) to active development:

1. Create new branch `015-email-broadcast-f71b` (or `015-email-broadcast-attachments` if shipping only US4, etc.) from `main`
2. Create worktree: `git worktree add ../chamber-os-015-broadcast-f71b 015-email-broadcast-f71b origin/main`
3. Copy this backlog's relevant US sections into a new `specs/015-.../spec.md`
4. Apply critique findings from "still pending" table above
5. Run `/speckit.clarify` → `/speckit.plan` → `/speckit.tasks`

Or — if production data suggests cutting one or more USs entirely — close the corresponding section in this backlog with rationale and move on.
