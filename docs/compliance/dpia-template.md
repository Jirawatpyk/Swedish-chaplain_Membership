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

---

## Future feature DPIAs

Feature owners MUST add a DPIA section here BEFORE `/speckit.review`
Privacy gate when their feature checks any high-risk trigger above.
For features that do NOT trigger DPIA (e.g. F1 internal admin
authentication is a contract-performance + legitimate-interest
necessity with no high-risk profile), record the **screening
decision** (no DPIA required, with reasoning) in
`processing-records.md § F<n>` instead.
