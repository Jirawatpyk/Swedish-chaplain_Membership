# Data Protection Impact Assessment (DPIA) — Template

**Status**: TEMPLATE — populated per-feature when triggered.
**Owner**: Chamber DPO + feature lead.
**Last reviewed**: 2026-05-02 (T183 — F7 Email Broadcast Phase 9 scaffolding).

---

## When a DPIA is required (PDPA §39 / GDPR Art. 35)

A DPIA is mandatory for processing that is **likely to result in a high
risk to the rights and freedoms of natural persons**, in particular:

1. **Systematic and extensive evaluation** of personal aspects (profiling
   with significant decisions / segmentation).
2. **Large-scale processing** of special-category data (Art. 9 / PDPA
   §26) or criminal-conviction data.
3. **Systematic monitoring** of publicly accessible areas on a large
   scale.
4. **Cross-border transfer** of personal data outside Thailand / EU
   without an adequacy decision (PDPA §28 / GDPR Ch V).
5. **New technologies** with unclear privacy implications.
6. **Automated decision-making** with legal / similarly significant
   effects (Art. 22).
7. **Marketing communications at scale** (Chamber-OS F7 trigger — see
   § Per-feature DPIA below).

If a feature checks any of the above, a DPIA section MUST be added
under § Per-feature DPIA below BEFORE the `/speckit.plan` Constitution
Check Privacy gate.

---

## Template structure

Every DPIA entry in this file follows this structure:

```text
## F<n> — <feature name>

### 1. Description of processing
### 2. Necessity & proportionality assessment
### 3. Risk identification (likelihood × severity)
### 4. Mitigations (technical + organisational)
### 5. Residual risk + acceptance / transfer
### 6. Stakeholder consultation (DPO + legal + chamber board)
### 7. Review schedule + sign-off
```

---

## Per-feature DPIA

### F7 — Email Broadcast (E-Blast)

**Status**: SPEC stub — populated at /speckit.review Privacy gate per
T183. Cross-references `docs/compliance/processing-records.md § F7`
which carries the GDPR Art. 30 / PDPA §39 record-of-processing
canonical content.

#### 1. Description of processing

F7 dispatches up to 5,000 marketing emails per broadcast on behalf of
chamber-member-authored content. See processing-records.md § F7 for
the full data taxonomy + lawful-basis narrative.

#### 2. Necessity & proportionality

- **Necessary**: chamber membership tiers contractually include an
  annual quota of E-Blasts (1–15 per year across paying tiers). The
  processing delivers a contractually promised benefit (PDPA §24 /
  GDPR Art. 6(1)(b) lawful basis).
- **Proportionate**: no special-category data; recipient cap of 5,000
  per broadcast; quota cap of 15 broadcasts/member/year; suppression
  list honoured indefinitely (Art. 21 absolute); content sanitised
  via strict-allowlist DOMPurify (FR-002a).

#### 3. Risk identification

| # | Risk | Likelihood | Severity | Pre-mitigation rating |
|---|------|------------|----------|-----------------------|
| R-1 | XSS / phishing payload via member-authored HTML | M | H | High |
| R-2 | Sender-reputation incident → blacklisting → cross-tenant collateral | L | H | Medium |
| R-3 | Unsubscribe-token forgery → unwanted mail | L | M | Low-Medium |
| R-4 | Recipient-email leak in logs | L | H | Medium |
| R-5 | Cross-tenant data leak via segment resolver | L | H | Medium |
| R-6 | GDPR Art. 17 erasure miss when member archived | M | M | Medium |
| R-7 | Webhook-replay attack → spurious delivery / bounce records | L | M | Low-Medium |
| R-8 | Quota-bypass via concurrent submit race | L | L | Low |

#### 4. Mitigations (technical + organisational)

| # | Mitigation | Owner | Evidence |
|---|------------|-------|----------|
| M-1 | Strict-allowlist DOMPurify at Application boundary; `<img>` excluded from MVP allowlist | Eng | FR-002a + sanitiser unit tests |
| M-2 | Per-broadcast complaint-rate auto-halt at 5% (Q14 SC-005 (b)); 30-day rolling 2% bounce + complaint alert | Eng + Ops | docs/observability.md § 22.3 alerts 7 + 11 |
| M-3 | HMAC-SHA256 unsubscribe tokens with 32-byte secret; constant-time MAC compare; quarterly rotation | Eng | `unsubscribe-token-signer.test.ts` 12 cases |
| M-4 | Pino redact list covers `recipient_email`, `recipient_emails`, `body_html`, `Resend-Signature`, `RESEND_BROADCASTS_*`, `UNSUBSCRIBE_TOKEN_SECRET` | Eng | `src/lib/logger.ts` REDACT_PATHS + `tests/unit/lib/logger-redaction.test.ts` |
| M-5 | Postgres RLS + FORCE on all 4 F7 tables; `enforceTenantContext` use-case probe; 14/14 cross-tenant integration tests | Eng | data-model.md § 4 + tasks T011–T035 |
| M-6 | F3 archival cascade auto-cancels in-flight broadcasts; GDPR Art. 17 erasure SET NULL on broadcast_deliveries.recipient_member_id but row preserved | Eng | T178 + T178a |
| M-7 | `broadcast_deliveries(tenant_id, resend_event_id) UNIQUE` + Svix signature verify before parse | Eng | migration 0065 + webhook verifier unit tests |
| M-8 | Quota reservation derived from `status IN ('submitted','approved')` + DB trigger immutable-after-submit + advisory lock per (tenant, broadcast) | Eng | data-model + 4-layer concurrency guard |

#### 5. Residual risk

After mitigations, all 8 risks rate **Low**. Acceptance: chamber DPO
+ feature lead. Re-evaluation cadence: at every F7.x amendment OR if
incident triggers complaint-rate / bounce-rate alert thresholds.

#### 6. Stakeholder consultation

- **DPO**: signs Privacy checklist at `/speckit.review` gate.
- **Legal**: chamber legal counsel reviews member-facing notice +
  unsubscribe page TH/SV strings (i18n.md CHK041).
- **Chamber board**: notified of DPIA outcome; not approver.

#### 7. Review schedule

- **At ship**: signed by DPO + maintainer (solo-maintainer substitute
  for ≥2-reviewer rule per Constitution Principle IX).
- **Quarterly**: review processing-records.md § F7 + this DPIA;
  re-confirm sub-processor list (Resend may swap downstream
  providers).
- **On incident**: any P1/P2 alert from § 22.3 triggers re-evaluation
  of risks R-1, R-2, R-7.

### F8 — Renewal Tracking + Smart Reminders

**Status**: Phase 9 stub — populated at `/speckit.review` Privacy gate
per T256. Cross-references `docs/compliance/processing-records.md § F8`
which carries the GDPR Art. 30 / PDPA §39 record-of-processing
canonical content.

**Trigger**: high-risk trigger #1 (systematic and extensive evaluation
of personal aspects) — F8's at-risk score (FR-029) computes a per-member
8-factor heuristic that classifies members into risk bands and surfaces
them on an admin widget for follow-up. Although the score does NOT make
automated decisions affecting members directly, it IS systematic
evaluation of natural persons within the meaning of GDPR Art. 35(3)(a) /
PDPA §32, so a DPIA is required.

#### 1. Description of processing

F8 processes the following per active chamber member:

- Membership tenure (`joined_at`, `expires_at`)
- Renewal-cycle history (`renewal_cycles.status`, `closed_reason`)
- Reminder dispatch + bounce history (`renewal_reminder_events`,
  `members.email_unverified`)
- Last-payment recency (F4 invoice + F5 payment metadata)
- Last-activity timestamp (`members.last_activity_at` from F3)
- Event attendance count (F6 `EventAttendees.isAvailable()` —
  feature-detection probe; falls back to 0 when F6 not active)
- Outstanding-balance signal (F4 `invoices.status='overdue'` count)
- Plan tier vs declared turnover (F2 + F4 12-month paid-invoice volume,
  for tier-upgrade suggestion)

The 8-factor heuristic is **rule-based** (no ML, no opaque model). The
formula is documented in `docs/smart-chamber-features.md § 3` + spec
FR-029. Score range [0, 100] (active_max=100 when F6 ready, =70 when
F6 inactive — degraded mode). Bands: low/medium/high/critical.

Output is written to `members.risk_score` + `risk_score_band` +
`risk_score_factors` (audit transparency: which factors contributed)
+ `risk_score_last_computed_at`. Recompute cadence: weekly cron pass
(Sunday 02:00 Asia/Bangkok). Member can opt out via
`/portal/preferences/renewals` → kills reminder signal effectively;
admin can snooze a member via `risk_snoozed_until`.

#### 2. Necessity & proportionality

- **Necessary**: chamber operational duty of care toward retention. The
  score helps admins identify churning members early (90+ days before
  lapse) so they can manually reach out — without the score, admins
  must manually scroll an Excel sheet (current state). Lawful basis:
  legitimate interest under GDPR Art. 6(1)(f) + PDPA §24 ¶3 (legitimate
  interest of controller).
- **Proportionate**:
  - 8 factors × per-tenant; no cross-tenant data combination.
  - Inputs are existing F2/F3/F4 columns; no new PII categories
    introduced solely for the score.
  - No special-category data (Art. 9 / PDPA §26) consulted.
  - Member can object via opt-out (Art. 21) → effectively removes the
    behavioural input signal and reduces score impact.
  - Admin-facing only; no automated decision visible to the member.
  - Recompute weekly (not real-time) — minimises processing intensity.

#### 3. Risk identification

| # | Risk | Likelihood | Severity | Pre-mitigation rating |
|---|------|------------|----------|-----------------------|
| R-1 | Stale risk score driving discriminatory admin behaviour | M | M | Medium |
| R-2 | Score factor list leaked in logs → member-classification disclosure | L | M | Low-Medium |
| R-3 | Cross-tenant score leak (tenant A admin sees tenant B score) | L | H | Medium |
| R-4 | Token-replay on `/portal/renewal/<memberId>` link → cross-member cycle access | L | H | Medium |
| R-5 | Renewal reminder dispatched after member opt-out (spam) | L | M | Low-Medium |
| R-6 | Bounce-threshold flag flips erroneously → legitimate emails blocked | L | M | Low-Medium |
| R-7 | F3 archival miss → reminders keep firing for archived member | L | M | Low-Medium |
| R-8 | Audit-log rows for `at_risk_score_recomputed` retain risk-score history beyond declared retention | L | L | Low |
| R-9 | Tier-upgrade suggestion based on stale F4 paid-invoice volume → erroneous member-notification email | L | L | Low |

#### 4. Mitigations (technical + organisational)

| # | Mitigation | Owner | Evidence |
|---|------------|-------|----------|
| M-1 | Score is admin-facing only; admin manual outreach is the only effect (no automated decision affecting member per Art. 22) | Product | spec § Out of Scope OOS-3 + OOS-9 |
| M-2 | `risk_score_factors` audit transparency — explainable rule-based formula; member can request the per-factor breakdown via Art. 15 access right | Eng + DPO | FR-029 + processing-records.md § F8 |
| M-3 | Pino redact paths cover `risk_score_factors`, `at_risk_outreach.notes` (admin free-text), `renewal_token`, `renewal_link`, `RENEWAL_LINK_TOKEN_SECRET*`, `payment_method`, `card.*` | Eng | `src/lib/logger.ts` + `tests/unit/lib/logger-redaction.test.ts` |
| M-4 | Postgres RLS + FORCE on all 9 F8 tables; cross-tenant integration test (50 probes × 9 tables) is Review-Gate blocker | Eng | `tests/integration/renewals/tenant-isolation.test.ts` + `cross-tenant-isolation.test.ts` |
| M-5 | HMAC-SHA256 renewal-link tokens with 32-byte secret; dual-key rotation procedure; constant-time MAC compare; per-IP rate-limit on token verifier (20 hits / 5min) | Eng | research.md § R16 + `tests/integration/renewals/renewal-link-token.test.ts` + `docs/runbooks/secret-rotation.md` § B |
| M-6 | Member opt-out toggle at `/portal/preferences/renewals` sets `renewal_reminders_opted_out=true`; dispatcher skips with audit `renewal_reminder_skipped` (reason='member_opted_out') | Eng | FR-016 + dispatch-one-cycle.ts skip-reason matrix |
| M-7 | Bounce-threshold detector (FR-012a) with explicit thresholds (1 hard / 3 soft per cycle / 5 soft per rolling 30d); verification resets flag; integration test pins all 6 trigger paths | Eng | `tests/integration/renewals/bounce-threshold.test.ts` |
| M-8 | F3 archival cascade scheduled at Phase 10 (deferred from Phase 9 — see plan.md Work-stream A); interim mitigation: archived member has `members.status='archived'` which dispatcher skips per `dispatchRenewalCycle` skip matrix | Eng | dispatch-one-cycle.ts archived skip path + Phase 10 follow-up |
| M-9 | F8 audit retention is 5 years (Constitution v1.4.0 default for non-tax-document); historical risk-score values discoverable only via audit-log query; live `members.risk_score*` reflects current state only | Eng | `F8_AUDIT_RETENTION_YEARS` constant in `renewal-audit-emitter.ts` |
| M-10 | DPO + chamber legal-counsel review F8 i18n strings (especially the at-risk widget tooltip explaining the score) before flag-flip; ensures member-facing copy is non-stigmatising | DPO + Eng | i18n review at `/speckit.review` Privacy gate |

#### 5. Residual risk

After mitigations, all 9 risks rate **Low**. Acceptance: chamber DPO +
maintainer (solo-maintainer substitute per Constitution § IX.5 since
no second human reviewer is available). Re-evaluation cadence:

- At every F8.x amendment.
- On incident (R-3 cross-tenant leak alert, R-4 token-forgery alert).
- Annually as part of chamber data-protection report cycle.
- When F6 EventCreate ships (changes the active_max from 70 → 100;
  re-validate proportionality).

#### 6. Stakeholder consultation

- **DPO**: signs Privacy checklist at `/speckit.review` gate
  (deferred to Phase 10 ship gate per F8 phase-10-backlog).
- **Legal**: chamber legal counsel reviews:
  - At-risk widget tooltip + member-portal opt-out copy in EN/TH/SV.
  - Renewal-link email template TH-mandatory bilingual layout (FR-014
    dual-format date footer).
  - Risk-score classification labels (avoid stigmatising language).
- **Chamber board**: notified of DPIA outcome; not approver.
- **Member-facing transparency**: member-portal Privacy Notice (Phase
  10 task) explains the at-risk score in plain language + opt-out
  procedure.

#### 7. Review schedule

- **At Phase 10 ship**: signed by DPO + maintainer (solo-maintainer
  substitute). DPIA + processing-records co-signed before
  `FEATURE_F8_RENEWALS=true` flag-flip in production.
- **Quarterly**: review processing-records.md § F8 + this DPIA + the
  RENEWAL_LINK_TOKEN_SECRET dual-key rotation timestamp; re-confirm
  no Resend transactional sub-processor change.
- **On incident**: any P1/P2 alert from `docs/observability.md § 23.3`
  triggers re-evaluation — specifically F8-A2 (audit-emit-loss),
  F8-A3 (cron-bearer-rejection burst), or any F8 cross-tenant probe
  audit row sustained > 0.
- **On F6 ship**: re-evaluate the at-risk score active_max + factor
  weights (event attendance becomes available → score profile shifts).

---

## Future feature DPIAs

Feature owners MUST add a DPIA section here BEFORE `/speckit.review`
Privacy gate when their feature checks any high-risk trigger above.
For features that do NOT trigger DPIA (e.g. F1 internal admin
authentication is a contract-performance + legitimate-interest
necessity with no high-risk profile), record the **screening
decision** (no DPIA required, with reasoning) in
`processing-records.md § F<n>` instead.
