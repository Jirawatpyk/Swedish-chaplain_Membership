export const meta = {
  name: 'plan-p1-17-bulk-invite',
  description: 'Understand + design a grounded plan for P1-17 (bulk send_portal_invite real dispatch)',
  phases: [
    { title: 'Understand', detail: '5 parallel readers map the stub, the single-invite path, dispatch/throttle, bulk partial-failure, invitation state' },
    { title: 'Design', detail: '3 approach designers (queue-outbox / post-commit-loop / reuse-single-invite)' },
    { title: 'Synthesize', detail: 'lead architect merges into one plan' },
  ],
}

const CTX = [
  'PROJECT: Chamber-OS (Next.js 16 / React 19 / TS strict / Drizzle / Neon Postgres / next-intl).',
  'First tenant SweCham/TSCC ~131 members. MTA+STD (tenant_id-scoped, Postgres RLS, runInTenant(ctx, tx)).',
  'Clean Architecture (Principle III NON-NEGOTIABLE): domain (no framework), application (ports only, no',
  'drizzle/next/react), infrastructure (adapters), presentation. TDD discipline (Principle II).',
  '',
  'TASK BEING PLANNED -- go-live finding P1-17 (bulk send_portal_invite real dispatch):',
  'The members admin bulk action supports change_plan / archive / send_portal_invite. The first two work;',
  'send_portal_invite is an AUDIT-ONLY STUB (src/modules/members/application/use-cases/bulk-action.ts ~line',
  '306) -- it records intent but dispatches NO invitations. The per-member InvitePortalButton path works',
  'today (the launch fallback) via src/modules/members/application/use-cases/invite-portal.ts +',
  'invite-user-for-member.ts, and there is an audit event member_portal_invite_queued (audit-port.ts:55) with',
  'contact-repo comment "in the same chamber_app tx" -- suggesting a QUEUE/outbox model for the single invite.',
  '',
  'The go-live findings call P1-17 "feature-sized": "Wiring real dispatch needs restructuring the bulk use-case',
  'for post-commit email fan-out (must NOT send invites inside the bulk transaction) + per-member partial-failure',
  'reporting + Resend throttling + tests." CRITICAL to verify: does the SINGLE-invite path send the email INLINE',
  'or QUEUE it (outbox + a dispatcher cron)? If it queues, bulk likely just creates N invitation rows + queues N',
  'outbox entries in the tx and the existing dispatcher sends them (throttling handled there) -- much smaller than',
  'a synchronous post-commit fan-out. The mechanism determines the true scope.',
  '',
  'Launch-minimal posture: correctness + Clean Arch + reuse the proven single-invite path (DRY, no parallel',
  'drift) + not over-engineering for 131 members, while staying MTA+STD-safe. Bulk cap is 5,000 elsewhere; check',
  'the members bulk cap. The bulk action MUST be tenant-scoped + RLS-safe + idempotent (re-inviting an',
  'already-invited / already-active portal contact must be a safe no-op or a per-member skip, not a duplicate).',
  '',
  'You have full repo + git access. Read the ACTUAL code before asserting. Cite file:line.',
].join('\n')

const UNDERSTAND_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'keyFindings', 'filesOfInterest', 'openQuestions'],
  properties: {
    area: { type: 'string' },
    keyFindings: { type: 'array', items: { type: 'string' } },
    filesOfInterest: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'note'], properties: { path: { type: 'string' }, note: { type: 'string' } } } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

phase('Understand')
const readers = [
  { key: 'bulk-action-stub', q: 'Read src/modules/members/application/use-cases/bulk-action.ts FULLY. Explain: the tx boundary (runInTenant?), how change_plan + archive are applied (per-member loop? single tx? per-member results?), exactly what the send_portal_invite branch does today (the stub at ~306), the BulkActionInput/Output/Deps/Meta shapes, the bulk cap, and the audit emit pattern. Does BulkActionOutput already carry per-member results (success/skip/fail) or just a count? Quote the stub.' },
  { key: 'single-invite-path', q: 'Read the WORKING single-invite path: src/modules/members/application/use-cases/invite-portal.ts + invite-user-for-member.ts + the contact-repo method that creates the invite (member_portal_invite_queued). KEY QUESTION: does it SEND the email inline (Resend call) or QUEUE it (outbox row + later dispatcher)? What are the preconditions/guards (contact has email? not already a portal user? not already pending-invited? not bounced?)? What does it return? What audit events fire? This is the reference to reuse for bulk.' },
  { key: 'dispatch-and-throttle', q: 'Map the invitation EMAIL dispatch + throttling. Is there an outbox table + a cron dispatcher for invite emails (like F4 invoice outbox / F7 broadcasts dispatch)? Where is the Resend send for an invite? Are there Resend rate limits / batching? Find any post-commit fan-out precedent in the codebase (F7 dispatch-scheduled, F4 outbox, renewals dispatch) that bulk invite should mirror. If single-invite queues to an outbox, what dispatches it and how is throttling handled there?' },
  { key: 'bulk-partial-failure', q: 'How do the OTHER bulk actions + the route report partial success/failure? Read the bulk-action route handler (src/app/.../members/.../bulk-action route) + any existing per-member result aggregation. How does the admin UI surface "N invited, M skipped, K failed"? Check member_bulk_archive / member_bulk_status_change audit + the BulkActionOutput consumed by the UI. What is the idempotency expectation for re-running a bulk action?' },
  { key: 'invitation-state', q: 'Map the invitation/contact state relevant to inviting: the contact/invitation state machine (pending / accepted / expired / bounced / linked_user), which contact of a member receives the invite (primary? all?), the preconditions that make an invite a no-op or skip (already active portal user, already pending, no email, archived member), and the DB tables/columns involved. What makes re-inviting safe (idempotent) vs a duplicate?' },
]
const understanding = await parallel(readers.map((r) => () =>
  agent(CTX + '\n\nYOUR AREA -- ' + r.key + ':\n' + r.q + '\n\nReturn a structured map.',
    { label: 'understand:' + r.key, phase: 'Understand', schema: UNDERSTAND_SCHEMA, agentType: 'Explore' },
  ).then((u) => u ? { reader: r.key, ...u } : null)
))
const facts = understanding.filter(Boolean)
const factsDigest = facts.map((f) => '### ' + f.reader + '\n' + (f.keyFindings || []).map((k) => '- ' + k).join('\n') + '\nOpen Qs: ' + (f.openQuestions || []).join('; ')).join('\n\n')
log('Understand: ' + facts.length + '/5 readers returned')

const APPROACH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'summary', 'filesToCreate', 'filesToModify', 'newPortMethods', 'pros', 'cons', 'txBoundary', 'throttling', 'partialFailure', 'cleanArch', 'effort', 'testPlan'],
  properties: {
    name: { type: 'string' },
    summary: { type: 'string' },
    filesToCreate: { type: 'array', items: { type: 'string' } },
    filesToModify: { type: 'array', items: { type: 'string' } },
    newPortMethods: { type: 'array', items: { type: 'string' } },
    pros: { type: 'array', items: { type: 'string' } },
    cons: { type: 'array', items: { type: 'string' } },
    txBoundary: { type: 'string', description: 'what runs inside the bulk tx vs post-commit' },
    throttling: { type: 'string', description: 'how Resend rate limits are respected (or N/A if queued to existing dispatcher)' },
    partialFailure: { type: 'string', description: 'how per-member success/skip/fail is collected + reported' },
    cleanArch: { type: 'string' },
    effort: { type: 'string' },
    testPlan: { type: 'array', items: { type: 'string' } },
  },
}

phase('Design')
const approaches = [
  { key: 'A-queue-outbox', brief: 'Approach A -- if the single-invite path QUEUES (outbox), bulk creates N invitation rows + N outbox/queued entries INSIDE the tenant tx (atomic), emits member_bulk_portal_invite audit, and the EXISTING invite dispatcher sends them post-commit (throttling already handled there). Bulk returns queued/skipped/failed-precondition counts (per-member preconditions checked in-tx). Detail the in-tx loop, the skip reasons, and how the dispatcher picks up the rows.' },
  { key: 'B-postcommit-loop', brief: 'Approach B -- bulk validates + records intent in-tx, then a POST-COMMIT fan-out loop calls the email send per member with explicit Resend throttling (batch/delay), collecting per-member {memberId, outcome} results, and a final audit summary. Detail the throttle (concurrency/delay), the partial-failure aggregation, and why fan-out must be outside the tx.' },
  { key: 'C-reuse-single-invite', brief: 'Approach C -- DRY: iterate the members and call the EXACT proven single-invite use-case (invitePortal / invite-user-for-member) once per member, aggregating per-member results, so bulk and single share ONE dispatch code path (no drift). Detail how to invoke it per member (tx-per-member vs shared), throttling, idempotent skips, and partial-failure reporting.' },
]
const designs = await parallel(approaches.map((a) => () =>
  agent(CTX + '\n\nUNDERSTAND-PHASE FACTS (ground your design in these; verify against code):\n' + factsDigest + '\n\nDESIGN THIS APPROACH -- ' + a.key + ':\n' + a.brief + '\n\nProduce a concrete, file-level design. Respect Clean Architecture (post-commit fan-out / dispatch belongs in infra behind a port; application orchestrates). Include a TDD test plan (domain/application/integration incl partial-failure + idempotent re-invite + tenant isolation). Be honest about cons. If the single-invite path already QUEUES, say so and prefer the smallest correct design.',
    { label: 'design:' + a.key, phase: 'Design', schema: APPROACH_SCHEMA },
  ).then((d) => d ? { approach: a.key, ...d } : null)
))
const designList = designs.filter(Boolean)
log('Design: ' + designList.length + '/3 approaches')

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['recommendedApproach', 'rationale', 'specKitNeeded', 'phasedTasks', 'filesToCreate', 'filesToModify', 'acceptanceCriteria', 'risks', 'effortEstimate', 'openDecisionsForUser'],
  properties: {
    recommendedApproach: { type: 'string' },
    rationale: { type: 'string' },
    specKitNeeded: { type: 'boolean' },
    phasedTasks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['phase', 'tasks'], properties: { phase: { type: 'string' }, tasks: { type: 'array', items: { type: 'string' } } } } },
    filesToCreate: { type: 'array', items: { type: 'string' } },
    filesToModify: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    effortEstimate: { type: 'string' },
    openDecisionsForUser: { type: 'array', items: { type: 'string' } },
  },
}

phase('Synthesize')
const plan = await agent(
  CTX + '\n\nUNDERSTAND-PHASE FACTS:\n' + factsDigest + '\n\nTHREE CANDIDATE DESIGNS:\n' + JSON.stringify(designList, null, 2) + '\n\nYou are the lead architect. Pick the BEST approach for the Launch-minimal posture (correct + Clean-Arch + reuse the proven single-invite path + smallest-correct, not over-engineered for 131 members, MTA+STD-safe). Graft the best ideas from runners-up. Produce ONE concrete TDD implementation plan: phased tasks, files to create/modify, acceptance criteria tied to P1-17 (real dispatch + per-member partial-failure + idempotent skip + tenant isolation + throttling), risks, effort, and the open decisions the USER must make. State whether this needs a full Spec Kit cycle or is a focused task. If the single-invite path already queues to an outbox+dispatcher, prefer that (smallest correct) and say so explicitly.',
  { label: 'synthesize-plan', phase: 'Synthesize', schema: PLAN_SCHEMA, agentType: 'chamber-os-architect' },
)

return { plan, designs: designList.map((d) => ({ approach: d.approach, summary: d.summary, txBoundary: d.txBoundary, effort: d.effort })), understandOpenQuestions: facts.flatMap((f) => f.openQuestions || []) }
