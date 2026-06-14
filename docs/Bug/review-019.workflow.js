export const meta = {
  name: 'code-review-019-p1-17',
  description: 'xhigh recall review of branch 019 (P1-17 bulk send_portal_invite)',
  phases: [
    { title: 'Find', detail: '9 finder angles' },
    { title: 'Verify', detail: '1-vote 3-state' },
    { title: 'Sweep', detail: 'gap hunt' },
    { title: 'VerifySweep', detail: 'verify sweep' },
  ],
}

const DIFF = 'docs/Bug/review_019.diff'

const PROJECT = [
  'PROJECT: Chamber-OS (Next.js 16 / React 19 / TS strict / Drizzle / Neon Postgres / next-intl). MTA+STD',
  '(tenant_id-scoped, Postgres RLS, runInTenant). Clean Arch (Principle III): domain/application/infra/presentation.',
  '',
  'This diff is branch 019-bulk-portal-invite (range main...HEAD): ONE commit implementing go-live finding',
  'P1-17 = REAL bulk send_portal_invite dispatch in the F3 members module (was an audit-only stub).',
  '',
  'ARCHITECTURE:',
  '- NEW use case bulkSendPortalInvite (src/modules/members/application/use-cases/bulk-send-portal-invite.ts):',
  '  best-effort per member, reuses the single-invite invitePortal use case per member. 3 buckets:',
  '  invited / skipped {already_linked, no_email, no_invitable_contact, member_archived, member_not_found} /',
  '  failed {invalid_email, email_taken, server_error}. Loop NEVER aborts. Idempotent (already_linked -> skipped).',
  '  Per member: memberRepo.findById (repo.not_found -> skipped member_not_found; other repo err -> failed',
  '  server_error); status archived -> skipped; contactRepo.listByMember({includeRemoved:false}) -> find primary',
  '  (isPrimary) -> none -> skipped no_invitable_contact; else invitePortal(contactId). On ok: push invited +',
  '  best-effort audit.record(member_portal_invite_queued) (failure logged, NOT fatal). invitePortal error.code',
  '  mapped to a bucket (not_found -> no_invitable_contact = contact race).',
  '- invitePortal -> F1 createUser enqueues a notifications_outbox row (no inline email); the existing',
  '  /api/cron/outbox-dispatch cron is the sole sender + throttle (untouched). createUser runs an owner-role tx',
  '  that chamber_app cannot join -> hence a SEPARATE use case (not a bulkAction switch arm).',
  '- createUserPortAdapter (infra) wraps F1 createUser; wired into buildMembersDeps().createUser; BOTH the',
  '  single-invite route AND the bulk route use deps.createUser now (the inline adapter was removed from the',
  '  single-invite route).',
  '- bulk route (src/app/api/members/bulk/route.ts): a send_portal_invite branch BEFORE the bulkAction call ->',
  '  bulkSendPortalInvite, maps Output to a snake_case 200 body {invited, skipped, failed, counts} (partial',
  '  success is still 200), remembers the idempotent response. bulkActionSchema enum narrowed to',
  '  change_plan|archive; the send_portal_invite stub case removed from bulkAction.',
  '- UI bulk-action-bar: send_portal_invite toast shows queued/skipped/failed (EN/TH/SV keys added).',
  '',
  'HIGH-RISK INVARIANTS to weigh (a violation of any is a real bug):',
  '- BEST-EFFORT LOOP: one member s error/skip must never abort the others; counts must equal the 3 arrays;',
  '  every member_id lands in exactly one bucket.',
  '- INVITE-ERROR MAPPING: every invitePortal error.code is mapped; a new/unhandled code must not silently drop',
  '  a member (default -> failed server_error). Skip-vs-fail classification: already_linked/no_email = skip;',
  '  invalid_email/email_taken = fail.',
  '- TENANT ISOLATION (Principle I): findById/listByMember are RLS-scoped via deps.tenant; a cross-tenant member',
  '  id must miss (skipped member_not_found), never invite across tenants. invitePortal/createUser must carry the',
  '  right tenant slug (deps.tenant.slug) into the outbox row.',
  '- IDEMPOTENCY: re-invite of an already-linked contact -> already_linked -> skipped (no duplicate user/outbox).',
  '  Route Idempotency-Key replay returns the cached body. A partial batch re-run is safe.',
  '- AUDIT BEST-EFFORT: audit.record failure on success must NOT fail the invite (already queued, unrecallable);',
  '  but a genuinely-needed audit must still be attempted. member_portal_invite_queued is a non-tx record().',
  '- ROUTE WIRING: the send_portal_invite branch must run AFTER RBAC + idempotency-key + cap + rate-limit gates',
  '  (same as bulkAction); body mapping camelCase->snake_case correct; ctx.sourceIp / ctx.requestId threaded.',
  '- STUB REMOVAL: narrowing bulkActionSchema to change_plan|archive must not break the switch exhaustiveness or',
  '  any caller; the removed member_portal_invite_queued-in-bulkAction must not be relied on elsewhere.',
  '- ADAPTER: createUserPortAdapter actorUserId `as never` cast + error.code passthrough must match F1 createUser.',
  '- PRIMARY CONTACT: listByMember(includeRemoved:false).find(isPrimary) assumes <=1 primary live contact (DB',
  '  invariant). A member with only NON-primary live contacts -> no_invitable_contact (is that intended? yes).',
  '- TEST QUALITY: the removed C-6 stub tests; the new unit/contract/integration (vacuous asserts, idempotent',
  '  proof reuses a pre-linked contact, cross-tenant control, outbox cleanup, order-dependence).',
  '',
  'Read the diff at ' + DIFF + '. For any suspect hunk ALSO Read the enclosing function in the repo and Grep',
  'callers/callees. Bugs in unchanged lines of a touched function are IN SCOPE. Report only defects with a',
  'NAMEABLE failure scenario. Pass through anything you half-believe; the verify step filters.',
].join('\n')

const FINDER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['candidates'],
  properties: {
    candidates: {
      type: 'array', maxItems: 8, items: {
        type: 'object', additionalProperties: false,
        required: ['file', 'line', 'summary', 'failure_scenario', 'category', 'severity'],
        properties: {
          file: { type: 'string' }, line: { type: 'number' },
          summary: { type: 'string' }, failure_scenario: { type: 'string' },
          category: { type: 'string', enum: ['correctness', 'cleanup', 'altitude'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['vote', 'evidence'],
  properties: {
    vote: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] },
    evidence: { type: 'string' },
  },
}

const ANGLES = [
  { key: 'A-line-by-line', brief: 'Read every hunk line by line + the enclosing function. Inverted conditions, off-by-one, null deref, missing await, falsy-zero, wrong-variable copy-paste, swallowed errors. Focus on the bulkSendPortalInvite per-member loop, the bucket pushes, and the route body mapping.' },
  { key: 'B-removed-behavior', brief: 'The diff REMOVED the send_portal_invite case from bulkAction + narrowed the enum + removed inline createUserPort from the single-invite route + removed the C-6 stub tests. For each removal: was the behavior re-established (the new use case) or genuinely dropped? Did narrowing the enum break the switch, the route, or any test that still sends send_portal_invite to bulkAction? Did removing the inline adapter change the single-invite route behavior (locale/actorUserId/tenant)?' },
  { key: 'C-cross-file-tracer', brief: 'buildMembersDeps gained a `createUser` field; MembersDeps type widened. Grep ALL buildMembersDeps consumers + ALL inline MembersDeps mocks in tests: does anything break or need the new field? The bulk route imports bulkSendPortalInvite from the barrel — verify the barrel export + the route deps subset {tenant, memberRepo, contactRepo, createUser, audit} all exist. Does invitePortal s signature match what bulkSendPortalInvite passes?' },
  { key: 'D-language-pitfall', brief: 'JS/TS pitfalls: the for-of over member_ids + array push; the (rawBody as Record).action type narrowing; exactOptionalPropertyTypes on meta.locale (conditional spread); Map/find returning undefined; the `as never` actorUserId cast; counts derived from array length; partial-success returning 200 not 207; the audit non-tx record vs the invitePortal txns ordering.' },
  { key: 'E-wrapper-proxy', brief: 'createUserPortAdapter wraps F1 createUser: does it forward every field invitePortal/bulk needs (email, role, displayName, actorUserId, sourceIp, requestId, locale, tenantId)? Error-code passthrough correct? The deps.createUser shared by single + bulk routes — same instance, no per-request state. Does bulkSendPortalInvite pass deps.tenant into invitePortal so the outbox row gets the right tenant slug?' },
  { key: 'Reuse', brief: 'Does the diff re-implement something existing? The 3-bucket pattern vs bulkAction s error shape; the cap/superRefine duplicated from bulkActionSchema (BULK_CAP imported — ok?); the route body-mapping. Name the existing helper if one should be reused.' },
  { key: 'Simplification', brief: 'Unnecessary complexity: the route branch length, redundant state, the bucket arrays + counts (derivable), deep nesting in the per-member loop, dead code from the stub removal. Name the simpler form.' },
  { key: 'Efficiency', brief: 'Wasted work: per-member serial findById + listByMember + invitePortal (N round-trips at cap 100); the per-success audit.record opening its own connection (N more). Acceptable for an admin bulk op? Any redundant read? Name the cheaper alternative if material.' },
  { key: 'Altitude', brief: 'Right depth or bandaid? Was extracting a separate use case the right call (vs a bulkAction arm)? Is reaching createUser via buildMembersDeps the right seam? Is the audit-per-success (best-effort) the right granularity vs a bulk-summary event? State the concrete maintenance cost.' },
]

phase('Find')
const finderResults = await parallel(ANGLES.map((a) => () =>
  agent(PROJECT + '\n\nYOUR ANGLE - ' + a.key + ':\n' + a.brief + '\n\nReturn UP TO 8 candidates with a real failure scenario.',
    { label: 'find:' + a.key, phase: 'Find', schema: FINDER_SCHEMA },
  ).then((r) => (r && r.candidates ? r.candidates : []).map((c) => ({ ...c, angle: a.key })))
))
const allCandidates = finderResults.filter(Boolean).flat()
const byKey = new Map()
for (const c of allCandidates) {
  const key = c.file + '::' + c.line + '::' + (c.summary || '').toLowerCase().slice(0, 30)
  const prev = byKey.get(key)
  if (!prev || (c.failure_scenario || '').length > (prev.failure_scenario || '').length) byKey.set(key, c)
}
const deduped = [...byKey.values()]
log('Find: ' + allCandidates.length + ' raw -> ' + deduped.length + ' deduped')

phase('Verify')
const verified = await parallel(deduped.map((c) => () =>
  agent(PROJECT + '\n\nVERIFY ONE CANDIDATE (1-vote, 3-state). Read ' + DIFF + ' + the actual repo file + enclosing function before voting.\n\nCANDIDATE:\n  file: ' + c.file + '\n  line: ' + c.line + '\n  category: ' + c.category + ' | severity: ' + c.severity + ' | angle: ' + c.angle + '\n  summary: ' + c.summary + '\n  failure_scenario: ' + c.failure_scenario + '\n\nVote CONFIRMED (quote the triggering line), PLAUSIBLE (real mechanism, uncertain trigger), or REFUTED (quote the disproving line/guard). Recall mode: refute ONLY when constructibly disproven.',
    { label: 'verify:' + c.file.split('/').pop() + ':' + c.line, phase: 'Verify', schema: VERDICT_SCHEMA },
  ).then((v) => (v && v.vote !== 'REFUTED') ? { ...c, vote: v.vote, evidence: v.evidence } : null)
))
const survivors = verified.filter(Boolean)
log('Verify: ' + survivors.length + '/' + deduped.length + ' survived')

phase('Sweep')
const sweepList = survivors.map((s) => '- [' + s.vote + '] ' + s.file + ':' + s.line + ' - ' + s.summary).join('\n')
const sweepRaw = await agent(
  PROJECT + '\n\nFRESH reviewer with the already-verified findings below. Re-read ' + DIFF + ' + enclosing functions; surface ONLY defects NOT already listed. Hunt what the first pass misses: the new tests (vacuous asserts, idempotent order-dependence, outbox/user cleanup leaks, the pre-linked m3 FK), the removed C-6 block (unused imports/vars left behind), the route idempotency-replay body shape, the toast i18n key plural args, exhaustiveness of the narrowed switch. Up to 8 NEW candidates; empty if none.\n\nALREADY FOUND:\n' + (sweepList || '(none)'),
  { label: 'sweep', phase: 'Sweep', schema: FINDER_SCHEMA },
)
const sweepCandidates = (sweepRaw && sweepRaw.candidates ? sweepRaw.candidates : []).map((c) => ({ ...c, angle: 'Sweep' }))
log('Sweep: ' + sweepCandidates.length + ' new')

phase('VerifySweep')
const sweepVerified = await parallel(sweepCandidates.map((c) => () =>
  agent(PROJECT + '\n\nVERIFY ONE SWEEP CANDIDATE (1-vote, 3-state). Read ' + DIFF + ' + repo file + enclosing function.\n\nCANDIDATE:\n  file: ' + c.file + '\n  line: ' + c.line + '\n  summary: ' + c.summary + '\n  failure_scenario: ' + c.failure_scenario + '\n\nVote CONFIRMED / PLAUSIBLE / REFUTED with evidence (quote lines).',
    { label: 'verify-sweep:' + c.file.split('/').pop() + ':' + c.line, phase: 'VerifySweep', schema: VERDICT_SCHEMA },
  ).then((v) => (v && v.vote !== 'REFUTED') ? { ...c, vote: v.vote, evidence: v.evidence } : null)
))

const all = [...survivors, ...sweepVerified.filter(Boolean)]
const catRank = { correctness: 0, altitude: 1, cleanup: 2 }
const sevRank = { high: 0, medium: 1, low: 2 }
const voteRank = { CONFIRMED: 0, PLAUSIBLE: 1 }
all.sort((x, y) =>
  (catRank[x.category] - catRank[y.category]) ||
  (sevRank[x.severity] - sevRank[y.severity]) ||
  (voteRank[x.vote] - voteRank[y.vote]))

return {
  counts: { raw: allCandidates.length, deduped: deduped.length, survivors: survivors.length, sweepNew: sweepVerified.filter(Boolean).length, total: all.length },
  findings: all.slice(0, 15).map((f) => ({ file: f.file, line: f.line, summary: f.summary, failure_scenario: f.failure_scenario, category: f.category, severity: f.severity, vote: f.vote, angle: f.angle, evidence: f.evidence })),
}
