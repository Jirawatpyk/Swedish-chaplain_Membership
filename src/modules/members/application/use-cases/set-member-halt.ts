/**
 * T029 — F7 set-member-halt use-case (F3 module).
 *
 * Used by F7's `MembersBridgePort.setMemberHalt` (Phase 3+ T060).
 * Q14 admin clear-halt action — toggles
 * `members.broadcasts_halted_until_admin_review` flag. Authz: admin role
 * only (manager role denied per FR-014).
 *
 * **Audit emission is NOT performed here** — F3 mutates the flag column
 * only; F7's caller emits `broadcast_member_dispatch_resumed`
 * (when halted=false) or `broadcast_member_halted_pending_review`
 * (when halted=true) via F7's own audit-port + adapter (Phase 3+).
 * This keeps F3's `audit_event_type` DB-enum writes free of F7-specific
 * literals and the F7 → F3 dependency direction clean.
 */
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';
import type { MemberRepo, RepoError } from '../ports/member-repo';
import type { Role } from '@/modules/auth';

export type MemberHaltError =
  | RepoError
  | { code: 'member_halt.unauthorised'; actorRole: string }
  | { code: 'member_halt.member_not_found'; memberId: string };

export type SetMemberHaltDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
};

export type SetMemberHaltMeta = {
  /**
   * 016 T030/T033 — literal session role; the arm below keys on the literal.
   *
   * 017 actor-role truth sweep — widened with `'system'`, which is what the
   * bounce-threshold HALT actually is: the F7 Resend webhook sets the flag,
   * no human does. Until now the F7 bridge hardcoded `'admin'` for BOTH
   * paths, which made the check below a no-op (every caller "was" an admin)
   * AND recorded a human role for an automated action.
   */
  readonly actorRole: Role | 'system';
};

export async function setMemberHalt(
  deps: SetMemberHaltDeps,
  memberId: MemberId,
  halted: boolean,
  meta: SetMemberHaltMeta,
): Promise<Result<void, MemberHaltError>> {
  // The admissible set, stated once and matching what the F7 route gate
  // (`broadcasts.clear_halt`) admits:
  //   admin + super_admin — the admin tier ('admin' alone would deny every
  //     promoted super_admin post-Migration-C);
  //   system — the automated bounce-threshold halt (Resend webhook), which
  //     SETS the flag rather than clearing it.
  // manager (FR-014), marketing and member are denied.
  //
  // 018 DECISION — marketing NARROWED OUT (spec 010 § Requirements amendment,
  // 2026-08-15). It could clear halts in production, but only because the F7
  // bridge hard-coded `{actorRole:'admin'}`, which made this very check admit
  // everyone; that was a defect, never a decision. Clearing a halt is a
  // deliverability judgement whose blast radius is tenant-wide sender
  // reputation, and marketing is the role that benefits from lifting it —
  // self-review. The asymmetry decided it: narrowing wrongly costs one admin
  // click, keeping it wrongly costs reputation damage with a slow, hard-to-
  // reverse feedback loop. `broadcasts.clear_halt` was split out of
  // `broadcasts.write` for exactly this. The lockstep test derives the human
  // half of this set from that key's holders, so the two cannot drift.
  const ADMISSIBLE: ReadonlySet<string> = new Set([
    'admin',
    'super_admin',
    'system',
  ]);
  if (!ADMISSIBLE.has(meta.actorRole)) {
    return err({
      code: 'member_halt.unauthorised',
      actorRole: meta.actorRole,
    });
  }

  try {
    return await runInTenant(deps.tenant, async (tx) => {
      const updateResult = await deps.memberRepo.updateBroadcastsHaltedInTx(
        tx,
        memberId,
        halted,
      );
      if (!updateResult.ok) return err(updateResult.error);
      if (updateResult.value.affected === 0) {
        return err({
          code: 'member_halt.member_not_found',
          memberId,
        });
      }
      return ok(undefined as void);
    });
  } catch (e) {
    return err({ code: 'repo.unexpected', cause: e });
  }
}
