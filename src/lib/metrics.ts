/**
 * OpenTelemetry metrics (T180, docs/observability.md § 4).
 *
 * Single metrics façade for ALL bounded contexts (F1 auth, F3 outbox,
 * F4 invoicing, F5 payments, F7 broadcasts). Originally scoped to F1
 * auth only (hence the historical `METER_NAME='swecham.auth'`); CR-8
 * review 2026-04-27 renamed to `swecham.platform` so the meter
 * accurately reflects scope across F1+F3+F4+F5+F7 instruments.
 * Sub-namespaces (`auth_*`, `outbox_*`, `invoicing_*`, `payments_*`,
 * `broadcasts_*`) are encoded in each instrument name, not in separate
 * Meters — this keeps a single scrape pipeline and avoids
 * meter-resolution duplication.
 *
 * Implementation:
 *   - `@opentelemetry/api` `metrics` API — vendor-neutral; the
 *     underlying SDK is registered by `instrumentation.ts` via
 *     `@vercel/otel`.
 *   - Instruments are created lazily and cached. First use from the
 *     Edge runtime is safe because `@opentelemetry/api` is pure JS.
 *
 * Why a thin wrapper instead of passing Meters into every use case:
 *   - Avoids threading a `metrics` dep through every DI boundary.
 *   - Keeps the Application layer free of `@opentelemetry/api`
 *     imports (it imports `src/lib/metrics` instead — same way it
 *     imports `logger`).
 *   - Easy to mock in tests: re-bind `authMetrics.*.add()` to no-ops.
 *
 * Cardinality discipline: every label value is either a bounded enum
 * (`portal`, `role`, `outcome`) or a small-cardinality string
 * (`endpoint`, `template`). NEVER use user id / email / IP as a
 * label — those belong in traces + logs, not metrics.
 */
import {
  metrics,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableGauge,
} from '@opentelemetry/api';

const METER_NAME = 'swecham.platform';

let cachedMeter: Meter | null = null;
function meter(): Meter {
  if (!cachedMeter) {
    cachedMeter = metrics.getMeter(METER_NAME, '1.0.0');
  }
  return cachedMeter;
}

// --- Instrument cache --------------------------------------------------------

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const observableGauges = new Map<string, ObservableGauge>();
// Per-gauge per-tenant value cache. Async observers read from this map
// at scrape time. Writers call `observeGauge(...)` to update.
const gaugeValues = new Map<string, Map<string, number>>();

/**
 * Phase 9 verify-fix C1 — test-only accessor exposing the gauge-values
 * accumulator so unit tests can pin the multi-tenant accumulation
 * invariant directly (vs the prior `not.toThrow()`-only assertions
 * which would have missed a `bucket.entries()` → `bucket.values()`
 * regression).
 *
 * Returns the inner Map for the requested gauge name, or `undefined`
 * if no observation has landed yet. Callers MUST treat the return
 * value as read-only — mutations would silently corrupt production
 * gauge state in the same process. Documented as test-only by the
 * `__test__` prefix; production code paths use the observable-gauge
 * callback registered inside `observeCycleStateGauge` instead.
 */
export function __test__readGaugeValues(
  gaugeName: string,
): ReadonlyMap<string, number> | undefined {
  return gaugeValues.get(gaugeName);
}

function counter(name: string, description: string, unit?: string): Counter {
  let instr = counters.get(name);
  if (!instr) {
    instr = meter().createCounter(name, {
      description,
      ...(unit ? { unit } : {}),
    });
    counters.set(name, instr);
  }
  return instr;
}

function histogram(name: string, description: string, unit: string): Histogram {
  let instr = histograms.get(name);
  if (!instr) {
    instr = meter().createHistogram(name, { description, unit });
    histograms.set(name, instr);
  }
  return instr;
}

/**
 * Observe a value for an async gauge keyed by an arbitrary label set
 * (typically `tenant`). Creates the underlying ObservableGauge on first
 * write and registers a callback that re-reads `gaugeValues` at scrape time.
 *
 * Cardinality discipline: callers MUST keep label-value space bounded.
 * `tenantId` is small-cardinality (≤ a few hundred over project lifetime).
 */
function observeGauge(
  name: string,
  description: string,
  labels: Record<string, string>,
  value: number,
): void {
  let perLabel = gaugeValues.get(name);
  if (!perLabel) {
    perLabel = new Map<string, number>();
    gaugeValues.set(name, perLabel);
  }
  // Use a stable serialization of labels as the inner-map key.
  const labelKey = JSON.stringify(
    Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))),
  );
  perLabel.set(labelKey, value);

  if (!observableGauges.has(name)) {
    const gauge = meter().createObservableGauge(name, { description });
    gauge.addCallback((observer) => {
      const current = gaugeValues.get(name);
      if (!current) return;
      for (const [k, v] of current) {
        try {
          const parsed = JSON.parse(k) as Record<string, string>;
          observer.observe(v, parsed);
        } catch {
          // ignore malformed key
        }
      }
    });
    observableGauges.set(name, gauge);
  }
}

// --- Public API --------------------------------------------------------------

export interface SignInLabels {
  readonly portal: 'staff' | 'member';
  readonly outcome:
    | 'success'
    | 'invalid_credentials'
    | 'account_locked'
    | 'account_disabled'
    | 'rate_limited';
}

export interface RbacDeniedLabels {
  readonly role: 'admin' | 'manager' | 'member';
  readonly resource: string;
  readonly action: string;
}

export interface EmailLabels {
  readonly template: 'reset_password' | 'invitation';
  readonly reason?: 'api_error' | 'rate_limited' | 'bounced' | 'complained';
}

export const authMetrics = {
  // --- Sign-in ---------------------------------------------------------------
  signInAttempt(labels: SignInLabels): void {
    counter(
      'auth_signin_attempts_total',
      'Sign-in attempts by portal and outcome',
    ).add(1, { ...labels });
  },
  signInDuration(seconds: number, labels: SignInLabels): void {
    histogram(
      'auth_signin_duration_seconds',
      'Sign-in latency including argon2 verify',
      's',
    ).record(seconds, { ...labels });
  },
  lockout(): void {
    counter(
      'auth_lockouts_total',
      'How often accounts get locked (credential-stuffing signal)',
    ).add(1);
  },

  // --- Password reset --------------------------------------------------------
  passwordResetRequested(emailKnown: boolean): void {
    counter(
      'auth_password_reset_requested_total',
      'Forgot-password requests',
    ).add(1, { email_known: emailKnown ? 'true' : 'false' });
  },
  passwordResetCompleted(): void {
    counter(
      'auth_password_reset_completed_total',
      'Successful password resets',
    ).add(1);
  },

  // --- Invitations -----------------------------------------------------------
  invitationSent(role: 'admin' | 'manager' | 'member'): void {
    counter('auth_invitation_sent_total', 'Invitations sent by role').add(1, {
      role,
    });
  },
  invitationRedeemed(role: 'admin' | 'manager' | 'member'): void {
    counter(
      'auth_invitation_redeemed_total',
      'Invitations converted to active accounts',
    ).add(1, { role });
  },
  invitationRedemptionFailed(reason: 'expired' | 'used'): void {
    counter(
      'auth_invitation_redemption_failed_total',
      'Invitation redemption failures by reason',
    ).add(1, { reason });
  },
  /**
   * Invitation row failed to land in `notifications_outbox`.
   * Signals a silent-success bug where the admin sees ok but no email
   * will ever be sent — the dispatcher only drains rows that made it
   * into the outbox. Alert threshold: any non-zero rate for 5 min.
   */
  invitationEnqueueFailed(
    role: 'admin' | 'manager' | 'member',
    reason: 'enqueue_failed' | 'no_row_returned',
  ): void {
    counter(
      'auth_invitation_enqueue_failed_total',
      'Invitation outbox enqueue failures by role and reason',
    ).add(1, { role, reason });
  },

  // --- Sessions --------------------------------------------------------------
  idleWarningShown(outcome: 'stayed' | 'timed_out'): void {
    counter(
      'auth_idle_warning_shown_total',
      'How often users engage with the idle warning',
    ).add(1, { outcome });
  },
  sessionDuration(
    seconds: number,
    labels: { role: 'admin' | 'manager' | 'member'; endReason: string },
  ): void {
    histogram(
      'auth_session_duration_seconds',
      'Session lifetime distribution',
      's',
    ).record(seconds, {
      role: labels.role,
      end_reason: labels.endReason,
    });
  },

  // --- Password change -------------------------------------------------------
  passwordChanged(trigger: 'self' | 'reset'): void {
    counter('auth_password_changed_total', 'How often passwords change').add(1, {
      trigger,
    });
  },
  passwordWeakRejected(reason: 'short' | 'pwned' | 'same'): void {
    counter(
      'auth_password_weak_rejected_total',
      'How often the policy blocks weak passwords',
    ).add(1, { reason });
  },

  // --- RBAC ------------------------------------------------------------------
  rbacDenied(labels: RbacDeniedLabels): void {
    counter(
      'auth_rbac_denied_total',
      'Denied operations by role/resource/action',
    ).add(1, { ...labels });
  },
  managerDeniedWrite(endpoint: string): void {
    counter(
      'auth_manager_denied_write_total',
      'Managers hitting endpoints they cannot mutate',
    ).add(1, { endpoint });
  },

  // --- Email -----------------------------------------------------------------
  emailSendDuration(seconds: number, template: EmailLabels['template']): void {
    histogram(
      'auth_email_send_duration_seconds',
      'Resend API call latency by template',
      's',
    ).record(seconds, { template });
  },
  emailSendFailure(labels: Required<EmailLabels>): void {
    counter(
      'auth_email_send_failures_total',
      'Email delivery failures by reason',
    ).add(1, { template: labels.template, reason: labels.reason });
  },

  // --- Infrastructure health ------------------------------------------------
  redisFallback(): void {
    counter(
      'auth_redis_fallback_total',
      'Count of fail-open-to-memory fallbacks (Upstash outage signal)',
    ).add(1);
  },
  auditMissing(eventType: string): void {
    counter(
      'auth_audit_missing_total',
      'Expected audit events that failed to commit',
    ).add(1, { event_type: eventType });
  },
} as const;

// --- F3 outbox metrics -------------------------------------------------------
//
// Mirrors the `invitationEnqueueFailed` pattern above. Alert threshold for
// both counters: any non-zero rate sustained for 5 minutes.
//
// Why a separate export: the outbox dispatcher is operational infrastructure
// shared across F1 (invitation) + F3 (email verification, revert) — keeping
// it separate from `authMetrics` avoids misleading the auth bounded context
// with F3 concerns, and lets the cron import only what it needs.

export const outboxMetrics = {
  /**
   * An outbox row reached `permanently_failed` after exhausting all retries
   * (or hit an unrenderable template). Fired once per row, labelled by
   * `notification_type` + `reason` so alerts can distinguish verification vs
   * revert failures, and max_retries vs invalid_recipient vs unrenderable.
   * Alert threshold: any non-zero rate for 5 minutes. Names mirrored in
   * docs/observability.md § 4 (F3 metrics table).
   */
  permanentFailure(
    notificationType: string,
    reason:
      | 'max_retries'
      | 'invalid_recipient'
      | 'no_template_handler'
      // R17-02 — void two-phase-commit Phase 2 sync failure: Blob
      // prefetch bytes don't match the sha256 committed by Phase 1.
      // Emitted alongside the dual `email_dispatch_failed` +
      // `auto_email_delivery_failed` audit pair so dashboards can
      // alert on integrity-mismatch rate independently from bounce.
      | 'attachment_sha_mismatch',
  ): void {
    counter(
      'outbox_permanent_failures_total',
      'Outbox rows permanently failed — alert on any non-zero rate',
    ).add(1, { notification_type: notificationType, reason });
  },

  /**
   * Rows stuck in `pending` state with `next_retry_at` already past.
   * Indicates the cron is not running, crashed, or lost its CRON_SECRET.
   * Fired once per cron tick where stuck rows are detected; `count` is
   * the number of affected rows. Emitted as a counter whose **rate** is
   * the alert signal: `rate(outbox_stuck_rows_total[5m]) > 0` fires while
   * the cron keeps seeing stuck rows and clears on its own once ticks
   * stop reporting. (We intentionally do NOT emit `.add(0)` on healthy
   * ticks — the absence of rate is the "healthy" signal.)
   */
  stuckRows(count: number): void {
    counter(
      'outbox_stuck_rows_total',
      'Outbox rows stuck in pending past their next_retry_at window',
    ).add(count);
  },
} as const;

// --- F4 invoicing metrics ----------------------------------------------------
//
// T113 / plan.md § VII Perf & Observability declares 6 named metrics for the
// invoicing bounded context. Implementation uses the same meter cache as
// auth/outbox above — labels are bounded enums (event_type, route,
// document_type) to keep cardinality under control.
//
// SLO alignment (docs/observability.md § F4 Invoicing):
//   - issuance p95 < 1.5s        → invoicing_issue_duration_ms.p95
//   - pdf render p95 < 800ms     → invoicing_pdf_render_duration_ms.p95
//   - cross-tenant probe alerts  → rate(invoicing_cross_tenant_probe_total[5m]) > 0
//   - auto-email bounce rate     → rate(invoicing_auto_email_bounces_total[1h])
//                                    / rate(invoicing_auto_email_sent_total[1h]) > 5%
//
// Cardinality ceilings:
//   - `probe_type` ∈ {invoice, credit_note, tenant_invoice_settings} (3 values)
//   - `document_type` ∈ {invoice, receipt, credit_note} (3 values)
//   - `bounce_reason` ∈ {max_retries, invalid_recipient, no_template_handler} (3)

export const invoicingMetrics = {
  /**
   * Successful invoice issuance count. Incremented inside the
   * `issueInvoice` use-case after the tx commits (i.e., only on
   * post-commit success — failures that roll back are NOT counted
   * because they don't consume a §87 sequence number). Paired with
   * the duration histogram below.
   */
  issueCount(): void {
    counter(
      'invoicing_issue_total',
      'Successful invoice issuances — §87 sequence numbers consumed',
    ).add(1);
  },

  /**
   * End-to-end issuance latency (load draft → lock → render → blob →
   * persist → audit → outbox enqueue → commit). Target p95 < 1.5s
   * per the plan. Fired once per successful issuance.
   */
  issueDurationMs(ms: number): void {
    histogram(
      'invoicing_issue_duration_ms',
      'End-to-end issuance latency, p95 target 1500ms',
      'ms',
    ).record(ms);
  },

  /**
   * PDF render latency (reactPdfRenderAdapter.render). Target
   * p95 < 800ms per post-critique E6. Fired on every render call —
   * invoice, receipt, credit note, void-stamp overlay, preview.
   */
  pdfRenderDurationMs(kind: string, ms: number): void {
    histogram(
      'invoicing_pdf_render_duration_ms',
      'PDF render latency by document kind, p95 target 800ms',
      'ms',
    ).record(ms, { kind });
  },

  /**
   * Sequence-allocator contention retries — incremented when the
   * advisory-xact-lock wait was non-zero (i.e., another writer held
   * the (tenant, doc_type, fiscal_year) lock when we tried to
   * allocate). Fires once per retry. Steady background noise under
   * concurrent load; a sustained spike indicates a hot tenant.
   */
  seqContentionRetry(documentType: string, fiscalYear: number): void {
    counter(
      'invoicing_seq_allocator_contention_retries_total',
      'Advisory-lock contentions on sequence-allocator — labelled by doc_type + fy',
    ).add(1, { document_type: documentType, fiscal_year: String(fiscalYear) });
  },

  /**
   * Auto-email bounces — incremented when an `invoice_auto_email`
   * outbox row reaches `permanently_failed` with `invalid-recipient`
   * OR when the receiving Resend webhook reports a hard bounce.
   * Alert: bounce rate > 5% over 1h (see docs/observability.md).
   */
  autoEmailBounce(
    reason:
      | 'invalid_recipient'
      | 'max_retries'
      | 'no_template_handler'
      | 'attachment_sha_mismatch',
  ): void {
    counter(
      'invoicing_auto_email_bounces_total',
      'F4 auto-email permanent failures — alert on bounce rate > 5% / 1h',
    ).add(1, { reason });
  },

  /**
   * Cross-tenant probe count — one per `{invoice,credit_note,
   * tenant_invoice_settings}_cross_tenant_probe` audit emit. Alert:
   * any non-zero rate over 5 min indicates enumeration attack.
   */
  crossTenantProbe(
    probeType: 'invoice' | 'credit_note' | 'tenant_invoice_settings',
  ): void {
    counter(
      'invoicing_cross_tenant_probe_total',
      'F4 cross-tenant probe audit emissions — alert on any non-zero rate',
    ).add(1, { probe_type: probeType });
  },
} as const;

// --- F5 payments metrics -----------------------------------------------------
//
// Phase 4 (US2 PromptPay) introduces 3 metrics not previously instrumented:
//   - PromptPay initiate latency (server-confirm + Stripe roundtrip)
//   - QR <img> retry-debounce exhaustion (S17 — flaky-network signal)
//   - Cross-method-cancel duration (lock-hold under concurrent load — R1)
//
// Cardinality ceilings:
//   - `method` ∈ {card, promptpay} — bounded enum
//   - `outcome` ∈ {ok, retryable, permanent, idempotency_conflict}
//   - NO user/member id labels (high-cardinality forbidden)

export const paymentsMetrics = {
  /**
   * Latency of `/api/payments/initiate` end-to-end including Stripe
   * createPaymentIntent (or retrievePaymentIntent for resume). Target
   * p95 < 1500 ms — alert if exceeded for 5 min. Labelled by `method`
   * so card vs PromptPay can be analysed separately.
   */
  initiateDurationMs(
    method: 'card' | 'promptpay',
    ms: number,
    tenantId?: string,
  ): void {
    // Staff-review R2 R018 (2026-04-28): added optional `tenantId` label
    // so cross-tenant performance attribution is possible per the
    // catalogue spec at docs/observability.md § 21.1. Tenant cardinality
    // is bounded (≤ a few hundred over project lifetime — already
    // documented as safe in § 21.1 cardinality note).
    histogram(
      'payments_initiate_duration_ms',
      'POST /api/payments/initiate end-to-end latency, p95 target 1500ms',
      'ms',
    ).record(ms, tenantId !== undefined ? { method, tenant: tenantId } : { method });
  },

  /**
   * Increments when the in-component QR `<img>` retry counter exhausts
   * `MAX_QR_LOAD_RETRIES` and escalates to the parent's failure state.
   * Sustained non-zero rate signals Stripe CDN issues, CSP misconfig,
   * or systemic flaky-network conditions in the member population.
   * Alert threshold: > 1% of PromptPay initiates over 1h.
   */
  qrLoadRetriesExhausted(): void {
    counter(
      'payments_qr_load_retries_exhausted_total',
      'PromptPay QR image failed to load after retry-debounce (CDN / network signal)',
    ).add(1);
  },

  /**
   * Latency of cross-method-cancel block (Stripe `cancelPaymentIntent`
   * inside the DB tx). The whole block holds the payments row-lock for
   * its duration. Target p95 < 3000 ms; alert if exceeded — sustained
   * spike indicates Stripe API slowness during a hot connection-pool
   * window.
   */
  crossMethodCancelDurationMs(
    outcome: 'ok' | 'retryable' | 'permanent' | 'idempotency_conflict',
    ms: number,
  ): void {
    histogram(
      'payments_cross_method_cancel_duration_ms',
      'Cross-method cancel + DB write block latency, p95 target 3000ms',
      'ms',
    ).record(ms, { outcome });
  },

  // --- T141: F5 metrics catalogue per plan.md § VII --------------------------

  /**
   * `payments.initiate.count{tenant, method}` — RED rate per method.
   * Emitted by `/api/payments/initiate` route on every success.
   */
  initiateCount(tenantId: string, method: 'card' | 'promptpay'): void {
    counter(
      'payments_initiate_count',
      'POST /api/payments/initiate success rate by method',
    ).add(1, { tenant: tenantId, method });
  },

  /**
   * `payments.succeeded.count{tenant, method}` — settlement throughput.
   * Emitted by `confirmPayment` use-case after F4 markPaid commits.
   */
  succeededCount(tenantId: string, method: 'card' | 'promptpay'): void {
    counter(
      'payments_succeeded_count',
      'Payment settlements by method (post-F4 markPaid commit)',
    ).add(1, { tenant: tenantId, method });
  },

  /**
   * `payments.failed.count{tenant, method, reason_code}` — decline-rate alert
   * (excluding bank-decline codes per SLO-F5-005).
   */
  failedCount(
    tenantId: string,
    method: 'card' | 'promptpay',
    reasonCode: string,
  ): void {
    counter(
      'payments_failed_count',
      'Payment failures by method and reason_code',
    ).add(1, { tenant: tenantId, method, reason_code: reasonCode });
  },

  /**
   * `payments.auto_refunded_stale.count{tenant}` — guard-rail anomaly.
   * Fires when webhook `payment_intent.succeeded` lands on an invoice
   * already not in `issued`/`overdue` state and the system auto-refunds.
   */
  autoRefundedStaleCount(tenantId: string): void {
    counter(
      'payments_auto_refunded_stale_count',
      'Auto-refunds triggered by stale-invoice guard-rail',
    ).add(1, { tenant: tenantId });
  },

  /**
   * `refunds.initiate.count{tenant, method, partial:bool}` — refund volume.
   */
  refundInitiateCount(
    tenantId: string,
    method: 'card' | 'promptpay',
    partial: boolean,
  ): void {
    counter(
      'refunds_initiate_count',
      'Admin-initiated refund attempts',
    ).add(1, { tenant: tenantId, method, partial: partial ? 'true' : 'false' });
  },

  /**
   * `refunds.succeeded.count{tenant}` — refund → CN throughput.
   */
  refundSucceededCount(tenantId: string): void {
    counter(
      'refunds_succeeded_count',
      'Refunds reaching succeeded state with credit-note issued',
    ).add(1, { tenant: tenantId });
  },

  /**
   * `refunds.failed.count{tenant, reason_code}` — refund failure forensics.
   */
  refundFailedCount(tenantId: string, reasonCode: string): void {
    counter(
      'refunds_failed_count',
      'Refund failures by reason_code',
    ).add(1, { tenant: tenantId, reason_code: reasonCode });
  },

  /**
   * `webhook.receive.count{tenant, event_type}` — per-type ingest rate.
   * Pre-tenant-resolution events use `tenant='unresolved'`.
   */
  webhookReceiveCount(tenantId: string, eventType: string): void {
    counter(
      'payments_webhook_receive_count',
      'Stripe webhook events received by type',
    ).add(1, { tenant: tenantId, event_type: eventType });
  },

  /**
   * `webhook.duplicate_ignored.count{tenant, event_type}` — idempotency
   * guard hit-rate (FR-008).
   */
  webhookDuplicateIgnored(tenantId: string, eventType: string): void {
    counter(
      'payments_webhook_duplicate_ignored_count',
      'Webhook events skipped via processor_events idempotency guard',
    ).add(1, { tenant: tenantId, event_type: eventType });
  },

  /**
   * `webhook.signature_rejected_total` — abuse / misconfiguration canary.
   * NO tenant label (rejected pre-verification, before tenant resolution).
   */
  webhookSignatureRejected(): void {
    counter(
      'payments_webhook_signature_rejected_total',
      'Webhook events rejected at signature verification',
    ).add(1);
  },

  /**
   * `webhook.api_version_mismatch_total` — Stripe API version drift detector
   * (FR-026 / Q5). NO tenant label.
   */
  webhookApiVersionMismatch(): void {
    counter(
      'payments_webhook_api_version_mismatch_total',
      'Webhook events with non-pinned api_version (acknowledged_only)',
    ).add(1);
  },

  /**
   * `out_of_band_refund_rejected_total{tenant, processor_env}` — FR-011a
   * leading indicator. Admin used Stripe Dashboard refund instead of
   * in-app refund flow.
   */
  outOfBandRefundRejected(
    tenantId: string,
    processorEnv: 'test' | 'live',
  ): void {
    counter(
      'payments_out_of_band_refund_rejected_total',
      'Refunds detected via charge.refunded webhook with no in-app refund row',
    ).add(1, { tenant: tenantId, processor_env: processorEnv });
  },

  /**
   * `member_invite_to_payment_funnel_dropoff{tenant, step}` — F5.1 promotion
   * KPI (FR-016a). Steps: invite_sent → invite_opened → account_created →
   * invoice_viewed → payment_initiated → payment_succeeded.
   */
  inviteToPaymentFunnelStep(
    tenantId: string,
    step:
      | 'invite_sent'
      | 'invite_opened'
      | 'account_created'
      | 'invoice_viewed'
      | 'payment_initiated'
      | 'payment_succeeded',
  ): void {
    counter(
      'payments_member_invite_to_payment_funnel_dropoff',
      'Funnel checkpoints from invitation to first payment',
    ).add(1, { tenant: tenantId, step });
  },

  /**
   * `payments.stale_pending_count{tenant}` — async gauge surfacing
   * Stripe-webhook-giveup zombies (`status='pending'` AND
   * `initiated_at < now() - 24h`). Emitted by the cron-job.org-triggered
   * `/api/internal/metrics/stale-pending-count` route at 5-min cadence.
   * Alert threshold: > 5 for any tenant.
   */
  stalePendingCount(tenantId: string, count: number): void {
    observeGauge(
      'payments_stale_pending_count',
      'Pending Payment rows older than 24h, surfaced for stuck-row alerting',
      { tenant: tenantId },
      count,
    );
  },
} as const;

// --- F7 broadcasts metrics (Phase 6 / US4 + Phase 9 anchor) ---------------------
//
// FR-035 declares 16 F7 metrics (compose, queue, webhook, dispatch, unsubscribe).
// This block ships the **public unsubscribe surface** subset emitted at US4
// implementation time so SLO-F7-006 (`p95 unsubscribe page TTFB < 400ms`) can
// be measured immediately. The remaining metrics (compose TTFB, queue list,
// webhook handler, etc.) are wired progressively as their owning surfaces
// are observed in production — full catalogue lands at Phase 9 T172.
//
// Cardinality ceilings:
//   - `tenant` ∈ small-cardinality slug set (≤ a few hundred over project lifetime)
//   - `outcome` ∈ {success, already, invalid, rate_limited, repo_error,
//     unhandled_error} — bounded enum
//   - `event_type` (auditEmitFailed) ∈ {broadcast_unsubscribed,
//     broadcast_suppression_applied, …} — bounded enum from the F7 audit
//     event-type union
//   - NO recipient-email or member-id labels (FR-042 forbidden in logs/metrics)

/**
 * Swallow OTel emission failures. The `@opentelemetry/api` calls usually
 * no-op when no SDK is registered, but `@vercel/otel` exporter init can
 * throw on first record under transient pipeline misconfiguration. The
 * F7 unsubscribe page is a GDPR Art. 21 surface where signal loss is
 * preferable to a 500 — prior commit added the page-level guard; this
 * helper closes the remaining gap (metric emission between the
 * use-case commit and the return).
 */
function safeMetric(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    // Use console.warn (NOT pino logger) so this file stays client-safe
    // — `paymentsMetrics` is imported by F5 PromptPay client components
    // (promptpay-panel.tsx) and pino's worker_threads dep would break
    // the Turbopack browser bundle. Last-resort signal-loss swallow;
    // the structured-logger upgrade can come from observability rules
    // that scrape browser/Node consoles uniformly.
    //
    // TODO (post-F8, tracked PR #25 R3 review-fix M2): this catch
    // swallows ALL errors including programmer bugs (TypeError /
    // ReferenceError from a future label-set or instrument-cache
    // regression). The intent is OTel-pipeline-transient resilience,
    // but the broad catch hides regressions that would otherwise fail
    // CI. A future iteration should narrow the catch to known OTel
    // error names (e.g. inspect `e.name`/`e.message` for OTel
    // signatures) and re-throw TypeError/ReferenceError so genuine
    // programmer regressions surface. Out-of-scope for PR #25 (pre-
    // existing pattern across all F1/F4/F5/F7/F8 metric helpers —
    // ~50+ call sites; refactor warrants its own PR).
    console.warn('metrics_emit_failed_swallowed', {
      err: (e as Error).message,
    });
  }
}

/**
 * Shared label alphabet for the `broadcasts.cascade.outcome` counter
 * (see `broadcastsMetrics.cascadeOutcome`). Exported so callers, tests,
 * and dashboard code reference one symbol — Round 2 type-design fix.
 */
export type BroadcastsCascadeOutcomeMetric =
  | 'cancelled'
  | 'concurrent_skip'
  | 'unexpected_error';

export const broadcastsMetrics = {
  /**
   * `broadcasts.unsubscribes{tenant, outcome}` — counter incremented on
   * every public unsubscribe-page render. `outcome` distinguishes:
   *   - `success`         → first-time unsubscribe (suppression row inserted)
   *   - `already`         → idempotent replay (no row mutation, FR-030)
   *   - `invalid`         → token verification failed (audit emitted)
   *   - `rate_limited`    → request rejected by IP rate limit (CHK-anti-enum)
   *   - `repo_error`      → suppression upsert failed; user shown retry-state
   *   - `unhandled_error` → caught throw outside the use-case (DB outage, etc.)
   * Convergent alert rates:
   *   1. `success` count = real unsubscribe volume (alert: spike >5 σ)
   *   2. `invalid` rate >5/min = possible token-enumeration attack (E1 mitigation)
   *   3. `repo_error` + `unhandled_error` any non-zero = stop-the-line
   */
  unsubscribesCount(
    tenantId: string | null,
    outcome:
      | 'success'
      | 'already'
      | 'invalid'
      | 'rate_limited'
      | 'repo_error'
      | 'unhandled_error',
  ): void {
    safeMetric(() => {
      counter(
        'broadcasts_unsubscribes_total',
        'Public unsubscribe page outcome — paired with `outcome` label',
      ).add(1, {
        tenant: tenantId ?? 'unknown',
        outcome,
      });
    });
  },

  /**
   * `broadcasts.unsubscribe_page_ttfb_seconds{tenant}` — histogram of
   * the public unsubscribe-page server-render duration. SLO-F7-006
   * target: p95 < 400 ms. Sampled at every render, including
   * invalid-token + rate-limited paths (those should be cheap).
   */
  unsubscribePageTtfbMs(tenantId: string | null, ms: number): void {
    safeMetric(() => {
      histogram(
        'broadcasts_unsubscribe_page_ttfb_ms',
        'Public unsubscribe page TTFB, p95 target 400ms (SLO-F7-006)',
        'ms',
      ).record(ms, { tenant: tenantId ?? 'unknown' });
    });
  },

  /**
   * Mirrors `authMetrics.auditMissing` — incremented when an expected audit
   * event fails to commit (use-case succeeded but `audit.emit` threw, or
   * a transient error swallowed elsewhere). Any non-zero rate sustained for
   * 5 minutes pages on-call (signal-loss on a Principle I append-only
   * surface).
   */
  auditEmitFailed(eventType: string, tenantId: string | null): void {
    safeMetric(() => {
      counter(
        'broadcasts_audit_emit_failed_total',
        'Expected broadcasts audit events that failed to commit',
      ).add(1, { event_type: eventType, tenant: tenantId ?? 'unknown' });
    });
  },

  /**
   * `broadcasts.dispatch_budget_exhausted{tenant, sub_kind}` — counter
   * incremented when the FR-021 / AS2 1-hour retry budget elapses with
   * Resend still failing → row transitions to `failed_to_dispatch`.
   *
   * **Alert rule (E2 closure 2026-05-02)**: any non-zero count in a
   * 15-minute window pages on-call. Per scheduled-broadcast cadence
   * the steady state is 0 — even a single budget-exhausted event
   * means a member's scheduled E-Blast did not go out. The use-case
   * also enqueues the Slice E member-facing dispatch-failure email
   * (best-effort) and emits the `broadcast_failed_to_dispatch`
   * audit; this metric is the alert-pipeline trigger.
   *
   * `sub_kind` carries the Resend gateway failure subKind that
   * exhausted the budget (`network`, `timeout`, `server_5xx`, `api`)
   * so dashboards can distinguish Resend outages from network blips.
   */
  dispatchBudgetExhausted(
    tenantId: string,
    subKind: 'network' | 'timeout' | 'server_5xx' | 'api',
  ): void {
    safeMetric(() => {
      counter(
        'broadcasts_dispatch_budget_exhausted_total',
        'FR-021 / AS2 — 1-hour retry budget exhausted; broadcast did not go out',
      ).add(1, { tenant: tenantId, sub_kind: subKind });
    });
  },

  // --- T172 (Phase 9) — full F7 metrics catalogue --------------------------
  // Wires the remaining metrics from observability.md § 22.1 + plan.md
  // § Performance & Capacity Metrics list. Cardinality discipline:
  // every label is bounded enum or small-cardinality string. NEVER
  // label by recipient_email_lower / member_id (FR-042).

  /** `broadcasts.draft.count{tenant, actor_role}` — compose-funnel TOF. */
  draftCount(
    tenantId: string,
    actorRole: 'member_self_service' | 'admin_proxy' | 'system',
  ): void {
    safeMetric(() => {
      counter(
        'broadcasts_draft_count',
        'Drafts created — compose-funnel top-of-funnel signal',
      ).add(1, { tenant: tenantId, actor_role: actorRole });
    });
  },

  /** `broadcasts.submit.count{tenant, actor_role}` — submission throughput. */
  submitCount(
    tenantId: string,
    actorRole: 'member_self_service' | 'admin_proxy',
  ): void {
    safeMetric(() => {
      counter(
        'broadcasts_submit_count',
        'Successful submit transitions to status=submitted',
      ).add(1, { tenant: tenantId, actor_role: actorRole });
    });
  },

  /** `broadcasts.submit.duration_ms{tenant, actor_role}` — SLO-F7-002 < 1.2s. */
  submitDurationMs(
    tenantId: string,
    actorRole: 'member_self_service' | 'admin_proxy',
    ms: number,
  ): void {
    safeMetric(() => {
      histogram(
        'broadcasts_submit_duration_ms',
        'Submit endpoint p95 target 1200ms (SLO-F7-002)',
        'ms',
      ).record(ms, { tenant: tenantId, actor_role: actorRole });
    });
  },

  /**
   * `broadcasts.submit.precondition_blocked.count{tenant, precondition}`
   * — drop-off forensics for FR-002 a–k preconditions.
   */
  submitPreconditionBlocked(
    tenantId: string,
    precondition:
      | 'quota_exhausted'
      | 'empty_segment'
      | 'rate_limit_exceeded'
      | 'plan_no_eblast'
      | 'subject_too_long'
      | 'body_too_large'
      | 'body_unsafe_html'
      | 'audience_too_large'
      | 'custom_recipient_unknown'
      | 'member_missing_primary_contact_email'
      | 'member_halted_pending_review',
  ): void {
    safeMetric(() => {
      counter(
        'broadcasts_submit_precondition_blocked_count',
        'Submit blocked by FR-002 a–k precondition',
      ).add(1, { tenant: tenantId, precondition });
    });
  },

  /**
   * `broadcasts.approve_send_now.duration_ms{tenant}` — SLO-F7-004 < 1.5s.
   */
  approveSendNowDurationMs(tenantId: string, ms: number): void {
    safeMetric(() => {
      histogram(
        'broadcasts_approve_send_now_duration_ms',
        'Admin approve & send-now p95 target 1500ms (SLO-F7-004)',
        'ms',
      ).record(ms, { tenant: tenantId });
    });
  },

  /**
   * `broadcasts.failed_to_dispatch.count{tenant, failure_reason}` —
   * dispatch-failure forensics. Paired with `dispatchBudgetExhausted`
   * (which counts only the AS2 1-hour-budget terminal case).
   */
  failedToDispatchCount(
    tenantId: string,
    failureReason:
      | 'resend_5xx'
      | 'resend_429'
      | 'resend_403'
      | 'app_error'
      | 'timeout',
  ): void {
    safeMetric(() => {
      counter(
        'broadcasts_failed_to_dispatch_count',
        'Dispatch failures by reason — alert at >10% over send_started',
      ).add(1, { tenant: tenantId, failure_reason: failureReason });
    });
  },

  /**
   * `broadcasts.cron.dispatched.count{tenant}` — scheduled-send cron
   * throughput.
   */
  cronDispatchedCount(tenantId: string): void {
    safeMetric(() => {
      counter(
        'broadcasts_cron_dispatched_count',
        'Scheduled-send cron successful dispatches',
      ).add(1, { tenant: tenantId });
    });
  },

  /**
   * `broadcasts.cron.skipped.count{tenant, reason}` — cron tick
   * observability.
   *
   * R6 staff-review W-P5 fix — `'advisory_lock_held'` removed from the
   * union. The dispatch route uses `FOR UPDATE SKIP LOCKED` on the
   * eligible-row scan AND `pg_advisory_xact_lock` per-(tenant,
   * broadcast); a row contested by another worker is never returned to
   * the second scanner in the first place, so the "skipped because
   * lock held" bucket has no emission site by design. Keeping a label
   * with no call-site path was actively harmful: the corresponding
   * alert rule in `docs/observability.md` (`advisory_lock_held > 5 in
   * 5min`) would never fire, masking real concurrency bugs if they
   * ever surfaced. The alert rule was removed alongside the label
   * (see docs/observability.md § F7 alerts post-R6).
   */
  cronSkippedCount(
    tenantId: string,
    reason: 'kill_switch' | 'no_due_rows',
  ): void {
    safeMetric(() => {
      counter(
        'broadcasts_cron_skipped_count',
        'Cron tick skipped — kill-switch / lock-held / no-due-rows',
      ).add(1, { tenant: tenantId, reason });
    });
  },

  /**
   * `broadcasts.cron.unknown_error.count{tenant}` — Round 5 R5-CRON-A:
   * dispatch use-case returned a Result.err of an unrecognised `kind`.
   * Indicates an enum drift between use-case error union and route
   * handler — should be 0 in steady state. Any non-zero rate pages
   * on-call so dashboards detect the mismatch immediately rather than
   * scraping JSON response bodies.
   */
  cronUnknownErrorCount(tenantId: string): void {
    safeMetric(() => {
      counter(
        'broadcasts_cron_unknown_error_count',
        'Cron tick unknown Result.err.kind — alert on any non-zero rate',
      ).add(1, { tenant: tenantId });
    });
  },

  /**
   * `broadcasts.cron.uncaught_error.count{tenant}` — Round 5 R5-CRON-A:
   * dispatch use-case threw outside the Result envelope (programming
   * bug, infra outage, or unhandled adapter error). The broadcast row
   * stays `approved` and the next tick will hit the same bug — alert
   * immediately rather than waiting for log-scrape.
   */
  cronUncaughtErrorCount(tenantId: string): void {
    safeMetric(() => {
      counter(
        'broadcasts_cron_uncaught_error_count',
        'Cron tick uncaught throw — alert on any non-zero rate',
      ).add(1, { tenant: tenantId });
    });
  },

  /**
   * `broadcasts.webhook.receive.count{tenant, event_type}` — per-event
   * ingest rate. Pre-tenant (signature-rejected) emits use
   * `tenant='unresolved'`.
   */
  webhookReceiveCount(
    tenantId: string | null,
    eventType:
      | 'delivered'
      | 'bounced'
      | 'complained'
      | 'sent'
      | 'delivery_delayed'
      // R9 staff-review NIT — surface novel Resend event subtypes
      // (e.g. future `email.opened`) in the metric instead of
      // collapsing them silently to `'sent'`. The bounded label set
      // keeps cardinality safe; `'unknown'` is the explicit catch-
      // all that on-call dashboards alert on if it becomes non-zero.
      | 'unknown',
  ): void {
    safeMetric(() => {
      counter(
        'broadcasts_webhook_receive_count',
        'Resend Broadcasts webhook events received by type',
      ).add(1, {
        tenant: tenantId ?? 'unresolved',
        event_type: eventType,
      });
    });
  },

  /**
   * `broadcasts.webhook.duration_ms{tenant}` — SLO-F7-005 < 250ms.
   */
  webhookDurationMs(tenantId: string | null, ms: number): void {
    safeMetric(() => {
      histogram(
        'broadcasts_webhook_duration_ms',
        'Webhook handler p95 target 250ms (SLO-F7-005)',
        'ms',
      ).record(ms, { tenant: tenantId ?? 'unresolved' });
    });
  },

  /**
   * `broadcasts.webhook_signature_rejected_total{reason}` — abuse /
   * misconfig canary. NO tenant label (rejected pre-verification).
   *
   * Round 3 code-reviewer fix — added `reason` label so secret-rotation
   * incidents (`bad_signature` spike) read distinctly from kill-switch
   * blocks (`feature_disabled` spike) on dashboards. Cardinality
   * bounded ≤4.
   *
   *   - `feature_disabled` → kill-switch path; FEATURE_F7_BROADCASTS=false
   *   - `body_too_large`   → 64 KiB cap exceeded (Content-Length OR
   *                          realised body)
   *   - `missing_header`   → svix-id / svix-timestamp / svix-signature
   *                          absent
   *   - `bad_signature`    → HMAC mismatch / timestamp window violation
   *                          / version mismatch / payload-too-large
   */
  webhookSignatureRejected(
    reason:
      | 'feature_disabled'
      | 'body_too_large'
      | 'missing_header'
      | 'bad_signature' = 'bad_signature',
  ): void {
    safeMetric(() => {
      counter(
        'broadcasts_webhook_signature_rejected_total',
        'Resend Broadcasts webhook events rejected at signature verification',
      ).add(1, { reason });
    });
  },

  /**
   * `broadcasts.bounce_rate_per_broadcast{tenant, broadcast_id}` —
   * gauge for sender-reputation watchdog. > 2% warn, > 5% page.
   *
   * Cardinality ceiling (Round 3 observability G4):
   * `broadcasts/year/tenant × tenant_count`. At STD scale (1 active
   * tenant SweCham + ≤52 broadcasts/year/tenant cadence assumption)
   * this caps at ~52 series. Multi-tenant onboarding raises this
   * linearly; if `tenant_count × 52 > ~500` series re-evaluate by
   * dropping `broadcast_id` and aggregating to per-tenant only.
   * `broadcast_id` is a UUID — dashboards must group by `tenant`,
   * not by `broadcast_id`, for human-readable rollups.
   */
  bounceRatePerBroadcast(
    tenantId: string,
    broadcastId: string,
    rate: number,
  ): void {
    safeMetric(() => {
      observeGauge(
        'broadcasts_bounce_rate_per_broadcast',
        'Per-broadcast bounce rate (0..1) — sender reputation watchdog',
        { tenant: tenantId, broadcast_id: broadcastId },
        rate,
      );
    });
  },

  /**
   * `broadcasts.complaint_rate_per_broadcast{tenant, broadcast_id}` —
   * gauge. ≥ 0.1% warn, ≥ 0.5% page, > 5% Q14 SC-005 (b) auto-halt.
   *
   * Cardinality ceiling: see `bounceRatePerBroadcast` above —
   * same shape, same ceiling, same dashboard-grouping guidance.
   */
  complaintRatePerBroadcast(
    tenantId: string,
    broadcastId: string,
    rate: number,
  ): void {
    safeMetric(() => {
      observeGauge(
        'broadcasts_complaint_rate_per_broadcast',
        'Per-broadcast complaint rate — Q14 SC-005(b) auto-halt at >5%',
        { tenant: tenantId, broadcast_id: broadcastId },
        rate,
      );
    });
  },

  /**
   * `broadcasts.queue_pending{tenant}` — submitted + approved-with-
   * scheduled count. Alert > 8000 (FR-013 SLA breach risk).
   */
  queuePending(tenantId: string, count: number): void {
    safeMetric(() => {
      observeGauge(
        'broadcasts_queue_pending',
        'Pending broadcasts (submitted + approved-with-scheduled)',
        { tenant: tenantId },
        count,
      );
    });
  },

  /**
   * `broadcasts.stuck_sending_count{tenant}` — `status='sending'` for
   * > 24h. Any non-zero alarms (webhook event lost / Resend resource
   * missing).
   */
  stuckSendingCount(tenantId: string, count: number): void {
    safeMetric(() => {
      observeGauge(
        'broadcasts_stuck_sending_count',
        'Broadcasts in status=sending for >24h',
        { tenant: tenantId },
        count,
      );
    });
  },

  // NOTE: SLO-F7-001 (compose page TTFB) + SLO-F7-003 (admin queue
  // list) source signal is Vercel Speed Insights per
  // docs/observability.md § 22.2 — NOT OTel histograms. Server-
  // component bodies are subject to React 19 `react-hooks/purity`
  // rule which forbids `Date.now()` measurement at render time.
  // No `composePageTtfbMs` / `adminQueueListMs` helpers — emission
  // would be dead code.

  /**
   * `broadcasts.suppression_filter_count{tenant}` — number of
   * recipients filtered out per dispatch (suppression anti-join).
   */
  suppressionFilterCount(tenantId: string, count: number): void {
    safeMetric(() => {
      counter(
        'broadcasts_suppression_filter_count',
        'Recipients removed by suppression anti-join per dispatch',
      ).add(count, { tenant: tenantId });
    });
  },

  /**
   * `broadcasts.audit_emit_count{tenant, event_type}` — ops-dashboard
   * audit-event volume per tenant per type. Distinct from
   * `auditEmitFailed` (which counts FAILURES).
   */
  auditEmitCount(tenantId: string | null, eventType: string): void {
    safeMetric(() => {
      counter(
        'broadcasts_audit_emit_count',
        'F7 audit-event emissions by type — ops dashboard',
      ).add(1, { tenant: tenantId ?? 'unknown', event_type: eventType });
    });
  },

  /**
   * `broadcasts.audience_drift_detected.count{tenant}` — F7.1-IMP5
   * black-swan event: idempotency replay observed recipient-count
   * mismatch between expected and Resend audience reality.
   */
  audienceDriftDetected(tenantId: string): void {
    safeMetric(() => {
      counter(
        'broadcasts_audience_drift_detected_count',
        'Idempotency-replay observed audience-count drift (F7.1-IMP5)',
      ).add(1, { tenant: tenantId });
    });
  },

  /**
   * `broadcasts.drift_check_unverifiable.count{tenant}` — Round-5
   * R5-S1: Resend `getAudienceContactCount` failed on non-404 during
   * idempotency replay. Replay still advances but recipient count
   * cannot be verified.
   */
  driftCheckUnverifiable(tenantId: string): void {
    safeMetric(() => {
      counter(
        'broadcasts_drift_check_unverifiable_count',
        'Audience drift check failed on non-404 during idempotency replay',
      ).add(1, { tenant: tenantId });
    });
  },

  /**
   * `broadcasts.dispatch_failure_rate{tenant}` — gauge, 0..1 ratio of
   * `failed_to_dispatch` over `failed_to_dispatch + sent + sending` in
   * the most recent 1-hour rolling window keyed on `sending_started_at`.
   *
   * Round 3 observability G1+G5 fix — alert at observability.md § 22.3
   * `> 0.10 (10%) → page` (Resend incident / app bug). Emitted by the
   * `broadcasts-gauges` cron alongside `queue_pending` +
   * `stuck_sending_count`. With no traffic the rolling-window query
   * returns no rows and the gauge is not sampled (no false positives
   * from quiet tenants).
   */
  dispatchFailureRate(tenantId: string, rate: number): void {
    safeMetric(() => {
      observeGauge(
        'broadcasts_dispatch_failure_rate',
        'Rolling 1h failed_to_dispatch / dispatched ratio (alert >0.10)',
        { tenant: tenantId },
        rate,
      );
    });
  },

  /**
   * `broadcasts.cascade.outcome{tenant, outcome}` — F3 archival/erasure
   * cascade outcome counter. Per-broadcast classification (see
   * `BroadcastsCascadeOutcomeMetric`):
   *   - `cancelled`           → broadcast successfully transitioned to cancelled
   *   - `concurrent_skip`     → BroadcastConcurrentMutationError — dispatch worker
   *                             flipped status between snapshot and applyTransition;
   *                             expected race, audited as
   *                             `broadcast_concurrent_action_blocked`
   *   - `unexpected_error`    → tx or audit emit threw something other than
   *                             concurrent-mutation; broadcast was NOT cancelled.
   *                             Any non-zero rate = stop-the-line (signal-loss
   *                             on a Principle I cascade).
   *
   * Distinct from the port-level `CascadeResult.outcome` (`'ok' | 'cascade_failed'`)
   * which classifies whether the cascade USE-CASE ran end-to-end vs the
   * use-case ITSELF errored.
   */
  cascadeOutcome(
    tenantId: string,
    outcome: BroadcastsCascadeOutcomeMetric,
  ): void {
    safeMetric(() => {
      counter(
        'broadcasts_cascade_outcome_total',
        'F3 archival/erasure cascade outcome per broadcast',
      ).add(1, { tenant: tenantId, outcome });
    });
  },
} as const;

// ---------------------------------------------------------------------------
// F8 Renewals (J5 — observability hardening per /speckit-review Round 2)
// ---------------------------------------------------------------------------

/**
 * Failure-kind enum for the cron coordinator's per-tenant fan-out. Bounded
 * cardinality so dashboards can graph failure mix without label explosion.
 *   - `http_5xx`         — per-tenant route returned 5xx (server fault)
 *   - `http_4xx`         — per-tenant route returned 4xx (e.g. 401 auth, 400 unknown_tenant)
 *   - `rejected`         — fetch rejected (network error, timeout)
 *   - `json_parse_failed` — 200 returned but body wasn't parseable JSON
 *                          (malformed gateway response — Vercel edge HTML
 *                          error page would land here)
 */
export type RenewalsCoordinatorFailureKind =
  | 'http_5xx'
  | 'http_4xx'
  | 'rejected'
  | 'json_parse_failed';

export const renewalsMetrics = {
  /**
   * `renewals_bounce_hook_errors_total{tenant}` — H2: F1 Resend webhook →
   * F8 detectBounceThreshold throw. Previously a `logger.warn` whose
   * absence in alerting silently broke FR-012a (a hard-bouncing
   * member's `email_unverified` flag would never flip → dispatcher
   * keeps mailing the bouncing address → Resend reputation pool
   * degrades). Any non-zero rate sustained for 5 minutes pages on-call.
   */
  bounceHookFailed(tenantId: string | null): void {
    safeMetric(() => {
      counter(
        'renewals_bounce_hook_errors_total',
        'F1 Resend webhook → F8 detectBounceThreshold callback failed (FR-012a alert trigger)',
      ).add(1, { tenant: tenantId ?? 'unknown' });
    });
  },

  /**
   * `renewals_reset_hook_errors_total{tenant}` — H2 sibling: F1 verify-
   * contact-email → F8 resetEmailUnverified throw. Less critical than
   * the bounce hook (the F1 verification still succeeded; the F8 flag
   * stays TRUE until a future cron pass / admin action reconciles)
   * but observability-equal — silent failures hide F1↔F8 desync.
   */
  resetHookFailed(tenantId: string | null): void {
    safeMetric(() => {
      counter(
        'renewals_reset_hook_errors_total',
        'F1 verify-contact-email → F8 resetEmailUnverified callback failed',
      ).add(1, { tenant: tenantId ?? 'unknown' });
    });
  },

  /**
   * `renewals_coordinator_tenant_failures_total{tenant, kind}` — H1:
   * cron coordinator per-tenant fan-out failures. Previously the
   * coordinator emitted a single `cron_dispatch_orchestrated` audit
   * with `tenants_failed` count but no per-tenant alert; F8 SaaS
   * needs to know WHICH tenant failed to triage. Pages on-call when
   * the same tenant fails 3 successive coordinator runs.
   */
  coordinatorTenantFailed(
    tenantId: string,
    kind: RenewalsCoordinatorFailureKind,
  ): void {
    safeMetric(() => {
      counter(
        'renewals_coordinator_tenant_failures_total',
        'F8 cron coordinator per-tenant fan-out failure',
      ).add(1, { tenant: tenantId, kind });
    });
  },

  /**
   * `renewals_coordinator_audit_emit_failed_total{cron_kind}` — H9:
   * the orchestrated audit is the ONLY operational record of what
   * each F8 cron coordinator did. Losing it silently breaks
   * Principle VIII compliance trail. Mirrors `broadcastsMetrics.
   * auditEmitFailed` semantics — any non-zero rate is stop-the-line.
   *
   * Round-4 review-finding H3: previously unlabeled, so on-call
   * could not tell which compliance trail was lost across the 4
   * F8 coordinators (`dispatch`, `at_risk_recompute`, `lapse`,
   * `reconcile`). Adding `cron_kind` lets SRE attach distinct alert
   * rules per stream + diagnose triage in seconds, not minutes.
   */
  /**
   * F8 Phase 7 review-fix C-ERR-1 — listener swallow observability.
   *
   * Counts failures from the F2 → F8 plan-change bridge listeners
   * (`f2-plan-change-bridge.ts:f8OnManualPlanChangeCallbacks`). Each
   * listener logs + swallows by design (the F2 plan-flip already
   * committed; throwing would be after-the-fact). Vercel alert rules
   * attach to OTel counters not log strings, so on-call detection
   * needs this pair. Any non-zero rate sustained >5 min indicates
   * the F8 supersede / reschedule audit chain is being silently lost.
   */
  manualPlanChangeListenerFailed(
    listener: 'supersede' | 'reschedule',
    tenantId: string,
  ): void {
    safeMetric(() => {
      counter(
        'renewals_manual_plan_change_listener_failed_total',
        'F8 listener attached to F2 member_plan_manually_changed event failed (audit chain silently lost)',
      ).add(1, { listener, tenant_id: tenantId });
    });
  },

  /**
   * F8 Phase 7 review-fix C-ERR-2 — apply-pending callback INVALID_TX
   * fallback observability. Sister metric to `onPaidInvalidTx` for
   * the cycle-completion callback. Any non-zero rate sustained >5 min
   * indicates F4 contract drift on the apply-pending path — atomic-
   * single-tx invariant lost; F4 commit + F8 commit eventual-
   * consistency window re-opened.
   *
   * Phase 7 review-fix Round 2 IMP-1: label key re-aligned to `tenant`
   * so dashboard joins against `onPaidInvalidTx` (which uses bare
   * `tenant`) work correctly. Round 1 had `tenant_id` which dropped
   * the alert-pair join.
   */
  applyPendingInvalidTx: {
    add(count: number, attrs: { tenant_id: string }): void {
      safeMetric(() => {
        counter(
          'renewals_apply_pending_invalid_tx_total',
          'F8 apply-pending-tier-upgrade callback received non-TenantTx from F4 — atomic-single-tx invariant lost',
        ).add(count, { tenant: attrs.tenant_id });
      });
    },
  },

  /**
   * F8 Phase 7 review-fix Round 2 CRIT-2 — audit-emit failure counter.
   * Fires when `auditEmitter.emit()` itself throws (production
   * pgEnum drift triggers `pinoFallback` which throws). Distinct
   * from `tierUpgradeNotifyFailed` so on-call can differentiate
   * "email succeeded but audit row missing" (this counter) from
   * "email send failed" (the other counter). Mirrors F7 broadcasts
   * audit-emit-failed precedent.
   */
  tierUpgradeAuditEmitFailed(
    auditType:
      | 'tier_upgrade_pending_member_notified'
      | 'tier_upgrade_pending_member_notify_skipped'
      | 'tier_upgrade_pending_member_notify_failed'
      // Staff-R004 (2026-05-10): aggregate `tier_upgrade_already_at_target`
      // audit emit at end of evaluateTierUpgrade cron pass. The catch
      // arm previously had `logger.warn` only; adding this enum literal
      // wires the alertable counter so SRE can detect silent dropped
      // audits per Constitution Principle VIII visibility.
      | 'tier_upgrade_already_at_target',
    tenantId?: string,
  ): void {
    safeMetric(() => {
      counter(
        'renewals_tier_upgrade_audit_emit_failed_total',
        'F8 tier-upgrade audit emit failed (forensic chain may have a gap)',
      ).add(1, {
        audit_type: auditType,
        ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
      });
    });
  },

  /**
   * R5-S1 close (Phase 10 R5 verify-fix) — at-risk-score audit emit
   * failure counter. Companion to `tierUpgradeAuditEmitFailed` +
   * `escalationTaskAuditEmitFailed`. Bumped from
   * `compute-at-risk-score.ts` skip-audit catch arm (the audit row
   * never lands but the cron rolls forward — without this counter
   * the silent dropped audit is invisible to SRE). Vercel alert rule:
   * any non-zero rate over 5 min indicates Constitution Principle VIII
   * forensic chain gap.
   *
   * R6-types-IMP2 narrow: the union below originally included 3
   * audit types but only `at_risk_skipped_below_min_tenure` is
   * actually emitted from a swallow-able catch arm. The other two
   * (`at_risk_score_recomputed` + `at_risk_score_threshold_crossed`)
   * are emitted INSIDE `runInTenant(tx, ...)` blocks where any throw
   * rolls back state atomically — there's no catch arm that swallows
   * + bumps a counter. Narrowing the union to the actual call site
   * makes the type honest + future drift surfaces at compile time
   * if a new swallow-able audit emission lands.
   */
  atRiskAuditEmitFailed(
    auditType: 'at_risk_skipped_below_min_tenure',
    tenantId: string,
  ): void {
    safeMetric(() => {
      counter(
        'renewals_at_risk_audit_emit_failed_total',
        'F8 at-risk audit emit failed (forensic chain may have a gap)',
      ).add(1, { audit_type: auditType, tenant_id: tenantId });
    });
  },

  /**
   * F8 Phase 7 review-fix Round 2 IMP-6 — TierBucket parse-failure
   * counter for the Drizzle plan-catalog adapter. Bumped per row
   * dropped due to unparseable `renewal_tier_bucket`. Companion to
   * the new audit `tier_upgrade_catalogue_row_dropped`. Vercel alert
   * rule: any non-zero rate over 5 min indicates DB drift before it
   * silently zeros eligibility decisions.
   */
  planCatalogueUnparseableBucket(tenantId: string): void {
    safeMetric(() => {
      counter(
        'renewals_plan_catalogue_unparseable_bucket_total',
        'F8 plan-catalog adapter dropped a row whose renewal_tier_bucket failed parseTierBucket — DB drift signal',
      ).add(1, { tenant: tenantId });
    });
  },

  /**
   * F8 Phase 7 review-fix Round 2 SUG-6 — apply-pending post-paid
   * failure counter. Bumped from the F4 onPaidCallback INVALID_TX
   * fallback when `applyPendingTierUpgradeInTx` throws after F4 has
   * committed the paid invoice. Companion to the new audit
   * `tier_upgrade_apply_post_invoice_paid_failed`.
   */
  tierUpgradeApplyPostPaidFailed(tenantId: string): void {
    safeMetric(() => {
      counter(
        'renewals_tier_upgrade_apply_post_paid_failed_total',
        'F8 apply-pending threw after F4 committed paid invoice — suggestion stuck in accepted_pending_apply against a paid cycle',
      ).add(1, { tenant: tenantId });
    });
  },

  /**
   * F8 Phase 7 review-fix I-ERR-2 — tier-upgrade member-notify failure
   * counter. Fires when `RenewalGateway.sendTierUpgradeApprovalEmail`
   * returns err after retry-budget exhaustion OR when the post-tx
   * notification path catches an exception. Companion to the new
   * audit `tier_upgrade_pending_member_notify_failed`.
   */
  tierUpgradeNotifyFailed(
    failureKind:
      | 'gateway_4xx'
      | 'gateway_5xx'
      | 'recipient_unsubscribed'
      | 'recipient_email_unverified'
      | 'template_variables_missing'
      | 'no_primary_contact'
      | 'render_failed'
      | 'unknown',
  ): void {
    safeMetric(() => {
      counter(
        'renewals_tier_upgrade_notify_failed_total',
        'F8 tier-upgrade approval email failed (member never told their upgrade was approved)',
      ).add(1, { failure_kind: failureKind });
    });
  },

  /**
   * F8 Phase 7 review-fix S-2-errors — reschedule listener bucket-
   * resolution failure counter. Fires when `loadPlanFrozenFields` for
   * the old or new plan returns `not_found`, leaving the `renewal_
   * schedule_rescheduled` audit unemitted. Companion to the new audit
   * `renewal_schedule_reschedule_skipped`.
   */
  rescheduleBucketResolutionFailed(
    side: 'old' | 'new' | 'both',
  ): void {
    safeMetric(() => {
      counter(
        'renewals_reschedule_bucket_resolution_failed_total',
        'F8 reschedule listener could not resolve a tier-bucket for the F2 plan-change event',
      ).add(1, { side });
    });
  },

  /**
   * F8 Phase 7 review-fix Round 4 IMP-8 + Round 5 IMP-6 — dedicated
   * audit-emit failure counter for the reschedule listener. Mirrors
   * `tierUpgradeAuditEmitFailed` and `coordinatorAuditEmitFailed`
   * precedents.
   *
   * Why a separate counter (not `manualPlanChangeListenerFailed`):
   * after Round 3 CRIT-1 the reschedule emits use `emit()` (own tx).
   * Two failure subclasses with different observability paths:
   *
   *   1. **Pre-flight pgEnum-drift** — emitter calls `pinoFallback`
   *      OUTSIDE its inner try/catch (drizzle-renewal-audit-emitter.ts
   *      lines 374-381) which DOES throw in production. The throw
   *      escapes `emit()` and gets caught by the per-emit try/catch
   *      in reschedule-on-plan-change.ts → THIS counter bumps.
   *   2. **Runtime DB faults** (RLS misconfig, NOT-NULL, infra outage)
   *      — caught INSIDE the emitter (lines 386-409) with
   *      `logger.error`, then swallowed (fire-and-forget contract).
   *      Does NOT escape, so the per-emit try/catch never fires AND
   *      this counter does NOT bump. The audit-row loss is signalled
   *      ONLY by the pino log line at the emitter's catch site.
   *
   * Practical effect: this counter is the alert signal for the
   * pgEnum-drift class; runtime DB-fault audit-row loss is signalled
   * by a Sentry/Vercel pino-log scrape on `[F8 audit emit] ... DB
   * insert failed` — the on-call runbook (POST-MVP-OBS-7 in
   * docs/phases-plan.md) MUST cover both signals.
   *
   * Round 4 SUG-4 + Round 5 IMP-13 design note: counter signature
   * uses a hand-mirrored audit-event literal-union by intention
   * (Constitution Principle III — `src/lib/metrics.ts` is cross-
   * cutting and must not import bounded-context types). Drift cost
   * is bounded — 2-element set; an audit event-name rename would
   * CI-fail at the audit emit site BEFORE reaching this counter.
   */
  rescheduleAuditEmitFailed(
    auditType:
      | 'renewal_schedule_reschedule_skipped'
      | 'renewal_schedule_rescheduled',
  ): void {
    safeMetric(() => {
      counter(
        'renewals_reschedule_audit_emit_failed_total',
        'F8 reschedule listener audit emit failed (pgEnum-drift class only — runtime DB-fault losses signalled via pino log scrape)',
      ).add(1, { audit_type: auditType });
    });
  },

  /**
   * F8 Phase 7 review-fix S-3-errors — per-orphan reconcile failure
   * counter. Counts individual `tier_upgrade_pending_orphan_detected`
   * dismiss-+-emit failures inside the weekly reconcile cron.
   * `dismissed++` only on success, so this counter surfaces the
   * difference for per-tenant alert routing.
   */
  tierUpgradeReconcileErrors(tenantId: string): void {
    safeMetric(() => {
      counter(
        'renewals_tier_upgrade_reconcile_errors_total',
        'F8 reconcile-pending-applications failed to dismiss an orphan suggestion (continues with next)',
      ).add(1, { tenant_id: tenantId });
    });
  },

  coordinatorAuditEmitFailed(
    cronKind:
      | 'dispatch'
      | 'at_risk_recompute'
      | 'lapse'
      | 'reconcile'
      | 'tier_upgrade_evaluate'
      | 'tier_upgrade_reconcile'
      | 'prune_consumed_tokens',
  ): void {
    safeMetric(() => {
      counter(
        'renewals_coordinator_audit_emit_failed_total',
        'F8 cron coordinator failed to emit orchestrated audit (compliance trail loss)',
      ).add(1, { cron_kind: cronKind });
    });
  },

  /**
   * `renewals_prune_consumed_tokens_runs_total{tenant_id, outcome}` —
   * Phase 9 retrofit (PR #25 review-fix Round 2). Run-count counter
   * incremented exactly once per cron pass with `outcome ∈
   * {success, failure}`.
   *
   * Pairs with `pruneConsumedTokensRowsPruned` (row-count counter); the
   * pair was split from a previous combined counter that conflated
   * "rows deleted" with "passes completed" semantics — Round 2
   * /review issue A.
   *
   * Ops signals:
   *   1. **Steady-state visibility** — operators see a weekly tick on
   *      the `success`-labelled counter; absence = cron-job.org
   *      dashboard entry missing or broken.
   *   2. **Failure alert** — any non-zero `failure` rate is a stop-
   *      the-line indicator (transient Neon connection-pool
   *      exhaustion, Vercel function timeout, RLS policy regression).
   *      The pino `cron.renewals.prune_consumed_tokens.failed` /
   *      `.unexpected_error` log lines carry the diagnostic context.
   *
   * Cardinality bound: 2 dimensions — outcome (2 values: success,
   * failure) × tenant_id (low cardinality, bounded by tenant count).
   */
  pruneConsumedTokensRunCompleted(
    tenantId: string,
    outcome: 'success' | 'failure',
  ): void {
    safeMetric(() => {
      counter(
        'renewals_prune_consumed_tokens_runs_total',
        'F8 prune-consumed-tokens cron pass result (1 per invocation)',
      ).add(1, {
        tenant_id: tenantId,
        outcome,
      });
    });
  },

  /**
   * `renewals_prune_consumed_tokens_rows_deleted_total{tenant_id}` —
   * Phase 9 retrofit (PR #25 review-fix Round 2). Row-count counter
   * incremented by the number of `consumed_link_tokens` rows the
   * weekly prune actually deleted. Emitted ONLY on the success path
   * (the failure path emits nothing here; the run-count counter
   * carries the failure signal).
   *
   * A 0-row pass is normal at SweCham scale (steady-state weekly
   * deletes are rare — most tokens expire via the 30-day payload TTL
   * before the 60-day prune cutoff). Operators query
   * `increase(...rows_deleted_total[30d])` for capacity planning;
   * a non-zero rate confirms the prune is finding eligible rows.
   *
   * Cardinality bound: 1 dimension — tenant_id (low cardinality,
   * bounded by tenant count; no `outcome` label by design since this
   * counter is success-only emission).
   */
  pruneConsumedTokensRowsPruned(
    tenantId: string,
    rowCount: number,
  ): void {
    safeMetric(() => {
      counter(
        'renewals_prune_consumed_tokens_rows_deleted_total',
        'F8 prune-consumed-tokens cron — rows actually deleted from consumed_link_tokens',
      ).add(rowCount, { tenant_id: tenantId });
    });
  },

  /**
   * `renewals_webhook_schema_rejected_total{event_type}` — H11: Resend
   * webhook payload failed our zod schema (Resend renamed/removed a
   * field, e.g. the `bounce.type` addition that landed in 2024). The
   * route returns HTTP 200 to prevent Resend retry storm; this counter
   * is the alert-pipeline trigger for schema drift. Any non-zero rate
   * means our webhook handler may be silently dropping events.
   */
  webhookSchemaRejected(eventType: string | null): void {
    safeMetric(() => {
      counter(
        'renewals_webhook_schema_rejected_total',
        'Resend webhook body rejected our zod schema (schema-drift alert trigger)',
      ).add(1, { event_type: eventType ?? 'unknown' });
    });
  },

  /**
   * `renewals_unknown_resend_error_name_total{error_name}` — K12-4
   * (REL-K-2): Resend SDK returned an error with a name not in the
   * `PERMANENT_RESEND_ERROR_PATTERNS` allowlist. The classifier
   * defaults to transient (`gateway_5xx`) → 24h retry budget burns
   * before giving up. Without this counter the team only sees a
   * `logger.warn` line that requires log-grep to discover. Alert rule:
   * any non-zero rate over a 5-min window pages on-call so the team
   * can extend the allowlist before the retry storm escalates.
   *
   * `error_name` is the Resend-supplied `error.name` (bounded
   * cardinality in steady state — Resend's error taxonomy is small;
   * a sustained high-cardinality spike here is itself the alert
   * signal that something is wrong upstream).
   */
  unknownResendErrorName(errorName: string): void {
    safeMetric(() => {
      counter(
        'renewals_unknown_resend_error_name_total',
        'Resend SDK returned an error.name outside the PERMANENT allowlist (alert trigger)',
      ).add(1, { error_name: errorName });
    });
  },

  /**
   * `renewals_redis_fallback_total` — K14-5 (R13-S2): Upstash outage on
   * the cron-401 rate-limit path. K13-1 fail-open semantics route the
   * request through to audit-emit + 401 (correct), but Vercel alert
   * rules attach to OTel counters not log strings — without this
   * metric the warn-log alone would not page on-call. Mirrors
   * `authMetrics.redisFallback` + `outboxMetrics.stuckRows` patterns.
   * Alert rule: any non-zero rate sustained for 5 min.
   */
  redisFallback(): void {
    safeMetric(() => {
      counter(
        'renewals_redis_fallback_total',
        'Count of Upstash fail-open events on F8 cron rate-limit paths (alert any non-zero rate)',
      ).add(1);
    });
  },

  /**
   * `renewals_admin_reject_total{tenant, outcome}` — I9 review-fix
   * (Phase 5 / US3 backlog close): F8 admin-reject of a
   * `pending_admin_reactivation` cycle. `outcome` discriminates:
   *
   *   - `refunded` — F5 refund succeeded; F4 credit-note cascaded;
   *     post-refund escalation task inserted for finance reconciliation.
   *   - `no_payment` — cycle had no linkedInvoiceId (rare manual-block
   *     pre-payment path); cycle cancelled without refund.
   *   - `failed` — cycle never transitioned (refund_failed or
   *     transition lost race).
   *
   * Alert rule: a sustained `failed` rate >0 for 15 min pages on-call —
   * indicates F5 refund pipeline is degraded and admins are getting
   * stuck cycles. Steady-state `refunded` is informational only.
   */
  adminRejectCompleted(
    tenantId: string,
    outcome: 'refunded' | 'no_payment' | 'failed',
  ): void {
    safeMetric(() => {
      counter(
        'renewals_admin_reject_total',
        'F8 admin-reject of pending_admin_reactivation cycles, partitioned by refund outcome',
      ).add(1, { tenant: tenantId, outcome });
    });
  },

  /**
   * `renewals_reminder_audit_query_failures_total{tenant}` — Round 2
   * review-fix (I-1): the `reconcilePendingReactivations` cron's
   * audit-existence query failed (DB connection hiccup, RLS misconfig,
   * etc.) and the cron fell back to fire-all-crossed-rungs. Trade-off
   * accepted per Constitution Principle V (Reliability) — the
   * dispatcher cron's send-side dedupe (Resend idempotency) bounds the
   * blast radius — but a sustained non-zero rate signals
   * (a) audit_log connection pool exhaustion, or (b) RLS/role drift
   * that is silently degrading the cron's catch-up correctness.
   * Alert rule: any non-zero rate sustained for 10 min pages on-call.
   */
  reminderAuditQueryFailures: {
    add(value: number, attrs: { tenant_id: string }): void {
      safeMetric(() => {
        counter(
          'renewals_reminder_audit_query_failures_total',
          'F8 reconcile-pending-reactivations audit-existence query failed; cron fell back to fire-all-crossed-rungs',
        ).add(value, { tenant: attrs.tenant_id });
      });
    },
  },

  /**
   * `renewals_reminder_audit_emit_failures_total{tenant, type}` —
   * Round 2 review-fix (I-6): a reminder-rung audit emit threw inside
   * `reconcilePendingReactivations`. Previously swallowed by a
   * `logger.warn` with no metric → a misconfigured RLS / connection
   * pool exhaustion / unique-constraint regression could silently
   * drop every reminder for weeks before a member-support ticket
   * surfaced the problem. The cron's success counters
   * (`remindersT7/T3/T1`) only bump on emit-success now (parity with
   * `timeoutRefundFailures`), and this counter tracks the failures.
   * Alert rule: any non-zero rate sustained for 10 min pages on-call.
   */
  reminderAuditEmitFailures: {
    add(
      value: number,
      attrs: { tenant_id: string; type: string },
    ): void {
      safeMetric(() => {
        counter(
          'renewals_reminder_audit_emit_failures_total',
          'F8 reconcile-pending-reactivations failed to emit a reminder-rung audit row (forensic-trail loss)',
        ).add(value, {
          tenant: attrs.tenant_id,
          type: attrs.type,
        });
      });
    },
  },

  /**
   * `renewals_onpaid_invalid_tx_total{tenant}` — Round 3 review-fix
   * (R3-I8): F4 → F8 onPaidCallback received a non-`TenantTx` value
   * for the optional `tx` parameter, so F8 fell back from the I3
   * atomic-single-tx path to the legacy two-tx eventual-consistency
   * path (`runInTenant` opens a fresh tx). Indicates F4 contract drift
   * — a refactor wrapped tx in instrumentation, a future cross-module
   * wiring forgot to thread the tx, or a polyfill stripped the
   * Drizzle method shape. Pattern precedent: `bounceHookFailed` /
   * `redisFallback` — log alone is not enough because Vercel alert
   * rules attach to OTel counters not log strings.
   * Alert rule: any non-zero rate sustained for 5 min pages on-call.
   */
  onPaidInvalidTx: {
    add(value: number, attrs: { tenant_id: string }): void {
      safeMetric(() => {
        counter(
          'renewals_onpaid_invalid_tx_total',
          'F4 → F8 onPaidCallback received a non-TenantTx value; F8 fell back to runInTenant (degraded mode — atomic single-tx invariant lost)',
        ).add(value, { tenant: attrs.tenant_id });
      });
    },
  },

  /**
   * `renewals_lapse_cycles_errors_total{tenant}` — T115a Phase 5
   * wave K24: per-cycle errors during the daily
   * `lapseCyclesOnGraceExpiry` cron (F5 bridge query failure / DB
   * transition throw / audit emit failure). Per-cycle fault isolation
   * means one bad cycle doesn't abort the run; this counter tracks
   * the aggregate so SREs can alert on a cron-wide degradation.
   * Alert rule: any non-zero rate sustained for 15 min pages on-call.
   */
  lapseCyclesErrors: {
    add(value: number, attrs: { tenant_id: string }): void {
      safeMetric(() => {
        counter(
          'renewals_lapse_cycles_errors_total',
          'F8 lapseCyclesOnGraceExpiry per-cycle error count (decision-branch query failures + DB transition throws + audit emit failures); cron continues per-member fault-isolated',
        ).add(value, { tenant: attrs.tenant_id });
      });
    },
  },

  /**
   * `renewals_onpaid_unknown_outcome_kind_total{tenant}` — Round 4
   * review-fix (R4-S1): F8 dispatch site received a
   * `MarkCycleCompleteOutcome` whose `kind` is not one of the 4 known
   * variants enumerated by the exhaustive switch at
   * `renewals-deps.ts`. The TS `_exhaustive: never` pin guarantees
   * compile-time exhaustiveness in steady state; this counter pages
   * on the deploy-skew window when (a) the use-case ships a 5th
   * variant before the dispatch site rebuilds, OR (b) a runtime
   * polyfill / hot-fix bundles only the use-case bundle. Without
   * this counter the unknown variant would silently swallow the
   * cycle-flip (F4 commits, F8 audit/state untouched). Pattern matches
   * `onPaidInvalidTx` precedent.
   * Alert rule: any non-zero rate pages on-call (deploy-skew is
   * always a real incident — there is no benign occurrence).
   */
  onPaidUnknownOutcomeKind: {
    add(value: number, attrs: { tenant_id: string }): void {
      safeMetric(() => {
        counter(
          'renewals_onpaid_unknown_outcome_kind_total',
          'F8 dispatch received a MarkCycleCompleteOutcome with an unknown kind — deploy-skew between use-case and renewals-deps suspected',
        ).add(value, { tenant: attrs.tenant_id });
      });
    },
  },

  // ==========================================================================
  // F8 Phase 9 / T231 — business-volume counters per spec FR-054 + § 23.1
  //
  // Distinct from the operational counters above (bounce-hook-failed,
  // audit-emit-failed, redis-fallback) which page on incident; these
  // counters power the ops dashboard view of "what F8 actually did
  // today" and feed the SLO panels per docs/observability.md § 23.2.
  //
  // Cardinality discipline: every label is a bounded enum or small-
  // cardinality string. NEVER use member id / email / IP as a label —
  // those belong in traces + logs, not metrics.
  // ==========================================================================

  /**
   * `renewals_reminders_sent_total{tier_bucket, offset_day}` — total
   * count of reminder emails successfully dispatched. Pivot table for
   * dispatcher health; correlates with Resend deliverability metrics.
   * `tier_bucket` ∈ 5-value enum (regular | premium | partner_silver |
   * partner_gold | partner_diamond). `offset_day` ∈ ~6-value bounded
   * set (90 / 60 / 30 / 14 / 7 / 0).
   */
  remindersSent(tier_bucket: string, offset_day: number): void {
    safeMetric(() => {
      counter(
        'renewals_reminders_sent_total',
        'F8 reminder emails successfully dispatched (FR-010)',
      ).add(1, { tier_bucket, offset_day: String(offset_day) });
    });
  },

  /**
   * `renewals_reminders_skipped_total{reason}` — count of reminders
   * the dispatcher chose NOT to send, by skip reason (FR-012). Pairs
   * with `dispatch-one-cycle.ts:emitSkipAudit` skip-reason matrix.
   * Dashboard view: stack-bar across reasons over time. Sustained
   * spike in `bounce_threshold` or `member_opted_out` rates may
   * signal a drop in chamber-side data hygiene.
   */
  remindersSkipped(reason: string): void {
    safeMetric(() => {
      counter(
        'renewals_reminders_skipped_total',
        'F8 reminder skipped at dispatch (FR-012 skip-reason taxonomy)',
      ).add(1, { reason });
    });
  },

  /**
   * `renewals_reminders_failed_total{reason}` — count of reminders
   * that failed at the gateway boundary (FR-010a retry-budget path).
   * `reason` is a Resend-error kind (`network` | `provider_5xx` |
   * `auth` | `unknown`). Sustained non-zero is an alert signal.
   */
  remindersFailed(reason: string): void {
    safeMetric(() => {
      counter(
        'renewals_reminders_failed_total',
        'F8 reminder dispatch failed at gateway boundary (FR-010a)',
      ).add(1, { reason });
    });
  },

  /**
   * `renewals_self_service_completed_total{tenant}` — successful
   * member-confirm events on `/portal/renewal/[memberId]/confirm`
   * (US3). Per-tenant cardinality is bounded (single-digit tenants in
   * MVP). Powers the conversion-funnel dashboard alongside the
   * `self_service_failed_total` denominator.
   */
  selfServiceCompleted(tenant: string): void {
    safeMetric(() => {
      counter(
        'renewals_self_service_completed_total',
        'F8 member self-service renewal confirm succeeded (US3)',
      ).add(1, { tenant });
    });
  },

  /**
   * `renewals_self_service_failed_total{tenant, reason}` — confirm
   * failures by reason (`f4_invoice_create_failed` |
   * `payment_failed` | `cycle_terminal` | `token_invalid`). The F4
   * + F5 integration boundaries surface here; sustained
   * `f4_invoice_create_failed` is a stop-the-line for the
   * F4 onPaid bridge.
   */
  selfServiceFailed(tenant: string, reason: string): void {
    safeMetric(() => {
      counter(
        'renewals_self_service_failed_total',
        'F8 member self-service renewal confirm failed (US3)',
      ).add(1, { tenant, reason });
    });
  },

  /**
   * `at_risk_scores_recomputed_total{tenant}` — total score writes
   * per recompute pass. Pairs with the per-tenant `recompute_duration_ms`
   * histogram already in the operational block above. Sustained
   * step-function drop = active-member churn signal.
   */
  atRiskScoresRecomputed(tenant: string): void {
    safeMetric(() => {
      counter(
        'at_risk_scores_recomputed_total',
        'F8 at-risk score recomputed per member per pass (FR-029)',
      ).add(1, { tenant });
    });
  },

  /**
   * `at_risk_threshold_crossings_total{tenant, from_band, to_band}` —
   * count of members whose risk band moved between bands (low /
   * medium / high / critical) on a recompute pass. Both directions
   * (improving + degrading) so dashboards can plot net flow.
   * Bounded label cardinality: 4 × 4 = 16 combinations max per
   * tenant. Crossings into `high`/`critical` are the value-add
   * signal that powers the at-risk widget badge.
   */
  atRiskThresholdCrossing(
    tenant: string,
    from_band: string,
    to_band: string,
  ): void {
    safeMetric(() => {
      counter(
        'at_risk_threshold_crossings_total',
        'F8 at-risk band crossing per member per recompute pass (FR-029)',
      ).add(1, { tenant, from_band, to_band });
    });
  },

  /**
   * `tier_upgrade_suggestions_created_total{tenant, target_tier}` —
   * cron creates a new `open` suggestion. `target_tier` is the same
   * 5-bucket enum as `remindersSent`. Pivot view: cross-tenant
   * funnel of suggestions vs accepts vs dismisses (FR-037 → FR-039).
   */
  tierUpgradeSuggestionsCreated(
    tenant: string,
    target_tier: string,
  ): void {
    safeMetric(() => {
      counter(
        'tier_upgrade_suggestions_created_total',
        'F8 cron created a tier-upgrade suggestion (FR-037)',
      ).add(1, { tenant, target_tier });
    });
  },

  /**
   * `tier_upgrade_suggestions_accepted_total{tenant}` — admin Accept
   * action on the tier-upgrade queue (FR-039). Dashboard ratio with
   * `created_total` measures admin engagement; sustained zero
   * suggests UI-discoverability or copy issues.
   */
  tierUpgradeSuggestionsAccepted(tenant: string): void {
    safeMetric(() => {
      counter(
        'tier_upgrade_suggestions_accepted_total',
        'F8 admin accepted a tier-upgrade suggestion (FR-039)',
      ).add(1, { tenant });
    });
  },

  /**
   * Observable gauges for renewal_cycles state. Coordinator routes
   * call `observeCycleStateGauge(tenant, 'active' | 'in_grace' |
   * 'lapsed_total', count)` after each cron pass; the OTel async
   * observer reads from `gaugeValues` at scrape time.
   *
   * Cardinality bound: small-tenant-count × 3-state-enum. Lazy-
   * registers the observable on first call per state.
   *
   * **Per-process accumulator semantics** (Phase 9 verify-fix C1):
   * The `gaugeValues` map is a process-level singleton. Each call to
   * `observeCycleStateGauge(tenantA, state, value)` writes to
   * `gaugeValues[renewals_cycles_${state}][tenantA]`; subsequent
   * scrapes read ALL tenants accumulated in the inner Map. This is
   * INTENTIONAL multi-tenant accumulation — Vercel function instances
   * may serve multiple tenants over their lifetime, and the gauge
   * MUST report the most-recent observed value per tenant (not just
   * the last writer's tenant). The OTel callback iterates the inner
   * Map's `.entries()` so every tenant slug appears as a distinct
   * label series at scrape time.
   *
   * Smoke-tested by `tests/unit/lib/metrics-cycle-state-gauge.test.ts`
   * (Phase 9 verify-fix C1). The unit test asserts the public API
   * shape (no-throw on every documented call signature, including
   * multi-tenant accumulation, overwrite-on-re-observe, state
   * isolation, zero values, and 5000-member SLO ceiling). The
   * end-to-end OTel callback path (gauge.addCallback iterating
   * `bucket.entries()` at scrape time) is exercised in production
   * through the `@vercel/otel` exporter wired by `instrumentation.ts`
   * — vitest's no-exporter environment cannot invoke the callback,
   * so `bucket.entries()`-vs-`bucket.values()` regressions would
   * surface at deploy time via the OTel scrape, not at unit-test
   * time. Document this gap explicitly so a future maintainer
   * knows the invariant is end-to-end-tested via OTel staging,
   * not unit-tested.
   *
   * Test-isolation note: vitest `beforeEach` does NOT reset
   * `gaugeValues` automatically (it's a module-level closure cache).
   * Tests that need a clean slate should call
   * `gaugeValues.delete('renewals_cycles_<state>')` directly OR
   * use unique tenant slugs per test (the recommended pattern —
   * mirrors `createTestTenant`'s UUID-suffix isolation strategy).
   */
  observeCycleStateGauge(
    tenant: string,
    state: 'active' | 'in_grace' | 'lapsed_total',
    value: number,
  ): void {
    safeMetric(() => {
      const gaugeName = `renewals_cycles_${state}`;
      const stateBucket = gaugeValues.get(gaugeName) ?? new Map<string, number>();
      stateBucket.set(tenant, value);
      gaugeValues.set(gaugeName, stateBucket);

      if (!observableGauges.has(gaugeName)) {
        const descriptions: Record<typeof state, string> = {
          active: 'F8 active renewal cycles per tenant (FR-046)',
          in_grace: 'F8 cycles within grace-period window per tenant (FR-004)',
          lapsed_total: 'F8 lapsed cycles per tenant (FR-007a denominator)',
        };
        const gauge = meter().createObservableGauge(gaugeName, {
          description: descriptions[state],
        });
        observableGauges.set(gaugeName, gauge);
        gauge.addCallback((result) => {
          const bucket = gaugeValues.get(gaugeName);
          if (!bucket) return;
          for (const [tenantLabel, count] of bucket.entries()) {
            result.observe(count, { tenant: tenantLabel });
          }
        });
      }
    });
  },

  /**
   * Phase 9 verify-fix close-on-review — F8 cascade outcome counter.
   *
   * Mirrors `broadcastsMetrics.cascadeOutcome` so the F3 ↔ F8 cascade
   * (cancelInFlightCyclesForMember from archive-member) emits a
   * dashboardable signal on every outcome. Without this, the F8
   * cascade was log-only — `audit-emit-loss.md` runbook could not
   * alert on F8 cascade health the way it can for F7. Constitution
   * Principle VII (perf+observability) close.
   *
   * `kind` enum is bounded:
   *   - `'cancelled'`         — cascade transitioned a cycle to cancelled
   *   - `'concurrent_skip'`   — concurrent admin cancel won the race
   *   - `'audit_emit_failed'` — audit-emit failure inside cascade tx
   *                             (Principle VIII rollback path)
   *   - `'unexpected_error'`  — outer-catch fallback / use-case throw
   */
  cascadeOutcome(
    tenantId: string,
    kind:
      | 'cancelled'
      | 'concurrent_skip'
      | 'audit_emit_failed'
      | 'unexpected_error',
  ): void {
    safeMetric(() => {
      counter(
        'renewals_cascade_outcome_total',
        'F8 F3-archival cascade outcome per member-archive event',
      ).add(1, { tenant: tenantId, kind });
    });
  },

  /**
   * Phase 9 verify-fix close-on-review — coordinator READ_ONLY_MODE
   * skip counter. The 4 coordinator routes return 200 + skipped on
   * `env.flags.readOnlyMode === true` to avoid cron-job.org retry-
   * storm; without a metric, operators cannot dashboard "how many
   * cron passes were swallowed during the maintenance window". A
   * flag-flap leaving READ_ONLY_MODE=true past the maintenance
   * window would otherwise look identical to a normal cron response
   * from outside.
   */
  coordinatorSkippedReadOnly(
    cron_kind:
      | 'dispatch'
      | 'at_risk_recompute'
      | 'lapse'
      | 'reconcile'
      | 'prune_consumed_tokens',
  ): void {
    safeMetric(() => {
      counter(
        'renewals_coordinator_skipped_read_only_total',
        'F8 coordinator pass short-circuited by READ_ONLY_MODE flag',
      ).add(1, { cron_kind });
    });
  },

  // ============================================================
  // F8 Phase 8 — Escalation task queue (R10 W9 + T277g close)
  // ============================================================
  // Wires the 4 metrics documented at `docs/observability.md` § 23
  // Phase 8 R10 W9 forward block. F8-SLO-Esc-1 + F8-A8 reference.
  // ============================================================

  /**
   * `renewals_escalation_task_queue_load_duration_ms` — `tasks/page.tsx`
   * server component records the wall-clock for the bundled `repo.list`
   * + `repo.countMatching` calls. Powers F8-SLO-Esc-1 (p95 < 500 ms
   * @ 200 open tasks per tenant). Labels kept low-cardinality:
   * `tenant_id`, `assignment_filter ∈ {all,mine,unassigned,specific}`,
   * `status_filter ∈ {open,done,skipped}`.
   */
  escalationTaskQueueLoadDurationMs(
    ms: number,
    labels: {
      tenant: string;
      assignment_filter: 'all' | 'mine' | 'unassigned' | 'specific';
      status_filter: 'open' | 'done' | 'skipped';
    },
  ): void {
    safeMetric(() => {
      histogram(
        'renewals_escalation_task_queue_load_duration_ms',
        'F8 escalation task queue page-load latency, p95 target 500ms (F8-SLO-Esc-1)',
        'ms',
      ).record(ms, labels);
    });
  },

  /**
   * `renewals_escalation_task_action_total` — done/skip/reassign POST
   * outcomes. `outcome` discriminator covers the Result.error union +
   * happy path. Powers F8-A8 alarm on `outcome="server_error" ≥ 3 / 5min`.
   */
  escalationTaskAction(
    tenant: string,
    action: 'done' | 'skip' | 'reassign',
    outcome:
      | 'success'
      | 'task_not_found'
      | 'task_not_open'
      | 'invalid_input'
      | 'server_error',
  ): void {
    safeMetric(() => {
      counter(
        'renewals_escalation_task_action_total',
        'F8 escalation task admin action outcomes (done/skip/reassign × success/4xx/5xx)',
      ).add(1, { tenant, action, outcome });
    });
  },

  /**
   * `renewals_escalation_task_overdue_count` — async observable gauge.
   * `tasks/page.tsx` calls this after each page-load with the
   * `countMatching({overdueOnly:true,overdueThresholdDays:3})` value.
   * Powers FR-045 banner-count panel.
   */
  observeEscalationTaskOverdueCount(tenant: string, count: number): void {
    safeMetric(() => {
      observeGauge(
        'renewals_escalation_task_overdue_count',
        'F8 open escalation tasks more than 3 days past due, per tenant (FR-045)',
        { tenant },
        count,
      );
    });
  },

  /**
   * `renewals_escalation_task_audit_emit_failed_total` — incremented in
   * the catch arm of the 3 mutating use-cases (complete/skip/reassign)
   * when `auditEmitter.emitInTx` fails inside the tx. The use-case
   * still propagates the throw to roll the state change back per
   * Constitution VIII; this counter feeds F8-A2 (rolls into the existing
   * audit-emit alarm on the coordinator namespace).
   */
  escalationTaskAuditEmitFailed(
    tenant: string,
    event_type: 'completed' | 'skipped' | 'reassigned',
  ): void {
    safeMetric(() => {
      counter(
        'renewals_escalation_task_audit_emit_failed_total',
        'F8 escalation task audit emit failed inside use-case tx (rolls back per Constitution VIII)',
      ).add(1, { tenant, event_type });
    });
  },
} as const;

// ---------------------------------------------------------------------------
// F6 EventCreate Integration — FR-036 metrics (Phase 3 minimum subset)
//
// `eventcreate_webhook_receipts_total` powers the R10 signature-rejection-
// burst alert; `eventcreate_webhook_ingest_latency_ms` powers the
// SC-003 p95 < 300ms SLO. Remaining FR-036 metrics (#3 match_rate_gauge,
// #4 csv_import_duration, #5–7 quota/refund, #8 secret_rotation,
// #9 ingest_disabled_gauge, #10 pseudonymisation_sweep, #11
// idempotency_sweep) land in their respective feature phases.
// ---------------------------------------------------------------------------

export const eventcreateMetrics = {
  /**
   * FR-036 #1 — `eventcreate_webhook_receipts_total`.
   * Counter labelled by tenant + signature_outcome + processing_outcome.
   * Signature-rejection-burst alert (R10) fires on rate of
   * `signature_outcome != 'verified'` per tenant. Processing-outcome
   * dashboards track match-cascade health.
   */
  webhookReceiptsTotal(
    tenantId: string,
    signatureOutcome:
      | 'verified'
      | 'rejected_bad_sig'
      | 'rejected_timestamp_skew'
      | 'rejected_missing_header'
      | 'rejected_malformed_timestamp',
    processingOutcome:
      | 'matched_member_contact'
      | 'matched_member_domain'
      | 'matched_member_fuzzy'
      | 'non_member'
      | 'unmatched'
      | 'duplicate'
      | 'malformed'
      | 'rolled_back'
      | 'rate_limited'
      | 'ingest_disabled'
      | 'unauthorized'
      | 'unsupported_media_type'
      | 'tenant_not_found'
      | 'short_circuited_test'
      | 'n_a',
  ): void {
    safeMetric(() => {
      counter(
        'eventcreate_webhook_receipts_total',
        'F6 webhook delivery counter by signature + processing outcome (FR-036 #1)',
      ).add(1, {
        tenant: tenantId,
        signature_outcome: signatureOutcome,
        processing_outcome: processingOutcome,
      });
    });
  },

  /**
   * FR-036 #2 — `eventcreate_webhook_ingest_latency_ms` histogram.
   * SC-003 target: p95 < 300ms at design envelope. Captured by the
   * use-case at line ~306 (`startedAtMs = Date.now()`) and emitted by
   * the route after Result resolution (success or rolled_back).
   */
  ingestLatencyMs(tenantId: string, latencyMs: number): void {
    safeMetric(() => {
      histogram(
        'eventcreate_webhook_ingest_latency_ms',
        'F6 webhook ingest end-to-end latency, SC-003 target p95 < 300ms (FR-036 #2)',
        'ms',
      ).record(latencyMs, { tenant: tenantId });
    });
  },

  /**
   * Body-size guard counter — surfaces DoS attempts that the body-size
   * cap blocked. Operationally useful for alerting on unusual traffic
   * patterns.
   */
  bodyOversizedTotal(tenantId: string): void {
    safeMetric(() => {
      counter(
        'eventcreate_webhook_body_oversized_total',
        'F6 webhook body exceeded the 64 KiB size cap (DoS guard)',
      ).add(1, { tenant: tenantId });
    });
  },

  /**
   * F6-specific Upstash fail-open counter. Emitted from
   * `events-webhook-deps.ts` when the auth rate-limiter falls back to
   * in-memory bucket. Mirrors `auth_redis_fallback_total` but with a
   * tenant label so dashboards can filter the F6 surface.
   */
  rateLimitFallback(tenantId: string): void {
    safeMetric(() => {
      counter(
        'eventcreate_rate_limit_fallback_total',
        'F6 rate-limit fell back to in-memory bucket (Upstash unreachable)',
      ).add(1, { tenant: tenantId });
    });
  },

  /**
   * Strict-tx FR-037 dual-write fallback double-failure counter.
   * Primary tx rolled back AND `emitRolledBackStandalone` fallback also
   * failed → only stderr forensic trail remains. Pages on first
   * occurrence (catastrophic audit-integrity loss).
   */
  auditFallbackDoubleFailure(tenantId: string, primaryStage: string): void {
    safeMetric(() => {
      counter(
        'eventcreate_audit_fallback_double_failure_total',
        'F6 primary tx rolled back AND audit fallback also failed (FR-037 catastrophic)',
      ).add(1, { tenant: tenantId, primary_stage: primaryStage });
    });
  },

  /**
   * R6-W4 staff-review fix (2026-05-13) — FR-036 #11 (idempotency_sweep).
   *
   * `eventcreate_idempotency_sweep_rows_total` counter — emitted by the
   * daily cron handler that purges expired rows from
   * `eventcreate_idempotency_receipts` (TTL = 7d). Two labels:
   *   - outcome=swept → rows deleted in the run
   *   - outcome=skipped → rows skipped because TTL not yet expired
   *
   * Alert (defined in `docs/observability.md § 24`): `rate(swept) == 0
   * for ≥2 consecutive days while table row count is growing` →
   * stalled-sweep page. The counter is the SLI input; without it the
   * alert is unimplementable.
   *
   * The cron handler that wires this counter ships in Phase 10 (T116).
   * Counter declared now so it is reachable + dashboardable before the
   * handler lands. Zero-emission counter is correctly absent from
   * Prometheus output until first call — no observability noise pre-flag.
   */
  idempotencySweepRowsTotal(
    tenantId: string,
    outcome: 'swept' | 'skipped',
  ): void {
    safeMetric(() => {
      counter(
        'eventcreate_idempotency_sweep_rows_total',
        'F6 idempotency-receipt sweep counter — outcome=swept|skipped (FR-036 #11)',
      ).add(1, { tenant: tenantId, outcome });
    });
  },

  /**
   * FR-036 #8 — `eventcreate_webhook_secret_rotated_total`.
   * Counter incremented every time a tenant admin successfully rotates
   * the webhook secret (FR-008). Per-tenant labelled. Powers the
   * "secret-rotation operational procedure" runbook + dashboards
   * tracking key-rotation hygiene.
   *
   * Emitted by `runRotateWebhookSecret` composition adapter after
   * the use-case returns `Result.ok` (post-tx commit so the metric
   * never overcounts on rollback).
   */
  webhookSecretRotated(tenantId: string): void {
    safeMetric(() => {
      counter(
        'eventcreate_webhook_secret_rotated_total',
        'F6 admin-initiated webhook secret rotations, per tenant (FR-036 #8)',
      ).add(1, { tenant: tenantId });
    });
  },

  /**
   * Round 3 H3 (2026-05-13) — generate counterpart of
   * `webhookSecretRotated`. Powers the same dashboard-truth invariant:
   * the gauge fires when the secret row commits to the DB, regardless
   * of whether the audit trail emit succeeded — operators must SEE the
   * audit-orphan row that an `audit_emit_failed` result leaves behind,
   * not infer it from a `pino.fatal` line that may rotate within
   * minutes in busy production logs.
   *
   * Emitted by `runGenerateWebhookSecret` composition adapter when
   * `result.ok` OR `result.error.kind === 'audit_emit_failed'` (the
   * row IS in the DB in both cases). Round 2 SF-H2 established this
   * pattern for rotate; Round 3 H3 brings generate to parity.
   */
  webhookSecretGenerated(tenantId: string): void {
    safeMetric(() => {
      counter(
        'eventcreate_webhook_secret_generated_total',
        'F6 admin-initiated webhook secret generations, per tenant (Round 3 H3 — dashboard-truth on audit-emit failure)',
      ).add(1, { tenant: tenantId });
    });
  },

  /**
   * FR-036 #9 — `eventcreate_ingest_disabled_tenant` gauge.
   * Async gauge: 1 when the tenant has `enabled=false` on the
   * `tenant_webhook_configs` row (kill-switch ACTIVATED — webhook
   * receiver returns 503), 0 when `enabled=true`. Powers the
   * "ingest-disabled tenant detected" alert per `docs/observability.md`
   * § 24.
   *
   * Emitted by `runDisableIngest` composition adapter immediately
   * after a successful state change. Idempotent: re-setting the same
   * value at every disable/enable toggle is the intended pattern.
   */
  ingestDisabledTenant(tenantId: string, enabled: boolean): void {
    observeGauge(
      'eventcreate_ingest_disabled_tenant',
      'F6 ingest-disabled gauge per tenant — 1=disabled (503), 0=enabled (FR-036 #9)',
      { tenant: tenantId },
      enabled ? 0 : 1,
    );
  },

  /**
   * Phase 5 review-fix W-07 (2026-05-13) — test-webhook invocation
   * counter. Increment every time the admin presses "Test webhook"
   * regardless of outcome (per-tenant labelled, with `outcome` label
   * for `success`/`failure`). Powers the "test-webhook usage" panel
   * + correlates with `webhook_test_invoked` audit events so the
   * dashboard ratio (`audit count / metric count`) surfaces audit-
   * emit drift.
   *
   * Emitted by the `runRunTestWebhook` composition adapter on BOTH
   * the success path AND the use-case failure paths (config_missing,
   * config_load_failed, network_error, etc.).
   */
  webhookTestInvoked(tenantId: string, outcome: 'success' | 'failure'): void {
    safeMetric(() => {
      counter(
        'eventcreate_webhook_test_invoked_total',
        'F6 admin-initiated test-webhook invocations, per tenant + outcome (Phase 5 review-fix W-07)',
      ).add(1, { tenant: tenantId, outcome });
    });
  },
} as const;
