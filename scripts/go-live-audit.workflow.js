/*
 * Stage 1 — Go-Live Readiness Audit workflow (AUTHORED AHEAD; NOT YET RUN)
 * ---------------------------------------------------------------------------
 * Plan: docs/go-live-readiness.md · Output target: docs/Bug/go-live-findings.md
 *
 * HOW TO RUN (only after F9 complete + Stage 0 baseline captured):
 *   Workflow({ scriptPath: "scripts/go-live-audit.workflow.js" })
 *
 * Design: fan out across every module + the presentation layer; each unit is
 * reviewed on the per-module readiness dimensions; every P0/P1 finding is then
 * adversarially verified (pipeline, no barrier) before it counts. Global
 * dimensions (operational readiness, data readiness) are NOT here — they are
 * operator gates (runbook) + the importer, handled outside the audit.
 *
 * Posture: Launch-minimal (see § 3.1). Each scope finding carries a decision +
 * rationale so the synthesis can populate the scope-decision log.
 */

export const meta = {
  name: 'go-live-audit',
  description: 'Stage 1 readiness audit — fan out modules × dimensions, adversarially verify, synthesize prioritized findings',
  phases: [
    { title: 'Review' },
    { title: 'Compliance' },
    { title: 'Journeys' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
}

// Horizontal track (Stage 1b): persona journeys across module seams.
const JOURNEYS = [
  { key: 'admin', steps: 'sign-in → manage plans → add/import members → issue invoice → record/track payment → send broadcast → dashboard + audit → renewal/escalation' },
  { key: 'manager', steps: 'sign-in → view members → view invoices (read-only) → dashboard' },
  { key: 'member', steps: 'receive invitation → set password → complete profile → view own plan + tier benefits → view/pay invoice → update profile → request GDPR export → unsubscribe broadcast → act on renewal reminder' },
]

// Units under audit: 10 modules + the presentation layer.
const UNITS = [
  { key: 'auth', path: 'src/modules/auth' },
  { key: 'tenants', path: 'src/modules/tenants' },
  { key: 'plans', path: 'src/modules/plans' },
  { key: 'members', path: 'src/modules/members' },
  { key: 'invoicing', path: 'src/modules/invoicing' },
  { key: 'payments', path: 'src/modules/payments' },
  { key: 'events', path: 'src/modules/events' },
  { key: 'broadcasts', path: 'src/modules/broadcasts' },
  { key: 'renewals', path: 'src/modules/renewals' },
  { key: 'insights', path: 'src/modules/insights' },
  { key: 'presentation', path: 'src/app + src/components' },
]

// Per-module readiness dimensions — each driven by a domain SPECIALIST agent.
// (Global ops/data dims handled by operator gates, not here.)
const DIMENSIONS = [
  { key: 'correctness', agentType: 'reliability-guardian', focus: 'logic bugs, Result<T,E> misuse, transaction boundaries, race conditions, error handling, idempotency' },
  { key: 'security', agentType: 'security-threat-modeler', focus: 'tenant isolation (Principle I; tx-from-runInTenant not global db), authz/IDOR, PII leaks, audit-trail completeness, secrets in logs' },
  { key: 'ui', agentType: 'ui-design-specialist', focus: 'design-token adherence (no hardcoded colors / arbitrary values), light/dark parity, brand consistency, empty/loading/error visuals, responsive' },
  { key: 'ux', agentType: 'enterprise-ux-designer', focus: 'flow completeness, feedback (toast/skeleton/confirm), error recovery, a11y WCAG 2.1 AA, i18n EN/TH/SV parity, keyboard/focus' },
  { key: 'perf', agentType: 'performance-slo-guardian', focus: 'N+1 queries, missing indexes, SLO budgets (docs/observability.md), bundle budgets' },
  { key: 'scope', agentType: 'business-pm', focus: 'MISSING specced FRs / table-stakes flows; EXCESS dead code / demo leftovers / unused features (vs specs + membership-benefits-analysis + market baseline)' },
]

// Deep-pass specialists for the NON-NEGOTIABLE constitution surfaces — domain
// experts that go deeper than the generic per-module security/correctness lens.
const COMPLIANCE = [
  { key: 'pci-payments', agentType: 'pci-saqa-guardian', target: 'src/modules/payments + src/app payment/checkout surfaces', focus: 'PCI DSS SAQ-A scope: card data never touches our server, Stripe Elements/PaymentIntents correct, no PAN/CVV in logs/DB/memory' },
  { key: 'thai-tax-invoicing', agentType: 'thai-tax-compliance-auditor', target: 'src/modules/invoicing', focus: 'Thai Revenue Code §86/§87 sequential no-gaps numbering, VAT 7%, tax IDs both parties, BE display-only (never stored), bilingual TH/EN documents' },
  { key: 'pdpa-pii', agentType: 'pdpa-gdpr-compliance-officer', target: 'src/modules/members + insights + broadcasts + events (PII surfaces)', focus: 'PDPA/GDPR: lawful basis, consent, data-subject rights (access/erasure/portability), retention enforcement, cross-border, no PII in logs' },
  { key: 'clean-arch', agentType: 'chamber-os-architect', target: 'all src/modules/* boundaries', focus: 'Principle III Clean Architecture: domain has no framework imports, application no ORM/HTTP, infra types do not leak, cross-module imports go through public barrels' },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'priority', 'dimension', 'evidence', 'recommendation'],
        properties: {
          title: { type: 'string' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          dimension: { type: 'string' },
          type: { type: 'string', enum: ['bug', 'missing', 'excess', 'defect'] },
          evidence: { type: 'string', description: 'file:line + what is wrong' },
          impact: { type: 'string' },
          recommendation: { type: 'string' },
          scopeDecision: { type: 'string', enum: ['auto-fix', 'post-launch-backlog', 'keep', 'escalate', 'n/a'] },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['confirmed', 'reason'],
  properties: {
    confirmed: { type: 'boolean', description: 'true only if the finding is real and correctly prioritized' },
    adjustedPriority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3', 'unchanged'] },
    reason: { type: 'string' },
  },
}

log(`Go-live audit: ${UNITS.length} units × ${DIMENSIONS.length} dimensions. Posture: Launch-minimal.`)

phase('Review')

// Pipeline: each unit is reviewed on all dimensions (parallel within the unit),
// then every P0/P1 finding from that unit is adversarially verified — no global
// barrier, so verified findings stream out as each unit completes.
const perUnit = await pipeline(
  UNITS,
  // Stage 1 — review this unit across all dimensions concurrently.
  async (unit) => {
    const dimResults = await parallel(
      DIMENSIONS.map((d) => () =>
        agent(
          `You are auditing the Chamber-OS unit "${unit.key}" (${unit.path}) for GO-LIVE readiness, ` +
          `dimension = ${d.key}. Focus: ${d.focus}. ` +
          `Read the relevant code. Report concrete, evidence-backed findings only (file:line). ` +
          `Prioritize P0 (blocks launch) / P1 (must-fix) strictly; do not inflate. ` +
          `For scope findings, classify table-stakes vs competitive vs excess and set scopeDecision per the Launch-minimal model ` +
          `(missing table-stakes=auto-fix; missing competitive=post-launch-backlog; excess=keep unless provably dead; high-stakes+ambiguous=escalate). ` +
          `Do NOT re-report the known Stage 0 test-quality/env failures in docs/Bug/stage0-baseline.md. ` +
          `If nothing material, return an empty findings array.`,
          { agentType: d.agentType, label: `review:${unit.key}:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA },
        ),
      ),
    )
    const findings = dimResults
      .filter(Boolean)
      .flatMap((r) => r.findings || [])
      .map((f) => ({ ...f, module: unit.key }))
    return { unit: unit.key, findings }
  },
  // Stage 2 — adversarially verify only the P0/P1 findings of this unit.
  async (reviewed) => {
    const critical = reviewed.findings.filter((f) => f.priority === 'P0' || f.priority === 'P1')
    const verified = await parallel(
      critical.map((f) => () =>
        agent(
          `Adversarially verify this go-live finding. Try to REFUTE it. Confirm only if it is real AND ` +
          `correctly prioritized for a Launch-minimal posture. Finding: ${JSON.stringify(f)}`,
          { label: `verify:${reviewed.unit}:${f.priority}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ).then((v) => ({ ...f, verdict: v })),
      ),
    )
    const confirmedCritical = verified
      .filter(Boolean)
      .filter((f) => f.verdict && f.verdict.confirmed)
      .map((f) => (f.verdict.adjustedPriority && f.verdict.adjustedPriority !== 'unchanged'
        ? { ...f, priority: f.verdict.adjustedPriority }
        : f))
    const nonCritical = reviewed.findings.filter((f) => f.priority === 'P2' || f.priority === 'P3')
    return { unit: reviewed.unit, findings: [...confirmedCritical, ...nonCritical] }
  },
)

// Compliance deep-pass — domain specialists on the NON-NEGOTIABLE surfaces.
phase('Compliance')
const complianceReviewed = await parallel(
  COMPLIANCE.map((c) => () =>
    agent(
      `You are the ${c.agentType} specialist. Deep-audit ${c.target} for GO-LIVE. Focus: ${c.focus}. ` +
      `Read the actual code. Report only concrete, evidence-backed findings (file:line). Prioritize P0/P1 strictly. ` +
      `These are NON-NEGOTIABLE constitution surfaces — a real violation here is at least P1, usually P0.`,
      { agentType: c.agentType, label: `compliance:${c.key}`, phase: 'Compliance', schema: FINDINGS_SCHEMA },
    ).then((r) => ({ findings: (r && r.findings ? r.findings : []).map((f) => ({ ...f, module: `compliance:${c.key}` })) })),
  ),
)
const rawComplianceFindings = complianceReviewed.filter(Boolean).flatMap((c) => c.findings)
const complianceCritical = rawComplianceFindings.filter((f) => f.priority === 'P0' || f.priority === 'P1')
const complianceVerified = await parallel(
  complianceCritical.map((f) => () =>
    agent(
      `Adversarially verify this NON-NEGOTIABLE compliance finding. Try to REFUTE it against the code. ` +
      `Confirm only if real. Finding: ${JSON.stringify(f)}`,
      { label: `verify:${f.module}:${f.priority}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then((v) => ({ ...f, verdict: v })),
  ),
)
const complianceFindings = [
  ...complianceVerified
    .filter(Boolean)
    .filter((f) => f.verdict && f.verdict.confirmed)
    .map((f) => (f.verdict.adjustedPriority && f.verdict.adjustedPriority !== 'unchanged' ? { ...f, priority: f.verdict.adjustedPriority } : f)),
  ...rawComplianceFindings.filter((f) => f.priority === 'P2' || f.priority === 'P3'),
]

// Stage 1b — horizontal journey audit (runs after per-module review so agents
// can reason about seams between already-reviewed modules).
phase('Journeys')
const journeyResults = await parallel(
  JOURNEYS.map((j) => () =>
    agent(
      `Audit the Chamber-OS "${j.key}" persona JOURNEY end-to-end across module seams: ${j.steps}. ` +
      `You are looking for HORIZONTAL gaps a per-module audit misses: dead-ends, broken handoffs, ` +
      `data not carried between steps, a step that is unreachable, or missing i18n/a11y along the path. ` +
      `Report concrete findings (file:line / route). Prioritize strictly. dimension="ux" or "correctness".`,
      { label: `journey:${j.key}`, phase: 'Journeys', schema: FINDINGS_SCHEMA },
    ).then((r) => ({ journey: j.key, findings: (r && r.findings ? r.findings : []).map((f) => ({ ...f, module: `journey:${j.key}` })) })),
  ),
)

// Adversarially verify journey P0/P1 findings (parity with the per-module track —
// D14 fix from docs audit: journey findings must NOT bypass verify).
phase('Verify')
const rawJourneyFindings = journeyResults.filter(Boolean).flatMap((j) => j.findings)
const journeyCritical = rawJourneyFindings.filter((f) => f.priority === 'P0' || f.priority === 'P1')
const journeyVerified = await parallel(
  journeyCritical.map((f) => () =>
    agent(
      `Adversarially verify this go-live JOURNEY finding. Try to REFUTE it. Confirm only if real and ` +
      `correctly prioritized for a Launch-minimal posture. Finding: ${JSON.stringify(f)}`,
      { label: `verify:${f.module}:${f.priority}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then((v) => ({ ...f, verdict: v })),
  ),
)
const journeyFindings = [
  ...journeyVerified
    .filter(Boolean)
    .filter((f) => f.verdict && f.verdict.confirmed)
    .map((f) => (f.verdict.adjustedPriority && f.verdict.adjustedPriority !== 'unchanged' ? { ...f, priority: f.verdict.adjustedPriority } : f)),
  ...rawJourneyFindings.filter((f) => f.priority === 'P2' || f.priority === 'P3'),
]

phase('Synthesize')

const allFindings = [
  ...perUnit.filter(Boolean).flatMap((u) => u.findings),
  ...complianceFindings,
  ...journeyFindings,
]
const counts = { P0: 0, P1: 0, P2: 0, P3: 0 }
for (const f of allFindings) counts[f.priority] = (counts[f.priority] || 0) + 1
log(`Audit complete: P0=${counts.P0} P1=${counts.P1} P2=${counts.P2} P3=${counts.P3} (total ${allFindings.length})`)

// Returned to the caller — write into docs/Bug/go-live-findings.md (template ready).
return {
  posture: 'launch-minimal',
  counts,
  findings: allFindings,
  scopeDecisionLog: allFindings.filter((f) => f.type === 'missing' || f.type === 'excess'),
  escalations: allFindings.filter((f) => f.scopeDecision === 'escalate'),
}
