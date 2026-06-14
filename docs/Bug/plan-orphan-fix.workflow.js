export const meta = {
  name: 'plan-invite-orphan-fix',
  description: 'Understand + design the safest fix for the invitePortal orphan path (createUser ok but linkUserInTx fails -> contact never linked)',
  phases: [
    { title: 'Understand', detail: '5 parallel readers map the link mechanism, orphan impact, createUser compensation, recovery paths, security' },
    { title: 'Design', detail: '3 approaches (compensating-delete / re-invite-recovery / redemption-hook)' },
    { title: 'Synthesize', detail: 'lead architect picks the safest correct fix' },
  ],
}

const CTX = [
  'PROJECT: Chamber-OS (Next.js 16 / TS strict / Drizzle / Neon Postgres). MTA+STD, Postgres RLS, runInTenant.',
  'Clean Arch (Principle III). Dependency direction: F3 members MAY depend on F1 auth; F1 must NOT depend on F3.',
  '',
  'BUG to fix (go-live /code-review #12-13, pre-existing): the F3 `invitePortal` use case',
  '(src/modules/members/application/use-cases/invite-portal.ts) does TWO separate transactions:',
  '  (1) F1 `createUser` (owner-role db.transaction) -> creates a pending user + invitation token +',
  '      enqueues a notifications_outbox invite email. Commits.',
  '  (2) `runInTenant(tenant, tx => contactRepo.linkUserInTx(tx, contactId, userId))` (chamber_app tenant tx)',
  '      -> sets contacts.linked_user_id = user.id.',
  'If (2) FAILS after (1) committed, invitePortal LOGS an orphan and returns ok ANYWAY (invite-portal.ts ~131-150).',
  'The user exists + the invite email is in flight, but the contact stays UNLINKED. The code comment claims',
  '"the redemption path sets the contact link separately" -- but redeem-invite.ts (F1) NEVER touches',
  'contacts.linked_user_id (it only consumes the token, sets password, activates, creates a session). So the',
  'comment is FALSE: the orphan does NOT self-heal. A later re-invite (single or bulk) calls createUser again',
  '-> F1 email-taken -> the contact never gets linked, permanently.',
  '',
  'WHY the two txns cannot be merged: chamber_app has NO INSERT grant on `invitations`, so createUser MUST run',
  'in an owner-role tx; the F3 contact link runs as chamber_app. They cannot share one tx (different roles).',
  'So a single atomic tx is NOT an option without changing the role model.',
  '',
  'This is shared by BOTH the single-invite route AND the new bulk-invite (P1-17, which reuses invitePortal).',
  'It is rare (requires a fault BETWEEN the two committed txns). The fix must be SAFE (no cross-account linking:',
  'linking a contact to the WRONG user by email is a security hole) and PROPORTIONATE (rare edge).',
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
  { key: 'orphan-impact', q: 'How load-bearing is contacts.linked_user_id? Trace what READS it: how does the member PORTAL resolve "which member/contact is this signed-in user"? Grep linked_user_id / linkedUserId across src. If an active user has an UNLINKED contact (orphan), what breaks for that member (portal access, self-service, member resolution)? Is the orphan a broken-portal bug or merely cosmetic? Cite the resolution path.' },
  { key: 'createuser-compensation', q: 'Read src/modules/auth/application/create-user.ts fully. How does its EXISTING compensating delete work (the invitation-create-failed path that deletes the just-created user)? Is there a reusable deleteUser / hard-delete of a pending user (F1)? What exactly does createUser commit (user + invitation + outbox) and can a pending user be safely deleted after commit if the downstream link fails? Is there a public F1 op to delete/deactivate a pending user?' },
  { key: 'link-existing-recovery', q: 'Does any existing flow link an EXISTING user to a contact (vs create-new)? Read invite-user-for-member.ts + contactRepo.findByEmail + contactRepo.linkUser/linkUserInTx + resend-bounced-invite.ts. Is there a "find existing unlinked user by email and link" path? What does invite-user-for-member do when the email already has a user? Could re-invite of an orphaned member recover by linking the existing user instead of createUser-ing again?' },
  { key: 'security-linking', q: 'Security: when invitePortal/bulk re-invites a member whose contact email already maps to an existing user (email-taken), is it SAFE to link that existing user to the contact? When is the existing user GUARANTEED to be the one the prior orphaned invite created vs a DIFFERENT person who happens to share the email? What guards exist on contact<->user linking today (cross-member, cross-tenant, already-linked)? What would make a link-existing recovery safe (e.g. user.status===pending + created-by-invite + same tenant)?' },
  { key: 'redemption-and-invitation-shape', q: 'Read redeem-invite.ts + the invitations table schema + the user row. Does the invitation or the pending user carry a memberId / contactId that could let redemption (or a post-redemption hook) link the F3 contact? Could F3 expose a port that F1 redemption calls on success (respecting F1-must-not-depend-on-F3 via a structural port / event)? What is the cleanest seam to link the contact at redemption time if invite-time linking failed?' },
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
  required: ['name', 'summary', 'filesToCreate', 'filesToModify', 'pros', 'cons', 'safety', 'idempotency', 'cleanArch', 'effort', 'testPlan'],
  properties: {
    name: { type: 'string' },
    summary: { type: 'string' },
    filesToCreate: { type: 'array', items: { type: 'string' } },
    filesToModify: { type: 'array', items: { type: 'string' } },
    pros: { type: 'array', items: { type: 'string' } },
    cons: { type: 'array', items: { type: 'string' } },
    safety: { type: 'string', description: 'how it avoids cross-account / cross-tenant linking' },
    idempotency: { type: 'string', description: 'behaviour on re-invite of an orphaned member' },
    cleanArch: { type: 'string', description: 'F1-must-not-depend-on-F3 respected?' },
    effort: { type: 'string' },
    testPlan: { type: 'array', items: { type: 'string' } },
  },
}

phase('Design')
const approaches = [
  { key: 'A-compensating-delete', brief: 'Approach A -- SAGA compensation: if linkUserInTx fails after createUser committed, invitePortal calls an F1 op to HARD-DELETE the just-created pending user (+ its invitation/outbox), then returns a typed error so the caller surfaces it. Net effect: no orphan ever persists; a re-invite starts clean. Detail the F1 delete op (reuse createUser s internal compensation?), the safety (only delete the user WE just created, status=pending), and the bulk-bucket mapping (failed or a retryable code).' },
  { key: 'B-reinvite-recovery', brief: 'Approach B -- self-heal on re-invite: when createUser returns email-taken AND the contact is unlinked, look up the existing user by that email and link the contact to it (instead of failing) -- IFF safe (same tenant + user.status pending/active + the email uniquely identifies the invite-created user). Detail the safety guard that prevents linking to an unrelated account, and what happens if the email belongs to a genuinely different person.' },
  { key: 'C-redemption-hook', brief: 'Approach C -- link at redemption: have the invitation carry the (tenant, contactId) and a post-redemption hook (a structural F3 port invoked by F1 redeem-invite, F1->F3 dependency avoided via an injected callback) link the contact when the user activates. Detail the port seam, where the contactId is stored, and whether this also needs the invite-time link kept as the happy path.' },
]
const designs = await parallel(approaches.map((a) => () =>
  agent(CTX + '\n\nUNDERSTAND-PHASE FACTS (ground your design; verify against code):\n' + factsDigest + '\n\nDESIGN THIS APPROACH -- ' + a.key + ':\n' + a.brief + '\n\nConcrete file-level design. Respect Clean Arch + the role split (createUser owner-role tx; chamber_app cannot insert invitations) + F1-must-not-depend-on-F3. SAFETY is paramount: never link a contact to the wrong user. TDD test plan incl the link-failure simulation + the security guard + re-invite. Be honest about cons + residual orphan windows.',
    { label: 'design:' + a.key, phase: 'Design', schema: APPROACH_SCHEMA },
  ).then((d) => d ? { approach: a.key, ...d } : null)
))
const designList = designs.filter(Boolean)
log('Design: ' + designList.length + '/3 approaches')

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['recommendedApproach', 'rationale', 'specKitNeeded', 'phasedTasks', 'filesToModify', 'filesToCreate', 'acceptanceCriteria', 'risks', 'effortEstimate', 'openDecisionsForUser'],
  properties: {
    recommendedApproach: { type: 'string' },
    rationale: { type: 'string' },
    specKitNeeded: { type: 'boolean' },
    phasedTasks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['phase', 'tasks'], properties: { phase: { type: 'string' }, tasks: { type: 'array', items: { type: 'string' } } } } },
    filesToModify: { type: 'array', items: { type: 'string' } },
    filesToCreate: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    effortEstimate: { type: 'string' },
    openDecisionsForUser: { type: 'array', items: { type: 'string' } },
  },
}

phase('Synthesize')
const plan = await agent(
  CTX + '\n\nUNDERSTAND-PHASE FACTS:\n' + factsDigest + '\n\nTHREE CANDIDATE DESIGNS:\n' + JSON.stringify(designList, null, 2) + '\n\nLead architect: pick the SAFEST CORRECT fix that is PROPORTIONATE to a rare edge, graft the best of the runners-up. The fix lands in the SHARED invitePortal (benefits single + bulk). Produce a concrete TDD plan: phased tasks, files, acceptance criteria (no orphan persists OR self-heals; NEVER link to a wrong/cross-tenant user; idempotent re-invite; both single + bulk covered), risks, effort, open decisions. State if a full Spec Kit cycle is needed or a focused fix. If the orphan impact is actually COSMETIC (contact.linked_user_id is not load-bearing for portal access), say so and right-size the fix.',
  { label: 'synthesize-plan', phase: 'Synthesize', schema: PLAN_SCHEMA, agentType: 'chamber-os-architect' },
)

return { plan, designs: designList.map((d) => ({ approach: d.approach, summary: d.summary, safety: d.safety, effort: d.effort })), understandOpenQuestions: facts.flatMap((f) => f.openQuestions || []) }
