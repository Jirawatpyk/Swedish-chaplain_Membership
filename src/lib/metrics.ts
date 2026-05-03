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
      | 'delivery_delayed',
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
