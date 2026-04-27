/**
 * OpenTelemetry metrics (T180, docs/observability.md § 4).
 *
 * Single metrics façade for ALL bounded contexts (F1 auth, F3 outbox,
 * F4 invoicing, F5 payments). Originally scoped to F1 auth only
 * (hence the historical `METER_NAME='swecham.auth'`); CR-8 review
 * 2026-04-27 renamed to `swecham.platform` so the meter accurately
 * reflects scope across F1+F3+F4+F5 instruments. Sub-namespaces
 * (`auth_*`, `outbox_*`, `invoicing_*`, `payments_*`) are encoded in
 * each instrument name, not in separate Meters — this keeps a single
 * scrape pipeline and avoids meter-resolution duplication.
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
  initiateDurationMs(method: 'card' | 'promptpay', ms: number): void {
    histogram(
      'payments_initiate_duration_ms',
      'POST /api/payments/initiate end-to-end latency, p95 target 1500ms',
      'ms',
    ).record(ms, { method });
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
