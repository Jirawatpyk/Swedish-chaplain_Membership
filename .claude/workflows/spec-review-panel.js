// spec-review-panel — N independent lenses on a spec (+ plan) BEFORE tasks exist,
// each in a fresh context, then adversarial verify against the CODE, then one
// synthesis that ranks blockers and proposes amendments (as text — never edits).
//
// Why this exists: a defect that a spec mandates is found at review round 7,
// after implementation, tests and a migration have been built on it. The repo
// has the receipts — "A plan can mandate a defect"; a 5-agent audit that found
// 7 blockers in a spec that had passed a two-lens critique; a review round
// justified by a premise about a provider that one look at the code refuted.
//
// This is NOT a /speckit-* skill and does not replace /speckit.critique-run
// (two lenses, one context, run by Claude itself). It is the version for specs
// where being wrong is expensive — money, tax, tenant isolation, PII, auth —
// and it is invoked only on explicit opt-in.
//
//   Scope       one cheap agent reads the spec: which modules, does it touch
//               money / tax / PII / tenant / auth / UI — picks the lens panel;
//               also extracts the spec's PREMISES and its DECIDED items
//   Lenses      project agents, one per lens, fresh context each. Every lens
//               must CHECK THE SPEC'S PREMISES AGAINST THE CODE: does the
//               mechanism the spec assumes exist? what already in the codebase
//               would be pointless if the spec's premise held? Every lens is
//               handed the DECIDED list (§ Clarifications Q→A, AMENDMENT blocks,
//               panel-applied notes) and told not to re-raise those — the
//               2026-09-11 run spent 11 of 12 verify slots refuting documented
//               decisions while 36 HIGH findings sat unverified.
//   Verify      ONE skeptic per finding (code + intent in a single prompt),
//               default refuted; a second skeptic only for kind=blocker. Verify
//               order is kind-first (premise / blocker before everything else),
//               then severity, then lens agreement — a wrong premise is what
//               makes the implementation fail; a severity label is a lens's
//               opinion.
//   Synthesize  inherit model (design work): ranked blockers, "impossible if
//               true" list, concrete amendments, GO / NO-GO for the next gate
//
// Invoke (opt-in only):
//   Workflow({ name: 'spec-review-panel', args: { spec: 'specs/112-foo/spec.md',
//              plan: 'specs/112-foo/plan.md',      // optional
//              lenses: undefined,                  // optional override of the panel
//              maxVerify: 12 } })                  // findings verified; agents ≈ maxVerify + #blockers

export const meta = {
  name: 'spec-review-panel',
  description: 'Independent multi-lens review of a spec (+ plan): premises checked against code, findings adversarially verified, blockers ranked with amendments — before tasks exist',
  whenToUse: 'A spec that touches money, tax, tenant isolation, PII, auth, or a migration — after /speckit.clarify, before /speckit.plan or /speckit.tasks. Skip for a UI-only or docs-only feature; /speckit.critique-run is enough there.',
  phases: [
    { title: 'Scope', detail: 'read the spec; pick the lens panel from what it touches; extract premises + decided items' },
    { title: 'Lenses', detail: 'one project agent per lens, fresh context, premises checked against code, decided items not re-raised', model: 'opus' },
    { title: 'Verify', detail: 'one skeptic per finding (two for blockers), premise/blocker first — default refuted', model: 'opus' },
    { title: 'Synthesize', detail: 'rank, amendments, GO / NO-GO' },
  ],
}

// ---------- args ----------
const A = args && typeof args === 'object' ? args : {}
const SPEC = typeof A.spec === 'string' && A.spec.trim() ? A.spec.trim() : null
const PLAN = typeof A.plan === 'string' && A.plan.trim() ? A.plan.trim() : null
const LENS_OVERRIDE = Array.isArray(A.lenses) && A.lenses.length ? A.lenses : null
const MAX_VERIFY = Number.isInteger(A.maxVerify) ? A.maxVerify : 12

const EMPTY = (reason) => ({ spec: SPEC, plan: PLAN, scope: null, lenses: [], confirmed: [], refuted: [], dropped: [], impossible_if_true: [], amendments: [], go: 'NO-GO', reason, report_markdown: null })
if (!SPEC) { log('spec-review-panel needs args.spec — path to the spec.md'); return EMPTY('no spec path') }

// ---------- schemas ----------
const SCOPE_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    feature: { type: 'string' },
    modules: { type: 'array', items: { type: 'string' } },
    touches: {
      type: 'object',
      properties: { money: { type: 'boolean' }, tax: { type: 'boolean' }, pii: { type: 'boolean' }, tenant: { type: 'boolean' }, auth: { type: 'boolean' }, ui: { type: 'boolean' }, migration: { type: 'boolean' }, integration: { type: 'boolean' } },
      required: ['money', 'tax', 'pii', 'tenant', 'auth', 'ui', 'migration', 'integration'],
    },
    summary: { type: 'string' },
    premises: { type: 'array', items: { type: 'string' } },
    decided: { type: 'array', items: { type: 'string' } },
  },
  required: ['found', 'feature', 'modules', 'touches', 'summary', 'premises', 'decided'],
}

const KIND = ['blocker', 'premise', 'gap', 'ambiguity', 'consistency', 'constitution']
const SEV = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW']
const FINDING = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: KIND },
    severity: { type: 'string', enum: SEV },
    anchor: { type: 'string' },
    claim: { type: 'string' },
    why: { type: 'string' },
    evidence: { type: 'string', enum: ['MEASURED', 'ASSUMED'] },
    code_ref: { type: 'string' },
    suggested_amendment: { type: 'string' },
  },
  required: ['kind', 'severity', 'anchor', 'claim', 'why', 'evidence'],
}
const FINDINGS_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: FINDING } }, required: ['findings'] }

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' }, corrected_severity: { type: 'string', enum: SEV } },
  required: ['refuted', 'reason'],
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    go: { type: 'string', enum: ['GO', 'GO WITH AMENDMENTS', 'NO-GO'] },
    strongest_reason: { type: 'string' },
    impossible_if_true: { type: 'array', items: { type: 'string' } },
    amendments: { type: 'array', items: { type: 'object', properties: { anchor: { type: 'string' }, text: { type: 'string' }, closes: { type: 'array', items: { type: 'integer' } } }, required: ['anchor', 'text'] } },
    report_markdown: { type: 'string' },
  },
  required: ['go', 'strongest_reason', 'impossible_if_true', 'amendments', 'report_markdown'],
}

// ---------- helpers ----------
const sevRank = (s) => SEV.indexOf(s)
// Verify order: premise / blocker first (a wrong premise breaks the build; a
// severity label is a lens's opinion), then everything else. Ties: severity,
// then how many lenses raised it.
const KIND_RANK = { premise: 0, blocker: 0, consistency: 1, gap: 1, constitution: 1, ambiguity: 2 }
const kindRank = (k) => (k in KIND_RANK ? KIND_RANK[k] : 3)
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 48)
const fkey = (f) => `${norm(f.anchor)}|${f.kind}|${norm(f.claim)}`

// ---------- Phase 1: Scope ----------
phase('Scope')
const scope = await agent(
  `Read ${SPEC}${PLAN ? ` and ${PLAN}` : ''} in full (read-only). If the spec file does not exist return found=false.
Return: the feature name; the src/modules/* bounded contexts it touches or creates; whether it touches money (invoices, payments, refunds, credit notes, renewal billing, amounts), tax (Thai RD documents, VAT, WHT, tax IDs, sequential numbering), PII (member/contact personal data, erasure, consent, export), tenant isolation (any new tenant-scoped table or query), auth/RBAC, UI, a DB migration, an external integration (Stripe, Resend, EventCreate, webhooks); a 3-sentence summary; the spec's PREMISES — every statement of the form "X already works like Y" or "Z is guaranteed by W" that the design leans on (premises are what the lenses will test against the code); and the spec's DECIDED items — one line each, verbatim enough to recognise: every "Q: … → A: …" bullet under "## Clarifications", every AMENDMENT block, every "decided" / "maintainer chose" / "option X" note, and every line under an Out of Scope heading. Decided items are what the lenses must NOT re-raise as findings — a documented trade-off with its rationale is a decision, not a defect, even when a lens would have decided otherwise.`,
  { label: 'scope:read-spec', phase: 'Scope', schema: SCOPE_SCHEMA, effort: 'low' },
)
if (!scope || !scope.found) { log(`spec not readable at ${SPEC}`); return EMPTY('spec not found') }
const T = scope.touches

// ---------- lens panel ----------
const PANEL = [
  { key: 'architecture', agentType: 'chamber-os-architect', always: true, brief: 'Clean Architecture boundaries, MTA+STD tenant model, module public interfaces, Constitution Check against all 10 principles; every deviation needs a Complexity Tracking line with a rejected simpler alternative.' },
  { key: 'security', agentType: 'security-threat-modeler', always: true, brief: 'Threat model the feature: what does it expose, who can reach it, which trust boundary does it cross; tenant leak, IDOR, fail-open guard, secret or PII in logs, webhook trust.' },
  { key: 'testability', agentType: 'senior-tester', always: true, brief: 'Can every acceptance scenario be a test that goes RED before the change? Which user story has no acceptance test? Which requirement is stated so it cannot be falsified? Live-Neon cost in CI (~7x local).' },
  { key: 'consistency', agentType: 'spec-compliance-auditor', always: true, brief: 'FR ↔ acceptance scenario ↔ success criterion ↔ plan consistency; requirements that contradict each other, or contradict shipped behaviour in the code; a task list that cannot be derived from the spec.' },
  { key: 'privacy', agentType: 'pdpa-gdpr-compliance-officer', when: T.pii || T.integration, brief: 'PDPA + GDPR: lawful basis, data-subject rights (access / erasure / portability) for every new PII field, retention, cross-border to SG, consent text, audit trail for the erasure path.' },
  { key: 'money', agentType: 'financial-integrity-reviewer', when: T.money, brief: 'Numbers and states across invoices / payments / refunds / credit notes / renewal cycles: satang arithmetic, document state machines, idempotency, void-on-reissue, reconciliation between modules, advisory-lock scope.' },
  { key: 'tax', agentType: 'thai-tax-compliance-auditor', when: T.tax, brief: 'Thai Revenue Code: §86/4 fields, §87 gap-free numbering, VAT 7%, WHT, TIN on both parties, TH-language document, Buddhist Era display-only, credit note against the ORIGINAL tax invoice.' },
  { key: 'ux', agentType: 'enterprise-ux-designer', when: T.ui, brief: 'docs/ux-standards.md and docs/ux-patterns.md: every screen and state named, error states explainable (no 500 for a rule the UI can state), WCAG 2.1 AA, EN/TH/SV keys, focus management, empty and loading states.' },
  { key: 'migration', agentType: 'drizzle-migration-reviewer', when: T.migration, brief: 'Hand-written SQL only; RLS + FORCE on every tenant table; SECURITY DEFINER under RLS; DROP TRIGGER IF EXISTS; pre-checks that scan all tenants; parallel-branch numbering; what the migration assumes about prod data that dev cannot show.' },
  { key: 'reliability', agentType: 'reliability-guardian', when: T.integration || T.migration, brief: 'Transaction boundaries, err() inside runInTenant committing partial writes, cron/webhook idempotency and replay, audit truth (actorRole), what happens on the second delivery, the lost commit-ack, the partial batch.' },
]
const lenses = (LENS_OVERRIDE ? PANEL.filter((l) => LENS_OVERRIDE.includes(l.key)) : PANEL.filter((l) => l.always || l.when)).map((l) => ({ key: l.key, agentType: l.agentType, brief: l.brief }))
log(`${scope.feature}: modules ${scope.modules.join(', ') || '(none named)'} · touches ${Object.entries(T).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nothing flagged'} · ${lenses.length} lens(es): ${lenses.map((l) => l.key).join(', ')} · ${scope.premises.length} premise(s)`)

// ---------- Phase 2: Lenses (barrier justified: dedup needs every lens) ----------
const lensPrompt = (l) => `You are the ${l.key.toUpperCase()} lens on a spec review panel. Read ${SPEC}${PLAN ? ` and ${PLAN}` : ''} in full, read-only. Other lenses cover other angles; stay on yours.

Your brief: ${l.brief}

The spec leans on these PREMISES — for each one that touches your lens, CHECK IT AGAINST THE CODE (grep the mechanism it assumes; read the use case, repo, migration or gate it names). A premise that would make some existing, deliberately-built mechanism pointless is probably false — or the mechanism is dead; either is a finding:
${scope.premises.length ? scope.premises.map((p, i) => `${i + 1}. ${p}`).join('\n') : '(scope agent extracted none — extract your own from the text)'}

DECIDED — do NOT re-raise any of these as a finding. Each is a recorded decision (§ Clarifications Q→A, an AMENDMENT block, an Out of Scope line). You may disagree with a decision only by showing the CODE contradicts the premise it rests on — then report it as kind=premise against that premise, citing the file, not against the decision:
${scope.decided.length ? scope.decided.map((d, i) => `D${i + 1}. ${d}`).join('\n') : '(none recorded)'}

Report findings with: kind (blocker = the spec mandates a defect; premise = a stated assumption the code contradicts or cannot show; gap = a requirement missing for your lens; ambiguity = two readings that lead to different implementations; consistency = FR/AS/SC/plan disagree; constitution = a principle violated without a Complexity Tracking line), severity, the anchor (section or FR/AS/SC id), the claim in one sentence, why, evidence MEASURED (you read the code) or ASSUMED, a code_ref when measured, and a concrete suggested_amendment in spec voice. Never make a claim stronger than the code supports; an ASSUMED blocker is a premise finding, not a blocker.`

phase('Lenses')
const lensResults = await parallel(
  lenses.map((l) => () => agent(lensPrompt(l), { label: `lens:${l.key}`, phase: 'Lenses', schema: FINDINGS_SCHEMA, model: 'opus', agentType: l.agentType })),
)
const okLenses = lensResults.map((r, i) => (r ? lenses[i].key : null)).filter(Boolean)
const failedLenses = lenses.map((l) => l.key).filter((k) => !okLenses.includes(k))
if (failedLenses.length) log(`${failedLenses.length} lens(es) returned nothing (agent missing or died): ${failedLenses.join(', ')} — that angle is UNREVIEWED`)

const raw = lensResults.flatMap((r, i) => (r && r.findings ? r.findings.map((f) => ({ ...f, lens: lenses[i].key })) : []))
const byKey = new Map()
for (const f of raw) {
  const k = fkey(f)
  const prev = byKey.get(k)
  if (!prev) byKey.set(k, { ...f, lenses: [f.lens] })
  else {
    prev.lenses.push(f.lens)
    if (sevRank(f.severity) < sevRank(prev.severity)) { prev.severity = f.severity; prev.claim = f.claim; prev.why = f.why; prev.evidence = f.evidence; prev.code_ref = f.code_ref; prev.suggested_amendment = f.suggested_amendment }
  }
}
const candidates = [...byKey.values()].sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || sevRank(a.severity) - sevRank(b.severity) || b.lenses.length - a.lenses.length)
log(`${raw.length} raw finding(s) → ${candidates.length} after dedup · ${candidates.filter((c) => c.lenses.length > 1).length} raised by more than one lens · ${candidates.filter((c) => kindRank(c.kind) === 0).length} premise/blocker (verified first)`)
const toVerify = candidates.slice(0, MAX_VERIFY)
const dropped = candidates.slice(MAX_VERIFY)
if (dropped.length) log(`CAP: ${dropped.length} finding(s) beyond maxVerify=${MAX_VERIFY} were NOT verified (order: premise/blocker → severity → lens agreement) — returned under "dropped"; ${dropped.filter((c) => kindRank(c.kind) === 0).length} of them are premise/blocker`)

// ---------- Phase 3: Verify ----------
phase('Verify')
// One skeptic carries BOTH refutation lenses (code + intent) — the two-agent
// split doubled the fan-out (24 agents for 12 findings) without a second
// perspective the single prompt cannot hold. A second, independent skeptic is
// kept only for kind=blocker ("the spec mandates a defect"), where a false
// confirmation would force a design change.
const SKEPTIC_BRIEF = `Two ways to refute, check BOTH:
  CODE — is the premise / mechanism actually as the finding says? Open the file. If the spec is right and the finding misread the code, refute.
  INTENT — does the spec (its § Clarifications, an AMENDMENT block, Out of Scope), the plan, the constitution, or an existing runbook already address this deliberately? A documented trade-off is a decision, not a finding — refute, and name the line that decides it.`
const DECIDED_BLOCK = scope.decided.length ? `\nDECIDED items recorded in the spec (a finding that merely disagrees with one of these is refuted on INTENT):\n${scope.decided.map((d, i) => `D${i + 1}. ${d}`).join('\n')}\n` : ''
const votesFor = (f) => (f.kind === 'blocker' ? 2 : 1)
const verifyAgents = toVerify.reduce((n, f) => n + votesFor(f), 0)
log(`verify: ${toVerify.length} finding(s) → ${verifyAgents} skeptic agent(s) (blockers get two)`)
const verified = toVerify.length === 0 ? [] : await parallel(
  toVerify.map((f, idx) => () => {
    const votes = votesFor(f)
    return parallel(
      Array.from({ length: votes }, (_, li) => () =>
        agent(
          `Try to REFUTE this spec-review finding. Default to refuted=true if you cannot confirm it from the spec text and the code.
Spec: ${SPEC}${PLAN ? ` · Plan: ${PLAN}` : ''}
${DECIDED_BLOCK}
#${idx + 1} [${f.severity}/${f.kind}] at ${f.anchor} (raised by: ${f.lenses.join(', ')})
Claim: ${f.claim}
Why: ${f.why}
Evidence claimed: ${f.evidence}${f.code_ref ? ` · code_ref: ${f.code_ref}` : ''}

${SKEPTIC_BRIEF}${votes > 1 ? `\n\nYou are skeptic ${li + 1} of ${votes} on a BLOCKER — vote independently; you are not told the other's verdict.` : ''}

State the ONE fact that decides it. If it stands at a different severity, say so in corrected_severity.`,
          { label: `verify:${idx + 1}:${votes > 1 ? `skeptic${li + 1}` : 'skeptic'}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: 'opus' },
        ),
      ),
    ).then((vs) => {
      const cast = vs.filter(Boolean)
      const standing = cast.filter((v) => !v.refuted)
      const survives = cast.length > 0 && standing.length === cast.length // for a spec finding, ANY refutation kills it — a spec amendment must not rest on a contested claim
      const sev = standing.map((v) => v.corrected_severity).filter(Boolean).sort((a, b) => sevRank(b) - sevRank(a))[0] || f.severity
      return { ...f, id: idx + 1, severity: survives ? sev : f.severity, survives, votes: cast.map((v) => ({ refuted: v.refuted, reason: v.reason })) }
    })
  }),
)
const confirmed = verified.filter(Boolean).filter((v) => v.survives).sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
const refuted = verified.filter(Boolean).filter((v) => !v.survives)
log(`verify: ${confirmed.length} confirmed · ${refuted.length} refuted · ${dropped.length} unverified`)

// ---------- Phase 4: Synthesize (inherit model — this is design work) ----------
phase('Synthesize')
const fmt = (f) => `#${f.id} [${f.severity}/${f.kind}] ${f.anchor} — ${f.claim} (${f.evidence}${f.code_ref ? ', ' + f.code_ref : ''}; lenses: ${f.lenses.join(', ')})\n    why: ${f.why}${f.suggested_amendment ? `\n    proposed: ${f.suggested_amendment}` : ''}`
const synth = await agent(
  `You are synthesising a spec review panel for "${scope.feature}" (${SPEC}${PLAN ? ` + ${PLAN}` : ''}). ${scope.summary}

CONFIRMED findings (each survived adversarial verification against the code):
${confirmed.length ? confirmed.map(fmt).join('\n') : '(none)'}

REFUTED (do not re-raise; listed so you know what was considered):
${refuted.length ? refuted.map((f) => `#${f.id} ${f.anchor} — ${f.claim} → ${f.votes.map((v) => v.reason).join(' | ')}`).join('\n') : '(none)'}
${dropped.length ? `\nUNVERIFIED (capped): ${dropped.map((f) => `${f.anchor} — ${f.claim}`).join('; ')}` : ''}

Produce:
1. go: GO (no confirmed blocker/premise), GO WITH AMENDMENTS (confirmed findings all have an amendment that closes them), or NO-GO (a confirmed blocker or premise finding with no amendment that does not change the design). strongest_reason in one sentence.
2. impossible_if_true: for each confirmed premise/blocker, the one-line "if the spec were right, X in this codebase would be pointless / could never happen" — that is the sentence a maintainer can check in a minute.
3. amendments: concrete replacement text in spec voice, one per anchor, each naming the finding ids it closes. Amend; never rewrite the spec.
4. report_markdown: a severity-sorted table of confirmed findings (id, sev/kind, anchor, claim, evidence, lenses), then the amendments, then "Refuted" one-liners, ending with the exact line \`spec-review: GO | GO WITH AMENDMENTS | NO-GO — <reason>\`.
You do not edit files; the maintainer applies amendments through /speckit.clarify or a spec AMENDMENT block.`,
  { label: 'synth:panel', phase: 'Synthesize', schema: SYNTH_SCHEMA },
)
const go = synth ? synth.go : confirmed.some((f) => f.kind === 'blocker' || f.kind === 'premise') ? 'NO-GO' : confirmed.length ? 'GO WITH AMENDMENTS' : 'GO'
const reason = synth ? synth.strongest_reason : confirmed.length ? `${confirmed[0].severity}/${confirmed[0].kind} at ${confirmed[0].anchor}: ${confirmed[0].claim}` : 'no confirmed findings'
if (!synth) log('synthesis agent returned nothing — go/no-go derived from the confirmed set')
log(`spec-review: ${go} — ${reason}`)

return {
  spec: SPEC,
  plan: PLAN,
  scope: { feature: scope.feature, modules: scope.modules, touches: T, premises: scope.premises, decided: scope.decided },
  lenses: lenses.map((l) => ({ key: l.key, agentType: l.agentType, ran: okLenses.includes(l.key) })),
  confirmed,
  refuted,
  dropped,
  impossible_if_true: synth ? synth.impossible_if_true : [],
  amendments: synth ? synth.amendments : [],
  go,
  reason,
  report_markdown: synth ? synth.report_markdown : null,
}
