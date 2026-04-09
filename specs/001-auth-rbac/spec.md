# Feature Specification: Authentication & Role-Based Access Control

**Feature Branch**: `001-auth-rbac`
**Created**: 2026-04-09
**Status**: Draft
**Input**: User description: "F1 — Auth & RBAC for the SweCham / TSCC membership system.
Three user roles (admin, manager, member) across two portals (staff, member). Email
+ password authentication, password reset, account lifecycle management by admins,
and an append-only audit trail of authentication events. Tri-lingual (SV / EN / TH),
mobile-first, WCAG 2.1 AA conformant. Governed by Constitution v1.2.0 Principles I
(Data Privacy & Security) and VI (Inclusive UX)."

## Clarifications

### Session 2026-04-09

- Q: Does the `manager` role have any write permissions, or is it read-only across
  every module? → A: **Read-only across every module** (Option A). Managers can read
  any surface that admins can read but cannot create, edit, delete, or change state
  on any resource. The only exceptions are self-service actions that apply to the
  manager's own account (change own password, sign out, view own profile).
- Q: Can one person hold multiple roles simultaneously (e.g., a SweCham board member
  who is also the CEO of a member company)? → A: **No — one account = one role,
  email unique system-wide** (Option A). A person who legitimately has two capacities
  creates two separate accounts using two different email addresses (typically a
  SweCham work email for the staff role and a company email for the member role).
  Each account has its own audit trail, sessions, and password.
- Q: How complete should the authentication audit event list be? → A:
  **Comprehensive** (Option B) — ten original events plus five additional events:
  (11) password changed while signed in, (12) account lockout triggered by failed
  attempts, (13) account lockout cleared, (14) manager-denied write attempt on a
  protected resource, (15) concurrent session revocation following a password
  change (one combined event, not one per revoked session), and (16) failed
  invitation redemption (expired or already-used link). Idle and absolute session
  timeout expirations are NOT audited (they are routine and would flood the log).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin signs in to run the chamber (Priority: P1)

An operations staff member at SweCham needs to sign in to the staff portal so they
can manage members, invoices, events, and reports. Today they use a shared Excel
workbook with no access control — anyone with the file can edit anything. The new
system must require a verified identity before any staff-level action.

**Why this priority**: Without admin sign-in, no other feature in the system can be
securely used. This is the atomic MVP slice — a single admin account that can sign
in is the minimum viable deliverable for this feature.

**Independent Test**: Can be fully tested by creating one admin account via the
documented bootstrap procedure, signing in through the staff portal, landing on a
staff home page, and signing out again. The session must clear when the user signs
out.

**Acceptance Scenarios**:

1. **Given** an admin account exists and the user knows the password, **When** they
   visit the staff portal and submit email + password, **Then** they are signed in,
   land on the staff home page, and see their own name and role.
2. **Given** an admin account exists but the user enters a wrong password, **When**
   they submit the sign-in form, **Then** they see a generic "invalid email or
   password" message (no hint about which field was wrong) and no session is created.
3. **Given** a signed-in admin, **When** they choose to sign out, **Then** their
   session ends, returning to the sign-in page means they must re-authenticate, and
   no cached protected data leaks to the browser back/forward buttons.
4. **Given** an admin is signed in and idles for an extended time, **When** they
   return and attempt any action, **Then** the system requires re-authentication.
5. **Given** an unauthenticated visitor, **When** they attempt to open any staff
   portal URL other than the sign-in and password-reset pages, **Then** they are
   redirected to the sign-in page and returned to the original page after a
   successful sign-in.

---

### User Story 2 - Manager views financial reports without mutating data (Priority: P1)

A manager, treasurer, or board member needs to review financial figures (revenue,
unpaid invoices, renewal status) without being able to accidentally change any
underlying data. This is the principle of least privilege in practice: people who
need numbers should never have the power to alter them.

**Why this priority**: The chamber's governance requires financial transparency with
separation of duties. A manager who can edit invoices defeats the purpose of having
a separate role, and exposes the organisation to both mistakes and fraud.

**Independent Test**: Create one manager account, sign in, confirm that read-only
areas (dashboards, reports) are accessible and that every write/mutate action is
denied with an explanatory message rather than returning a broken page.

**Acceptance Scenarios**:

1. **Given** a manager account exists, **When** the manager signs in to the staff
   portal, **Then** they land on the staff home page with only the read-only
   sections visible.
2. **Given** a signed-in manager, **When** they attempt any mutating action (create,
   edit, delete, approve), **Then** the system denies it with a clear, localised
   message explaining that their role does not permit that action, and the attempt
   is recorded in the audit trail.
3. **Given** a signed-in manager, **When** they access financial report and
   dashboard pages, **Then** the data loads without restriction.
4. **Given** a manager's role is changed to admin (or vice versa) by an admin,
   **When** the affected user next performs an action, **Then** the system forces
   re-authentication so the new permissions take effect cleanly.

---

### User Story 3 - User recovers a forgotten password (Priority: P1)

Any user who forgets their password must be able to regain access without needing a
developer or database administrator. The recovery path is a delivered email link
that lets them set a new password.

**Why this priority**: Without self-service recovery, every forgotten password
becomes an operational ticket. This is unacceptable for a system used weekly by
non-technical staff and by members who may sign in only a few times a year.

**Independent Test**: Use the "forgot password" link with a valid email, confirm a
reset email arrives, open the link, set a new password, and confirm that sign-in
with the new password succeeds and the old password no longer works.

**Acceptance Scenarios**:

1. **Given** a user with a valid account, **When** they request a password reset
   using their email, **Then** a time-limited, single-use reset link is sent to
   their registered email and the page shows a neutral confirmation ("if the email
   is registered, a link has been sent") that does NOT reveal whether the address
   exists in the system.
2. **Given** a valid reset link, **When** the user opens it and chooses a new
   password that meets the policy, **Then** the new password is accepted, the old
   one is invalidated, any active sessions for that user are ended, and they can
   sign in with the new password.
3. **Given** a reset link that has already been used or has expired, **When** the
   user opens it, **Then** they see a clear message that the link is no longer
   valid and are offered the option to request a new one.
4. **Given** a user enters a new password that does not meet the policy, **When**
   they submit the form, **Then** they see which rule failed in plain, localised
   language (SV / EN / TH) and the password is not saved.
5. **Given** a password reset has just completed, **When** the system records the
   event, **Then** the audit trail contains the reset request and the successful
   change with timestamps.

---

### User Story 4 - Admin manages staff account lifecycle (Priority: P2)

An admin needs to create new staff accounts (admin or manager), disable accounts
when someone leaves, and reassign roles. New accounts are created by invitation —
the invitee sets their own initial password via an emailed link so the admin never
handles the password directly.

**Why this priority**: This is the day-2 operational capability. P1 assumes at least
one admin exists; P2 is how you grow beyond the first admin and respond to staff
turnover without database access.

**Independent Test**: Starting from one admin, create a new manager account, have
the invitee receive and use the invitation link to set a password, sign in as that
manager, then have the admin disable the account and confirm the disabled user can
no longer sign in.

**Acceptance Scenarios**:

1. **Given** an admin is signed in, **When** they create a new account with an email
   address and role, **Then** an invitation email is sent containing a time-limited
   link to set an initial password, and the account exists in a "pending" state
   until the invitee uses the link.
2. **Given** an invitee opens a valid, unused invitation link, **When** they set a
   password meeting the policy, **Then** their account moves from "pending" to
   "active" and they can sign in.
3. **Given** an admin disables an active account, **When** the user next tries to
   sign in or use an existing session, **Then** both the sign-in attempt and the
   session are rejected with a message that the account is no longer active, and
   the event is recorded in the audit trail.
4. **Given** an admin changes a user's role from admin to manager (or vice versa),
   **When** the change is saved, **Then** the change takes effect on the next
   protected action for that user, and the change is recorded in the audit trail.
5. **Given** there is exactly one admin account in the system, **When** an admin
   attempts to disable or demote themselves, **Then** the system prevents the
   action with a message explaining that at least one admin must always exist.

---

### User Story 5 - Member signs in to the member portal (Priority: P2)

A member (the primary contact of a SweCham member company) needs to sign in to the
member portal to eventually view their company profile, invoices, and register for
events. Member portal accounts are invitation-based — admins send an invitation
linked to an existing member record rather than accepting open sign-ups.

**Why this priority**: Self-service member access unlocks the long-term value of the
system (members renew themselves, register for events themselves, update their own
contacts). It is not required for a day-1 replacement of the Excel workbook, hence
P2.

**Scope decision (Q1 resolved → Option A)**: F1 delivers the member portal sign-in,
invitation flow, and a **placeholder landing page**. The landing page shows a
welcome message in the member's chosen locale and a card reading "your membership
details, invoices, and events will appear here as those features are added" — no
real data is shown because F3/F4/F7 have not shipped. When F3 (Member & Contact
Management) ships, the placeholder is replaced with real content **without touching
the auth plumbing**, and the invitation flow gains an optional "link to existing
member record" field.

**Independent Test**: Create a member user account (linked or unlinked per Q1
resolution), deliver an invitation, have the member open the link, set a password,
sign in to the member portal, and confirm they land on a member home page and
cannot access staff portal URLs.

**Acceptance Scenarios**:

1. **Given** a member invitation has been sent by an admin, **When** the recipient
   opens the link and sets a password, **Then** they can sign in to the member
   portal and land on a member home page.
2. **Given** a signed-in member, **When** they try to access any staff portal URL,
   **Then** the system denies access with a clear message and does not leak any
   staff data.
3. **Given** a signed-in member whose linked company record is deactivated (a
   future F3 concern), **When** they next attempt an action, **Then** their session
   is invalidated and they see a message that their account is no longer active.

---

### User Story 6 - User changes their own password while signed in (Priority: P2)

A signed-in user — any role — wants to change their password voluntarily, either
because they suspect it may have been seen by someone, for routine security
hygiene, or because they want to strengthen a short password. This is distinct
from the "forgot password" recovery flow: the user is already authenticated and
knows their current password.

**Why this priority**: Standard web-app behaviour. Without it, users who want to
rotate a password must deliberately log out and use the forgot-password flow,
which is confusing and discourages good security hygiene. P2 because P1 recovery
(forgot password) already covers the "I am locked out" case; voluntary change is
a quality-of-life feature.

**Independent Test**: Sign in with a known password, open account settings, choose
"change password", enter current password + new password, save, then confirm that
sign-in with the new password works and the old password is rejected.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they open account settings and choose
   "change password", **Then** they see a form asking for their current password
   and a new password (entered twice).
2. **Given** they enter the correct current password and a new password meeting
   policy, **When** they submit, **Then** the change is saved, the audit log
   records the event, every **other** active session for this user is invalidated,
   and the current session continues uninterrupted.
3. **Given** they enter an incorrect current password, **When** they submit,
   **Then** the change is rejected with a clear error and no state is modified.
4. **Given** the new password does not meet policy (too short, found in a known
   breach corpus, or matches the current password), **When** they submit, **Then**
   they see which rule failed in localised text and the password is not saved.
5. **Given** a user attempts to change password repeatedly with wrong "current
   password" entries, **When** they hit the failure threshold, **Then** the
   endpoint is rate-limited the same way as the sign-in endpoint (see FR-013).

---

### User Story 7 - Authentication audit trail (Priority: P3)

Every authentication-related event is recorded in an append-only log so that
administrators can investigate incidents, demonstrate compliance with GDPR and PDPA
accountability obligations, and detect suspicious patterns.

**Why this priority**: Audit is valuable but not on the critical path for a single
admin to sign in and use the system. It is non-negotiable for long-term compliance
(Constitution Principle VIII) and must ship before GA, but the first admin
sign-in (P1) does not strictly depend on it. Note: although numbered Story 7, this
is still P3 — lower priority than Story 6 (P2) despite the later number.

**Independent Test**: Trigger each auditable event type in sequence and verify that
all of them appear in the audit log with the correct actor, event type, timestamp,
and context. Confirm the log is append-only — no entry can be edited or deleted
through any user-facing surface.

**Acceptance Scenarios**:

1. **Given** any of the following authentication events occurs, **When** the event
   completes, **Then** a new entry is appended to the audit log containing timestamp
   (UTC), actor identity (or "anonymous" for a failed sign-in where the account
   cannot be identified), event type, target identity, source IP, and a short
   human-readable summary. The audited event set is:

   1. sign-in success
   2. sign-in failure (wrong password, wrong portal, unknown email)
   3. sign-out
   4. password reset requested
   5. password reset completed
   6. **password changed while signed in** (FR-019)
   7. account created (by invitation, by admin)
   8. account disabled
   9. account re-enabled
   10. role changed
   11. **account lockout triggered** (failed-attempt threshold reached, FR-013)
   12. **account lockout cleared** (automatic after lockout window or manual by admin)
   13. session forcibly ended by admin or system (excluding idle/absolute timeouts)
   14. **concurrent session revocation** following a password change (one combined
       event per trigger, not one per revoked session)
   15. **manager-denied write attempt** on a protected resource
   16. **failed invitation redemption** (expired or already-used invitation link)

   Idle-timeout and absolute-timeout session expirations are explicitly NOT
   audited — they are routine and would flood the log without investigative value.
2. **Given** an admin views the audit log interface (a separate future feature),
   **When** they filter by user or event type, **Then** matching events are
   returned in chronological order.
3. **Given** any user-facing interface, **When** someone attempts to modify or
   delete an audit entry, **Then** the attempt fails — audit entries are append-only
   by design.
4. **Given** the audit log storage, **When** retention is checked, **Then** entries
   are retained for at least five years per Constitution compliance requirements.

---

### Edge Cases

- **Only admin locks themselves out**: if the last remaining active admin locks
  themselves out of their account (forgotten password and cannot reset), a
  documented bootstrap procedure MUST allow recovery without touching the database
  directly. (Specific mechanism is a Plan-phase concern.)
- **Password reset link used twice**: the second use MUST fail with a clear message
  and offer the user the option to request a new link.
- **Password reset link expired**: the same message as "link used" applies — the
  user must request a fresh link.
- **Concurrent account creation race**: if two admins try to create an account with
  the same email simultaneously, exactly one should succeed and the other MUST see
  a clear error explaining that the email is already taken.
- **Role change during active session**: the affected user's next protected action
  MUST trigger re-authentication so permissions take effect cleanly; stale sessions
  MUST NOT continue with the old role.
- **User changes their email address (if supported)**: any active sessions MUST be
  invalidated and the user MUST re-authenticate.
- **Email delivery failure during password reset or invitation**: the user MUST see
  a neutral confirmation message, and an operational alert MUST be raised for
  administrators. The original action MUST be retryable.
- **Rapid repeated sign-in attempts**: the system MUST resist brute force and
  enumeration attacks. The specific policy (lockout vs progressive delay vs CAPTCHA)
  is a Plan-phase decision; the requirement is simply that an attacker cannot try
  millions of passwords.
- **User tries to sign into the wrong portal for their role**: a member signing in
  at the staff portal, or a staff user signing in at the member portal, MUST fail
  with a helpful message telling them the correct URL.
- **Member account linked to a company record that is later deleted**: the member
  user's session MUST be invalidated and they MUST see a clear account-status
  message. (This interacts with F3 and is documented here for traceability.)
- **Screen reader and keyboard-only access on sign-in and reset pages**: ALL auth
  screens MUST be fully operable without a mouse and MUST announce errors to assistive
  technologies.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST authenticate users via email address and password.
- **FR-002**: System MUST support three roles: `admin`, `manager`, and `member`.
  Additional roles may be introduced in later features but are out of scope here.
- **FR-003**: System MUST enforce role-based authorisation on every protected
  resource. A user MUST NOT be able to access a resource for which their role lacks
  explicit permission.
- **FR-004**: System MUST expose two sign-in surfaces: a staff portal used by
  `admin` and `manager` roles, and a member portal used by `member` role. A user
  signing in at the wrong portal MUST be rejected with a helpful message.
- **FR-005**: System MUST provide a self-service "forgot password" recovery flow
  that issues a single-use email link valid for **1 hour** from issuance, without
  revealing whether the email address is registered.
- **FR-006**: System MUST enforce a password policy consistent with modern best
  practice (long passwords, rejection of known-compromised passwords). The exact
  numeric thresholds are a Plan-phase decision.
- **FR-007**: System MUST NOT store any user password in plaintext or in a
  reversibly-encrypted form. Passwords MUST be verified without being recoverable.
- **FR-008**: System MUST end a user's sessions when any of the following occur:
  the user signs out; the user changes their password; the user's role changes;
  the user's account is disabled; the session has been idle for more than
  **30 minutes**; or the session exceeds its **12-hour absolute lifetime**,
  whichever comes first.
- **FR-009**: System MUST allow an admin to create a new staff account via an
  emailed invitation that lets the invitee set their own initial password. The
  invitation link MUST be single-use and valid for **7 days** from issuance.
  Admins MUST NOT handle or see the invitee's password.
- **FR-010**: System MUST allow an admin to disable or re-enable any account and
  to change another user's role. A disabled account MUST NOT be able to sign in or
  maintain an active session.
- **FR-011**: System MUST prevent the last remaining active admin from disabling
  or demoting themselves. At least one active admin MUST always exist.
- **FR-012**: System MUST record every authentication event (the 16 event types
  enumerated in User Story 7) in an append-only audit trail. Audit entries MUST
  include timestamp (UTC), actor, event type, target, source IP, and a short
  summary, and MUST be retained for at least five years. Idle-timeout and
  absolute-timeout session expirations are explicitly out of scope for audit.
- **FR-013**: System MUST resist brute force and enumeration attacks on the
  sign-in, password-reset, and invitation endpoints. After **5 failed sign-in
  attempts within a 15-minute rolling window** for a given account, the account
  MUST be locked for **15 minutes**; the lockout auto-clears at the end of the
  lockout window. Failed-attempt counters MUST also apply per source IP to mitigate
  distributed enumeration. Password-reset and invitation endpoints MUST be
  rate-limited per IP and per email address using equivalent thresholds.
- **FR-014**: All user-facing strings on authentication screens MUST be available
  in English, Thai, and Swedish at release. Missing English strings MUST fail the
  build; missing Thai or Swedish strings MUST produce a build warning and fall back
  to English at runtime.
- **FR-015**: All authentication screens MUST be fully usable on a 320px-wide
  mobile viewport and MUST conform to WCAG 2.1 Level AA (including keyboard
  navigation, focus indicators, screen reader announcements, and minimum colour
  contrast).
- **FR-016**: System MUST NOT leak through error messages whether a given email
  address is registered (applies to sign-in and password-reset flows).
- **FR-017**: System MUST preserve the user's original destination across a
  forced sign-in redirect and return them there after a successful sign-in.
- **FR-018**: System MUST handle personal data (email addresses, names, sign-in
  timestamps, source IPs) in accordance with Thailand PDPA and EU GDPR, supporting
  data subject access and erasure requests without code changes after launch.
- **FR-019**: System MUST allow a signed-in user to change their own password by
  entering their current password and a new password meeting the policy. On
  successful change, all **other** active sessions for that user MUST be invalidated
  while the current session continues uninterrupted. The change MUST be recorded
  in the authentication audit trail (FR-012).
- **FR-020 (Enterprise UX — Loading States)**: Every authentication screen that
  waits on a data source (session lookup, user profile fetch) MUST display a
  **skeleton shimmer** placeholder rather than a blank screen or a generic
  spinner. The skeleton MUST match the final content layout so that no layout
  shift occurs when data arrives (CLS contribution MUST remain 0). Buttons
  performing async actions (sign-in submit, save password) MUST display an
  in-button spinner and MUST be disabled while the action is in flight. Users
  with `prefers-reduced-motion: reduce` MUST see a gentle pulse fallback
  instead of a moving shimmer. See [`docs/ux-standards.md`](../../docs/ux-standards.md)
  § 2 for the canonical implementation pattern.
- **FR-021 (Enterprise UX — Feedback & Confirmation)**: The system MUST use
  non-blocking **toast notifications** (top-right on desktop, top-centre on
  mobile) for success and non-critical error feedback (e.g., "password
  changed", "invitation sent"). Every **destructive** action (disable account,
  re-enable account, change role) MUST require explicit confirmation through
  a **modal dialog** that states the action, describes the consequence in
  plain localised language (EN/TH/SV), defaults focus to Cancel, and honours
  the Escape key. See [`docs/ux-standards.md`](../../docs/ux-standards.md)
  § 5 and § 6.
- **FR-022 (Enterprise UX — Session Indicator & Idle Warning)**: Authenticated
  shells (both staff portal and member portal) MUST show a persistent user
  menu with the signed-in user's display name, role badge, and a sign-out
  action. Before the 30-minute idle timeout fires (FR-008), the system MUST
  display an **idle-warning modal** one minute ahead of the timeout, showing
  a live countdown and two actions: "Stay signed in" (which refreshes the
  session heartbeat) and "Sign out now". On timeout, the session ends, the
  user is redirected to the appropriate sign-in page, and a non-blocking
  toast explains "Signed out due to inactivity". See
  [`docs/ux-standards.md`](../../docs/ux-standards.md) § 8.
- **FR-023 (Enterprise UX — Empty & Error States)**: Every authentication
  surface MUST have designed **empty states** (member portal placeholder
  landing, zero pending invitations, etc.) and **error states** (inline
  validation, toast for async errors, full-page error card for unrecoverable
  failures). Error copy MUST be specific and actionable in all three
  locales, MUST NEVER leak stack traces or raw server messages to users,
  and MUST include a correlation `x-request-id` for support. See
  [`docs/ux-standards.md`](../../docs/ux-standards.md) § 3 and § 4.
- **FR-024 (Enterprise UX — Keyboard & Focus)**: Every authentication screen
  MUST be fully operable by keyboard alone. The primary input MUST receive
  focus on mount; Enter MUST submit the form; Escape MUST close any open
  modal; focus MUST return to the triggering element on modal close; a
  visible focus-ring MUST appear on every interactive element; a "Skip to
  main content" link MUST be the first focusable element in the DOM. See
  [`docs/ux-standards.md`](../../docs/ux-standards.md) § 7.
- **FR-025 (Email reliability — resend affordance)**: Every email-dependent
  flow (password reset, invitation, future account-recovery notifications)
  MUST provide a **"resend email" affordance** that the user can invoke
  **after 60 seconds** of waiting. The resend action goes through the same
  rate limiter as the original request and emits a toast confirming that a
  new email was sent. The UI MUST show a visible countdown ("You can resend
  in 45 seconds…") that counts down in real time. If the first email
  delivery has failed at the provider (detected via the Resend webhook —
  see contracts/auth-api.md § 12), an operational alert MUST fire to the
  on-call team and the user MUST see an inline message explaining that
  there may be a delay and suggesting they check their spam folder or
  contact support.

### Key Entities *(include if feature involves data)*

- **User Account**: Represents a set of credentials that can sign in to the
  system. Key attributes: a **system-unique email address** (case-insensitive
  uniqueness), **exactly one role** (admin / manager / member — a user cannot
  hold more than one role), an account status (pending / active / disabled),
  timestamps for creation, last sign-in, and last password change. A password
  verifier (never the plaintext password) is associated but is not a business
  attribute. A natural person who legitimately needs multiple capacities
  (e.g., a board member who is also a member company CEO) creates multiple
  accounts with different email addresses — the system does not model "person"
  as a distinct concept and does not link accounts.
- **Role**: A named permission set. For this feature the set is fixed:
  - **`admin`** — Full CRUD on every module the admin has access to (all modules
    added over time). No restrictions within the portal.
  - **`manager`** — **Read-only across every module**, without exception. Managers
    can read any resource that admins can read but cannot create, edit, delete, or
    change state on any resource. Self-service actions (change own password, sign
    out, view own profile) are the only operations permitted.
  - **`member`** — Self-service on the linked member company's data only. Members
    can view and edit their own company profile, view their own invoices, and
    register themselves or their contacts for events. Cannot access any other
    member's data and cannot access staff portal surfaces.

  Role definitions are data-modelled so that additional roles can be introduced
  in later features without code changes.
- **Session**: Represents an active authenticated presence. Key attributes: the
  user it belongs to, creation time, last-activity time, absolute expiry time,
  source IP. A session ends on sign-out, password change, role change, account
  disable, or expiry.
- **Password Reset Token**: A short-lived single-use artefact linking a password
  reset email to a specific account. Key attributes: the target user, creation
  time, expiry time, used/unused status.
- **Invitation**: A short-lived single-use artefact linking a pending account to
  the email invitation sent by an admin. Key attributes: the pending user, the
  inviting admin, the intended role, creation time, expiry time, used/unused
  status.
- **Authentication Audit Event**: An append-only record of an auth-related event.
  Key attributes: timestamp (UTC), actor identity, event type, target identity,
  source IP, short summary. Entries are never updated or deleted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 95% of successful sign-ins complete in under 5 seconds on a mid-range
  mobile device over a 4G connection.
- **SC-002**: 99% of password reset emails arrive in the user's inbox within 60
  seconds of the request.
- **SC-003**: Zero authorised-access violations occur in a suite of automated tests
  that attempts every unauthorised role-route combination.
- **SC-004**: 100% of authentication events listed in User Story 7 (all 16 event
  types) are captured in the audit trail, verified by an automated
  audit-completeness test.
- **SC-005**: All authentication screens pass an automated WCAG 2.1 AA scan and a
  manual screen-reader walkthrough of the sign-in and password-reset flows.
- **SC-006**: All authentication screens are fully operable on a 320px-wide
  viewport with no horizontal scrolling and no truncation.
- **SC-007**: Every user-facing string on authentication screens has a translation
  in English, Thai, and Swedish at release, verified by a translation-coverage
  test.
- **SC-008**: An admin can create a new staff account and see the invitee sign in
  for the first time in under 5 minutes, measured end to end.
- **SC-009**: There is no state in which the system has zero active admins —
  verified by automated tests covering self-disable, self-demote, and last-admin
  deletion.
- **SC-010**: Brute force attempts against the sign-in endpoint at a rate of 100
  attempts per minute from a single source are effectively blocked (no successful
  guess in a reasonable time window).
- **SC-011**: Authentication audit entries are retained for at least five years
  and cannot be modified or deleted through any user-facing surface.
- **SC-012 (Enterprise UX — CLS)**: Cumulative Layout Shift on every
  authentication screen remains **0.00** during the transition from skeleton
  shimmer to loaded content, verified by Lighthouse CI on every PR.
- **SC-013 (Enterprise UX — Idle warning reliability)**: In an automated test
  that idles a session for 30 minutes, the idle-warning modal appears exactly
  once, exactly one minute before the hard timeout, and the "Stay signed in"
  action successfully extends the session without a page reload.
- **SC-014 (Enterprise UX — Destructive action safety)**: In an automated test
  that attempts every destructive action (disable, re-enable, change role)
  without confirming the modal, zero state changes occur in the database.
- **SC-015 (Enterprise UX — Toast coverage)**: Every success and async error
  path on auth screens surfaces exactly one toast (not zero, not multiple),
  verified by Playwright tests that assert toast presence.
- **SC-016 (Enterprise UX — Reduced motion)**: With
  `prefers-reduced-motion: reduce` set, the skeleton shimmer animation is
  replaced by a static pulse and no slide / scale transition exceeds 200 ms,
  verified by a Playwright test that toggles the media query.
- **SC-017 (Email reliability — resend affordance)**: Password reset and
  invitation flows each have an automated test that (a) requests the
  email, (b) waits 60 seconds, (c) verifies a "resend" button has appeared
  with a reset countdown, (d) clicks it, and (e) verifies a second email
  request is made. The test also verifies that a Resend webhook reporting
  a bounce triggers a visible inline warning on the waiting page.

## Assumptions

- **Bootstrap admin**: the first administrator account is created via a secure
  bootstrap procedure documented during the Plan phase (for example, a seed script
  run once against a fresh environment). This bootstrap procedure is out of scope
  for the user-facing spec.
- **Email delivery provider**: transactional email delivery (password reset and
  invitation emails) is handled by an external provider chosen in the Plan phase.
  The feature assumes reliable email delivery; operational alerting on failures is
  a Plan-phase concern.
- **Member sign-up model**: member accounts are created by admin invitation only.
  Open self-registration (a stranger signing themselves up as a member) is NOT
  supported in this feature and, if ever added, would be a separate feature.
- **Linkage to member records** (Q1 resolved → Option A): F1 ships with the member
  portal and a placeholder landing page. A `member`-role user account exists
  independently of any linked contact or company record; admins can invite member
  users before F3 exists. When F3 (Member & Contact Management) ships, the
  placeholder landing page is replaced with real content (company profile,
  invoices, events), and the invitation flow gains an optional "link to existing
  member record" field. The auth plumbing itself does not change.
- **Password hashing algorithm**: a modern, deliberately slow, memory-hard
  algorithm (decided in the Plan phase). The spec assumes passwords are verified
  without ever being recoverable.
- **Session mechanism**: the specific session-management technology is a
  Plan-phase decision; the spec only mandates the behavioural contract
  (session-end triggers, absolute expiry).
- **Initial localised content**: professional translators or reviewers will be
  involved for Thai and Swedish strings. The Plan phase decides the translation
  workflow and QA process.
- **Lockout, rate-limit, and session timeouts** (Q3 resolved → Option A, industry
  defaults): 5 failed sign-in attempts within a 15-minute rolling window → 15-minute
  lockout. Session idle timeout 30 minutes, absolute maximum 12 hours. Password
  reset token TTL 1 hour. Invitation token TTL 7 days. These numbers are now
  locked as requirements (FR-005, FR-008, FR-009, FR-013) and any future changes
  require spec amendment via PR against this file.
- **User agent**: authentication is browser-based. Native mobile apps are not in
  scope for this feature.
- **Time source**: all auth timestamps use ISO 8601 UTC; the `th-TH` locale may
  display timestamps using the Buddhist Era but storage and comparison remain
  Gregorian UTC per Constitution Principle V.

## Resolved Clarifications

All three clarification questions were resolved on **2026-04-09** before Plan
phase. Decisions are now baked into the requirements and assumptions above; this
section remains for traceability.

### Q1 — Member portal scope → **Option A (include now with placeholder)**

F1 delivers the full member portal sign-in, invitation flow, and a placeholder
landing page. The placeholder shows a welcome message and a "your data will
appear here" card until F3 (Member & Contact Management) ships. When F3 arrives,
the placeholder is replaced with real content without touching the auth
plumbing. Rationale: this gives F1 a complete end-to-end test of the 3-role
design and lets admins start sending invitations immediately, at the cost of a
small throwaway landing page.

**Affected**: User Story 5 (scope decision note added); Assumptions → "Linkage to
member records".

### Q2 — Scope of "change own password" while signed in → **Option A (include both)**

F1 ships both the "forgot password" recovery flow (User Story 3, P1) and a
"change my password" flow for already-signed-in users (User Story 6, P2).
Standard web-app behaviour; encourages good security hygiene by not forcing
users to log out in order to rotate a password. On a successful change, every
**other** active session for that user is invalidated but the current session
remains so the user is not surprised.

**Affected**: New User Story 6 (P2); new FR-019; User Story 7 renumbered from 6.

### Q3 — Session, lockout, and token thresholds → **Option A (industry defaults)**

Concrete values locked into requirements:

| Parameter                        | Value               | Requirement |
|----------------------------------|---------------------|-------------|
| Session idle timeout             | **30 minutes**      | FR-008      |
| Session absolute maximum         | **12 hours**        | FR-008      |
| Sign-in failed-attempt threshold | **5 per 15 min**    | FR-013      |
| Account lockout duration         | **15 minutes**      | FR-013      |
| Password reset token TTL         | **1 hour**          | FR-005      |
| Invitation token TTL             | **7 days**          | FR-009      |

Any future adjustment requires a spec amendment PR.

**Affected**: FR-005, FR-008, FR-009, FR-013; Assumptions → "Lockout, rate-limit,
and session timeouts".
