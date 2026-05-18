# Contract: PII Detector + Admin Acknowledgement (US8)

**Spec FRs**: FR-053..063 · **Clarifications**: round-1 Q3 · **Use-cases**: `runPiiDetectionAtSubmit`, `acknowledgePiiAtSubmit`, `requireAdminPiiAcknowledgement`, `togglePiiDetectorWarning`

---

## 1. Server actions

### 1.1 `runPiiDetectionAtSubmit({ broadcastId, subject, bodyHtml })` — invoked during submit

**Invocation**: Inside existing F7 MVP `submitBroadcast` use-case, AFTER sanitisation and BEFORE state transition to `submitted`.
**Auth**: System (called by use-case).
**Input**: `{ tenantId, broadcastId, subject, bodyHtml, detectorVersion: 'v1.0' }`.
**Output**: `PiiDetectionSummary = { detectorVersion: string; patterns: Array<{ type: PatternType; count: number; redactedPreviews: string[] }> }`.
**Pipeline**:
1. Plain-text extract from `bodyHtml` (strip tags — same plain-text fallback as existing F7 MVP body delivery)
2. Concatenate subject + plain-text body
3. Run each pattern in detector v1.0 (thai-national-id, swedish-personnummer, thai-mobile, swedish-mobile, e164-phone, credit-card, iban, email-flooding)
4. For each match: generate redacted preview (first 2 + last 2 chars + `•••` per FR-054)
5. Aggregate counts per pattern type
6. PERSIST `pii_detection_summary` JSON to broadcast row (FR-060) — populated EVEN IF detector UI warning is OFF per FR-061 silent-audit invariant
7. EMIT audit event `broadcast_pii_detected_at_submit` carrying pattern types + counts + detector version (NEVER raw values per FR-059)
**Latency**: Must complete in ≤300ms p95 for body+subject ≤200 KB (SC-017).
**Behavior contract**:
- Detector ALWAYS runs (per FR-061) — does NOT short-circuit when `broadcastPiiDetectorEnabled=false`
- Raw matched values exist transiently in memory for warning display only; MUST NOT log, MUST NOT persist anywhere except as redacted previews

### 1.2 `acknowledgePiiAtSubmit({ broadcastId })` — member compose surface

**Route**: `POST /api/member/broadcasts/draft/:id/submit-with-pii-ack`
**Auth**: member role + tenant ctx + draft ownership.
**Input**:
```typescript
const Input = z.object({
  broadcastId: z.string().uuid(),
  ackedPatternTypes: z.array(z.enum(['thai_national_id', 'swedish_personnummer', 'thai_mobile', 'swedish_mobile', 'e164_phone', 'credit_card', 'iban', 'email_flooding'])).min(1), // member explicitly enumerates what they acked
});
```
**Output**: `Promise<Result<{ broadcastId: string }, BroadcastError>>`.
**Pipeline**:
1. Validate broadcast.pii_detection_summary is non-empty (else error — caller bug)
2. Validate `ackedPatternTypes` covers all detected types (else error — member must ack ALL detected)
3. UPDATE broadcast: `pii_acknowledged_at_submit_at=now()`, `pii_acknowledged_at_submit_by_member_id=actor`
4. Proceed with existing F7 MVP submit flow (transition to `submitted`)
**Audit event**: `broadcast_pii_acknowledged_at_submit` (actor + ackedPatternTypes + counts).

### 1.3 `requireAdminPiiAcknowledgement(broadcastId)` — invoked during admin approve

**Invocation**: Inside existing F7 MVP `approveBroadcast` use-case, AS A GUARD before state transition.
**Behavior**: If `broadcast.pii_detection_summary IS NOT NULL`, REQUIRE the approve action's payload to carry `piiAcknowledgedByAdmin: true`. Reject if missing.
**Audit**: Extends existing F7 MVP `broadcast_approved` event with `pii_acknowledged_by_admin: true` + snapshot of `pii_detection_summary` the admin saw.

### 1.4 `approveBroadcast({ broadcastId, piiAcknowledgedByAdmin? })` — admin server action (EXTENDED F7 MVP)

**Route**: `POST /api/admin/broadcasts/:id/approve` (extended F7 MVP route)
**Auth**: admin role.
**Input**:
```typescript
const Input = z.object({
  broadcastId: z.string().uuid(),
  piiAcknowledgedByAdmin: z.boolean().optional(), // REQUIRED true when broadcast.pii_detection_summary is non-empty
});
```
**Pipeline**:
1. Load broadcast (tenant-scoped via RLS)
2. If `pii_detection_summary` is non-empty: require `piiAcknowledgedByAdmin === true`, else reject with `PII_ACK_REQUIRED_BY_ADMIN`
3. Otherwise: existing F7 MVP approve flow unchanged
4. UPDATE broadcast: `pii_acknowledged_by_admin_at=now()`, `pii_acknowledged_by_admin_user_id=actor` (when PII present)
5. EMIT `broadcast_approved` (existing) + extended payload with `pii_acknowledged_by_admin: true` + `pii_detection_summary` snapshot
6. ALSO emit `broadcast_pii_summary_viewed` (FR-060 — Principle I PII-access log) when admin loads the review page to see the summary

### 1.5 `togglePiiDetectorWarning({ enabled })` — admin server action

**Route**: `POST /api/admin/broadcasts/settings/pii-detector`
**Auth**: admin role.
**Input**: `{ enabled: boolean }`.
**Output**: Updated setting.
**Behavior**: Toggles `tenant_broadcast_settings.broadcast_pii_detector_enabled` — gates UI warning ONLY. Detector ALWAYS runs (FR-061) AND audit ALWAYS emitted (FR-061 silent-audit invariant — verified by SC-015).
**Audit**: No specific event — admin convenience toggle; the audit trail is the detector's runtime behavior, not the toggle setting.

---

## 2. Error taxonomy

| Code | When | HTTP status |
|------|------|-------------|
| `PII_ACK_REQUIRED_BY_MEMBER` | Submit-with-PII-ack missing or incomplete coverage | 422 (with `unackedPatternTypes` in body) |
| `PII_ACK_REQUIRED_BY_ADMIN` | Approve a PII-flagged broadcast without `piiAcknowledgedByAdmin=true` | 422 |
| `BROADCAST_NOT_FOUND` | broadcastId invalid OR RLS hides | 404 |
| `CROSS_TENANT_PROBE` | Tenant ctx mismatch | 403 + audit |

---

## 3. UI surface

- **Member compose** — on Submit click, if `pii_detection_summary` returns non-empty, modal blocks submit with: pattern type + count + redacted preview per FR-054; actions Edit / Submit-anyway (two-click confirmation per FR-056)
- **Admin review** — broadcast detail page surfaces inline PII summary above the body preview (same redacted format); approve button is DISABLED until the PII-acknowledgement checkbox is checked (FR-063)
- **Admin settings** — `/admin/broadcasts/settings` — single toggle row "PII detector UI warning" with explanatory copy: "When disabled, members do not see the PII warning at submit. The detector still runs and the audit log still records detections (silent-audit invariant)."

WCAG verification: PII warning modal is `role="alertdialog"` with focus trap; redacted preview uses `<bdi>` for bidirectional safety; admin checkbox is associated with its label via `htmlFor` + has `aria-describedby` linking to the explanatory copy.

---

## 4. Privacy invariants (audit-trail forensics)

- **Raw matched values NEVER persist**: zero occurrences in audit logs, structured logs (pino), DB columns, or any retained record — verified by SC-016 contract test
- **`pii_detection_summary` stored on broadcast row** carries: detector version, pattern types, counts, redacted previews ONLY
- **`broadcast_pii_summary_viewed` audit event** emitted whenever admin loads the review page (Principle I sub-clause 4 — PII access logging)
- **Detector version pinned at submit time** (FR-062 — `detectorVersion: 'v1.0'`) so post-hoc re-evaluation against a later detector version is attributable to the correct generation
