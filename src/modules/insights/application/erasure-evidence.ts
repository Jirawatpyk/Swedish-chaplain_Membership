/**
 * COMP-1 US3-D (Task 3) — `getErasureEvidenceLog` use-case.
 *
 * The Application read that backs the read-only admin DPO "erasure evidence"
 * page (`/admin/compliance/erasure-log`, Task 4). It pages over the tenant's
 * erased members (`listErasedMembers`, members barrel, keyset newest-first),
 * resolves each member's linked-login ids (`listMemberLinkedUserIds`, members
 * barrel) to bind the tenant-NULL `user_erased` evidence arm, reads the
 * member's raw Art.17 evidence rows (`evidenceReader.readForMember`, the
 * auth `erasureEvidenceReadAdapter`), and FOLDS those rows into a single
 * DPO-friendly grouped record per member.
 *
 * The fold surfaces (design § US3-D / plan Task 3):
 *   - `requestedAt` + `reason` + the US3-A Art.12 attestation
 *     (`identityVerified` / `verificationMethod` / `note`) from the
 *     `member_erasure_requested` row's payload;
 *   - `completedAt` + the cascade counts (`sessionsRevokedTotal` /
 *     `invitationsRevokedCount`) from the `member_erased` row, or `null` when
 *     that completion proof is absent (a half-run);
 *   - `reDrive` — the `member_erased.payload.re_drive` flag: `true` when the
 *     completion came via a US2d reconciler RE-DRIVE pass (whose cascade counts
 *     reflect only that pass — commonly `0/0`), so the page can explain a
 *     `0/0`-count completion. `null` on a half-run (no completion row);
 *   - `userErasedProofs` — `{ occurredAt, credentialErased }` ONLY. M-2
 *     (plan-review): the `user_erased` row's `actor_user_id` is DELIBERATELY
 *     DROPPED here. For a [structurally-impossible-but-defensive] shared login
 *     it could be another tenant's admin id, so it is minimised OUT of the
 *     output shape — the page never sees it;
 *   - `taxRedactions` — the `event_buyer_pii_redacted` rows mapped to
 *     `{ occurredAt, documentKind }` (H-1: the invoice-vs-credit_note
 *     discriminator the DPO needs to tell which document's PII was redacted);
 *   - `subprocessorOutcome` — the `subprocessor_erasure_propagated` row's
 *     `resend_outcome` + removed/failed counts;
 *   - `halfRun` — `member_erasure_requested` present AND `member_erased`
 *     absent (the erasure started but never reported complete);
 *   - `isOverdue` — `halfRun && requestedAt + THIRTY_DAYS_MS < now` (the
 *     tighter PDPA §30 30-day window for dual EU/TH subjects). A COMPLETED
 *     erasure is NEVER overdue. `now` is INJECTED so the comparison is
 *     deterministic in tests AND the use-case's `isOverdue` agrees with the
 *     page's per-card `elapsed()` render on a single clock instant.
 *
 * Application layer (Principle III): orchestrates the injected barrel
 * free-functions + the read port; no ORM / framework / React imports. The
 * deps factory (Infrastructure, `insights-deps.ts`) binds the production
 * adapters.
 */
import type { TenantContext } from '@/modules/tenants';
import {
  ERASURE_EVIDENCE_EVENTS,
  type ErasureEvidenceEventType,
  type ErasureEvidenceRow,
} from '@/modules/auth';
import type {
  ErasedMemberRow,
  ErasedMembersCursor,
  ListErasedMembersResult,
} from '@/modules/members';

/** 30-day PDPA §30 statutory window (ms). The tighter of Art.12 (1 month) / §30. */
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** The member's `user_erased` credential-erasure proof — occurredAt + marker ONLY.
 *  M-2: NO `actorUserId` is carried (data minimisation). */
export interface UserErasedProof {
  readonly occurredAt: Date;
  /** Always `true` — a marker that the login credential was erased. */
  readonly credentialErased: true;
}

/** A tax-document PII redaction (US3-B) — H-1 invoice-vs-credit_note discriminator. */
export interface TaxRedactionEvidence {
  readonly occurredAt: Date;
  /** `'invoice'` | `'credit_note'` (the raw payload `document_kind`). */
  readonly documentKind: string;
}

/** The sub-processor (Resend) propagation outcome (US3-C). */
export interface SubprocessorOutcomeEvidence {
  readonly resendOutcome: string;
  readonly contactsRemoved: number;
  readonly contactsFailed: number;
}

/** One erased member's full, folded Art.17 evidence — the page's per-member card. */
export interface GroupedEvidence {
  readonly memberId: string;
  readonly memberNumber: number;
  /** The member's `erased_at` (from the erased-members list, not the audit log). */
  readonly erasedAt: Date;
  // --- request + attestation (member_erasure_requested) -------------------
  readonly requestedAt: Date | null;
  readonly reason: string | null;
  readonly identityVerified: boolean | null;
  readonly verificationMethod: string | null;
  readonly note: string | null;
  // --- completion (member_erased) -----------------------------------------
  readonly completedAt: Date | null;
  readonly sessionsRevokedTotal: number | null;
  readonly invitationsRevokedCount: number | null;
  /**
   * `member_erased.payload.re_drive` — `true` when the completion was reported
   * by a US2d reconciler RE-DRIVE pass (the original run half-failed and the
   * reconciler re-issued the cascade). A re-drive's cascade counts reflect ONLY
   * that pass, so they are commonly `0/0` (the original run already revoked the
   * sessions/invitations). The page surfaces this so the DPO does not misread a
   * legitimate `0/0` completion as a no-op. `false` for a first-pass completion,
   * `null` when there is no `member_erased` row (a half-run).
   */
  readonly reDrive: boolean | null;
  // --- lifecycle proofs ----------------------------------------------------
  readonly userErasedProofs: readonly UserErasedProof[];
  readonly taxRedactions: readonly TaxRedactionEvidence[];
  readonly subprocessorOutcome: SubprocessorOutcomeEvidence | null;
  // --- flags ---------------------------------------------------------------
  readonly halfRun: boolean;
  readonly isOverdue: boolean;
}

/** The auth `erasureEvidenceReadAdapter` surface this use-case depends on. */
export interface ErasureEvidenceReader {
  readForMember(
    ctx: TenantContext,
    memberId: string,
    memberLinkedUserIds: readonly string[],
  ): Promise<readonly ErasureEvidenceRow[]>;
}

export interface GetErasureEvidenceLogDeps {
  /** members barrel — keyset page of `erased_at IS NOT NULL` members, newest-first. */
  readonly listErasedMembers: (
    ctx: TenantContext,
    input: { limit: number; cursor?: ErasedMembersCursor },
  ) => Promise<ListErasedMembersResult>;
  /** members barrel — a member's UNFILTERED linked-login user ids (`[]` ⇔ none). */
  readonly listMemberLinkedUserIds: (
    ctx: TenantContext,
    memberId: string,
  ) => Promise<readonly string[]>;
  /** auth `erasureEvidenceReadAdapter` — one member's raw evidence rows. */
  readonly evidenceReader: ErasureEvidenceReader;
}

export interface GetErasureEvidenceLogInput {
  readonly ctx: TenantContext;
  readonly limit: number;
  readonly cursor?: ErasedMembersCursor;
  /** Injected wall-clock instant — the overdue comparison uses ONLY this. */
  readonly now: Date;
}

export interface GetErasureEvidenceLogResult {
  readonly rows: readonly GroupedEvidence[];
  readonly nextCursor: ErasedMembersCursor | null;
}

// --- payload field readers (defensive: jsonb is `Record<string, unknown>`) ---

function str(payload: Record<string, unknown> | null, key: string): string | null {
  const v = payload?.[key];
  return typeof v === 'string' ? v : null;
}

function bool(payload: Record<string, unknown> | null, key: string): boolean | null {
  const v = payload?.[key];
  return typeof v === 'boolean' ? v : null;
}

function num(payload: Record<string, unknown> | null, key: string): number | null {
  const v = payload?.[key];
  return typeof v === 'number' ? v : null;
}

/**
 * The EARLIEST row of an event type — the AUTHORITATIVE signal for the DPO.
 * Rows arrive newest-first, but a member can carry MULTIPLE rows of a type and
 * the FIRST one is authoritative, never a later re-drive:
 *  - `subprocessor_erasure_propagated`: a re-drive after a first-pass `failed`
 *    emits a 2nd VACUOUS `{ok, removed:0}` (US3-C runbook cond-3) — reading the
 *    latest `ok` would MASK the original `failed` on the very page built to
 *    surface it. Pick the earliest = the real first-pass outcome.
 *  - `member_erasure_requested`: concurrent requests — the EARLIEST timestamp
 *    wins the Art.12/§30 clock (the conservative direction; erase-member.ts).
 *  - `member_erased`: a racing reconciler re-drive can emit a 2nd completion
 *    (`re_drive:true`, 0/0 counts) — the first-pass completion has the real
 *    cascade counts. Picked by min timestamp (order-independent of the reader).
 *
 * NOT governed by `earliest`: `user_erased` + `event_buyer_pii_redacted` are
 * intentionally folded as ALL-rows lists (a member can have several legitimate
 * proofs — multiple linked logins, multiple redacted tax documents), so do NOT
 * "consistency-fix" them onto a single global `earliest`. (`user_erased` is
 * folded all-rows but DEDUPED PER DISTINCT linked login — see `fold` below — so
 * a reconciler re-drive's same-login dups collapse onto that login's earliest
 * while distinct logins stay as separate proofs.)
 */
function earliest(
  rows: readonly ErasureEvidenceRow[],
  type: ErasureEvidenceEventType,
): ErasureEvidenceRow | null {
  let best: ErasureEvidenceRow | null = null;
  for (const r of rows) {
    if (r.eventType !== type) continue;
    if (best === null || new Date(r.occurredAtIso).getTime() < new Date(best.occurredAtIso).getTime()) {
      best = r;
    }
  }
  return best;
}

/** Fold one member's raw evidence rows into the grouped DPO shape. */
function fold(member: ErasedMemberRow, rows: readonly ErasureEvidenceRow[], now: Date): GroupedEvidence {
  const requested = earliest(rows, ERASURE_EVIDENCE_EVENTS.requested);
  const erased = earliest(rows, ERASURE_EVIDENCE_EVENTS.erased);
  const reqPayload = requested?.payload ?? null;
  const erasedPayload = erased?.payload ?? null;

  const requestedAt = requested ? new Date(requested.occurredAtIso) : null;
  const completedAt = erased ? new Date(erased.occurredAtIso) : null;

  // Dedupe per distinct linked login: a reconciler re-drive re-emits a user_erased
  // per pass (erase-member re-runs eraseUser unconditionally; eraseUser appends
  // another user_erased each pass — deliberate append-only audit noise). Collapse
  // those re-drive duplicates of the SAME login onto the EARLIEST occurredAt (the
  // Art.12/§30 credential-erasure clock), while keeping ONE proof per DISTINCT
  // targetUserId (multiple linked logins => multiple proofs). targetUserId is the
  // dedupe KEY only — NEVER projected into the output (M-2 minimisation). Mirrors
  // the earliest()-is-authoritative doctrine used for the other arms.
  const earliestByLogin = new Map<string, Date>();
  for (const r of rows) {
    if (r.eventType !== ERASURE_EVIDENCE_EVENTS.userErased) continue;
    // Arm B matches target_user_id = ANY(...), so it is non-null for these rows;
    // fall back to the row id as a defensive distinct key if ever null.
    const key = r.targetUserId ?? r.id;
    const at = new Date(r.occurredAtIso);
    const prev = earliestByLogin.get(key);
    if (prev === undefined || at.getTime() < prev.getTime()) {
      earliestByLogin.set(key, at);
    }
  }
  // M-2: occurredAt + the credential-erased marker ONLY — the row's actorUserId
  // (and the targetUserId dedupe key) are NOT projected (foreign-tenant leak risk).
  const userErasedProofs: UserErasedProof[] = [...earliestByLogin.values()]
    .sort((a, b) => a.getTime() - b.getTime())
    .map((occurredAt) => ({ occurredAt, credentialErased: true as const }));

  const taxRedactions: TaxRedactionEvidence[] = rows
    .filter((r) => r.eventType === ERASURE_EVIDENCE_EVENTS.taxRedacted)
    .map((r) => ({
      occurredAt: new Date(r.occurredAtIso),
      documentKind: str(r.payload, 'document_kind') ?? 'unknown',
    }));

  const sub = earliest(rows, ERASURE_EVIDENCE_EVENTS.subprocessorPropagated);
  const subprocessorOutcome: SubprocessorOutcomeEvidence | null = sub
    ? {
        resendOutcome: str(sub.payload, 'resend_outcome') ?? 'unknown',
        contactsRemoved: num(sub.payload, 'resend_contacts_removed_count') ?? 0,
        contactsFailed: num(sub.payload, 'resend_contacts_failed_count') ?? 0,
      }
    : null;

  const halfRun = requested !== null && erased === null;
  const isOverdue =
    halfRun && requestedAt !== null && requestedAt.getTime() + THIRTY_DAYS_MS < now.getTime();

  return {
    memberId: member.memberId,
    memberNumber: member.memberNumber,
    erasedAt: member.erasedAt,
    requestedAt,
    reason: str(reqPayload, 'reason'),
    identityVerified: bool(reqPayload, 'identity_verified'),
    verificationMethod: str(reqPayload, 'verification_method'),
    note: str(reqPayload, 'note'),
    completedAt,
    sessionsRevokedTotal: num(erasedPayload, 'sessions_revoked_total'),
    invitationsRevokedCount: num(erasedPayload, 'invitations_revoked_count'),
    // `re_drive` is read ONLY from the completion row — `bool()` returns null
    // when the key (or the whole row) is absent, so a half-run is `null`, a
    // first-pass completion `false`, a reconciler re-drive `true`.
    reDrive: bool(erasedPayload, 're_drive'),
    userErasedProofs,
    taxRedactions,
    subprocessorOutcome,
    halfRun,
    isOverdue,
  };
}

/**
 * Page the erased-member list, read+fold each member's evidence, and return
 * the grouped rows + the member-list keyset cursor for "load more".
 *
 * Reads are issued sequentially per member (the page is small — a keyset
 * `limit` of erased members, each with ≤ a handful of linked logins — and the
 * evidence query is itself low-volume; a parallel fan-out would add no
 * meaningful win and complicate ordering). Order is preserved from
 * `listErasedMembers` (newest-erasure-first).
 */
export async function getErasureEvidenceLog(
  deps: GetErasureEvidenceLogDeps,
  input: GetErasureEvidenceLogInput,
): Promise<GetErasureEvidenceLogResult> {
  const page = await deps.listErasedMembers(input.ctx, {
    limit: input.limit,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });

  const rows: GroupedEvidence[] = [];
  for (const member of page.rows) {
    const linkedUserIds = await deps.listMemberLinkedUserIds(input.ctx, member.memberId);
    const evidence = await deps.evidenceReader.readForMember(
      input.ctx,
      member.memberId,
      linkedUserIds,
    );
    rows.push(fold(member, evidence, input.now));
  }

  return { rows, nextCursor: page.nextCursor };
}
