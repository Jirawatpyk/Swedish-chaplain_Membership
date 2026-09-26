/**
 * Plan state actions (T136–T137, US4) — Activate / Deactivate / Delete /
 * Restore — shared by the plans list row menu and the plan detail header.
 *
 * Each destructive or state-changing action opens a `ConfirmationDialog` per
 * UX standards § 4.1 (Activate is non-destructive and fires immediately),
 * calls the matching API endpoint with a fresh `Idempotency-Key`, and on
 * success shows a toast + `router.refresh()` to repull server state.
 * Nothing is optimistically mutated — the server is the source of truth
 * (FR-018/LWW).
 */
'use client';

import { useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { isReadOnlyCode, problemCode } from '@/lib/http/read-only-refusal';

export type PlanActionKind = 'activate' | 'deactivate' | 'delete' | 'undelete';

/** The plan fields an action needs — `PlanListItem` satisfies it. */
export interface PlanActionTarget {
  readonly plan_id: string;
  readonly plan_year: number;
  readonly plan_name: { readonly en: string };
}

type PendingAction = {
  readonly kind: PlanActionKind;
  readonly plan: PlanActionTarget;
};

function endpointFor(kind: PlanActionKind, plan: PlanActionTarget): {
  readonly method: 'POST' | 'DELETE';
  readonly url: string;
} {
  const base = `/api/plans/${plan.plan_year}/${plan.plan_id}`;
  switch (kind) {
    case 'activate':
      return { method: 'POST', url: `${base}/activate` };
    case 'deactivate':
      return { method: 'POST', url: `${base}/deactivate` };
    case 'delete':
      return { method: 'DELETE', url: base };
    case 'undelete':
      return { method: 'POST', url: `${base}/undelete` };
  }
}

function freshIdempotencyKey(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `plans-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface PlanActions {
  /** Start an action — confirms first unless it is `activate`. */
  readonly openAction: (kind: PlanActionKind, plan: PlanActionTarget) => void;
  /** A request is in flight. */
  readonly submitting: boolean;
  /** The post-success `router.refresh()` is still running. */
  readonly isPending: boolean;
  /** The confirmation dialog — render it once, anywhere in the tree. */
  readonly dialog: ReactNode;
}

export function usePlanActions(): PlanActions {
  const router = useRouter();
  const tConfirm = useTranslations('admin.plans.confirm');
  const tToast = useTranslations('admin.plans.toast');
  const tErrors = useTranslations('admin.plans.errors');
  const tButtons = useTranslations('admin.plans.create.buttons');
  const [isPending, startTransition] = useTransition();

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Synchronous in-flight guard for the no-confirmation Activate path.
  // `submitting` (React state) only flips on the NEXT render — after an
  // await tick — so two rapid Activate clicks both passed the
  // `if (submitting) return` gate and each minted a fresh
  // Idempotency-Key, defeating server-side dedupe. A ref mutates
  // synchronously, so the second click sees `inFlightRef.current === true`
  // within the same event-loop turn and bails before the second fetch.
  const inFlightRef = useRef(false);

  async function runAction(action: PendingAction): Promise<void> {
    const { method, url } = endpointFor(action.kind, action.plan);
    setSubmitting(true);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': freshIdempotencyKey(),
        },
      });
      if (res.ok) {
        const toastKey = (
          {
            activate: 'activated',
            deactivate: 'deactivated',
            delete: 'deleted',
            undelete: 'undeleted',
          } as const
        )[action.kind];
        toast.success(
          tToast(toastKey, { planName: action.plan.plan_name.en }),
        );
        startTransition(() => {
          router.refresh();
        });
      } else {
        const body = (await res.json().catch(() => null)) as {
          error?:
            | string
            | { code?: string; details?: { affected_member_count?: number } };
        } | null;
        // read-only-mode 503: flat string (proxy) OR nested code (route guard)
        // — both shapes and both spellings live in `problemCode` /
        // `isReadOnlyCode` now (PR-3 review B7). The status is NOT part of the
        // test here, exactly as before: this ladder branches on the code alone.
        const errObj = body?.error;
        const code = problemCode(body);
        if (isReadOnlyCode(code)) {
          toast.error(tErrors('readOnlyMode'));
        } else if (code === 'plan_has_active_members') {
          toast.error(
            tErrors('memberAttached', {
              count:
                (typeof errObj === 'object'
                  ? errObj?.details?.affected_member_count
                  : undefined) ?? 0,
            }),
          );
        } else if (code === 'not_found') {
          toast.error(tErrors('notFound'));
        } else if (code === 'idempotency_conflict') {
          toast.error(tErrors('idempotencyConflict'));
        } else {
          toast.error(tErrors('generic'));
        }
      }
    } catch {
      toast.error(tErrors('network'));
    } finally {
      setSubmitting(false);
      setPending(null);
      // Release the synchronous Activate guard once the request settles
      // (success or failure) so a subsequent legitimate Activate can run.
      inFlightRef.current = false;
    }
  }

  function openAction(kind: PlanActionKind, plan: PlanActionTarget): void {
    if (kind === 'activate') {
      // Activate is non-destructive — fire immediately, no confirmation.
      // SYNCHRONOUS guard: `submitting` (state) only updates next render,
      // so two fast clicks both slipped past a `if (submitting)` check and
      // each minted a fresh Idempotency-Key (server couldn't dedupe). The
      // ref flips within this same turn, so the second click bails here.
      if (inFlightRef.current || submitting) return;
      inFlightRef.current = true;
      runAction({ kind, plan }).catch(() => {});
      return;
    }
    setPending({ kind, plan });
  }

  const dialog = pending ? (
    <ConfirmationDialog
      open={true}
      onOpenChange={(open) => {
        if (!open && !submitting) setPending(null);
      }}
      title={tConfirm(`${pending.kind as 'deactivate' | 'delete' | 'undelete'}.title`, {
        planName: pending.plan.plan_name.en,
      })}
      description={tConfirm(
        `${pending.kind as 'deactivate' | 'delete' | 'undelete'}.description`,
      )}
      confirmLabel={tConfirm(
        `${pending.kind as 'deactivate' | 'delete' | 'undelete'}.confirmCta`,
      )}
      cancelLabel={tButtons('cancel')}
      onConfirm={() => runAction(pending)}
      destructive={pending.kind === 'delete'}
    />
  ) : null;

  return { openAction, submitting, isPending, dialog };
}
