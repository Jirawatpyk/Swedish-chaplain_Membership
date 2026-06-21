'use client';

/**
 * COMP-1 US3-A — Erase action for the member detail page.
 *
 * GDPR Art.17 / PDPA §33 permanent erasure trigger. Standalone
 * destructive-outline button (NOT an overflow-menu item — ux-standards § 19
 * forbids destructive/irreversible actions inside a "More actions" menu) that
 * opens an AlertDialog. The destructive action is gated until the admin
 * (1) picks a legal basis, (2) attests Art.12 identity verification AND picks a
 * method, and (3) types the member number exactly.
 *
 * a11y: mirrors confirmation-dialog.tsx (NOT archive-member-button) —
 * initialFocus → Cancel; the gated action uses aria-disabled +
 * aria-describedby + a role=status checklist of remaining conditions so
 * screen-reader users learn WHY it is blocked (a native `disabled` button is
 * neither focusable nor announced).
 */

import { useState, useRef, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ShieldXIcon, Loader2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
// TYPE-ONLY import — erased by SWC, so it pulls ZERO runtime code from the
// barrel. The runtime `VERIFICATION_METHODS` value CANNOT be imported here: the
// `@/modules/members` barrel re-exports server-only infrastructure (the Drizzle
// repos bound to `@/lib/db`, the composition roots) that cannot run in the
// client graph and breaks the page's dev compile, while ESLint forbids deep
// module imports from components. So this `'use client'` component keeps a
// client-LOCAL copy below, anchored to the barrel TYPES (which are erased).
import type { EraseReason, VerificationMethod } from '@/modules/members';

// Client-local copy of the verification methods. These four MUST mirror
// `verificationMethodSchema` in `erase-member.ts` — the route + core schema's
// authoritative VALIDATION enum (the route re-validates every value, so this
// list is presentation-only) — and the `admin.members.erase.method.*` i18n
// keys. `satisfies readonly VerificationMethod[]` fails the build if any value
// is not a valid `VerificationMethod`; the `_AllMethodsListed` proof below
// fails the build if a schema method is MISSING here (completeness, both ways).
const VERIFICATION_METHODS = [
  'verified_account_login',
  'in_person',
  'email_confirmation_loop',
  'official_document',
] as const satisfies readonly VerificationMethod[];

// Completeness drift guard — resolves to `never` (a TS2322 error on the `= true`
// assignment) if a value is added to `verificationMethodSchema` but not listed
// above, so the dialog can never silently omit a legal verification method.
type _AllMethodsListed = Exclude<
  VerificationMethod,
  (typeof VERIFICATION_METHODS)[number]
> extends never
  ? true
  : never;
const _allMethodsListed: _AllMethodsListed = true;
void _allMethodsListed;

// Anchored to the barrel's `EraseReason` (type-only) so the dialog's legal-basis
// union can never drift from the schema enum recorded in the DPO audit log.
type Reason = EraseReason;

type Props = {
  readonly memberId: string;
  readonly companyName: string;
  /** Formatted member number, e.g. "SCCM-0042" — the type-to-confirm target. */
  readonly memberNumberDisplay: string;
};

export function EraseMemberButton({ memberId, companyName, memberNumberDisplay }: Props) {
  const t = useTranslations('admin.members.erase');
  const router = useRouter();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<Reason | null>(null);
  const [identityVerified, setIdentityVerified] = useState(false);
  const [method, setMethod] = useState<VerificationMethod | null>(null);
  const [note, setNote] = useState('');
  const [typedConfirm, setTypedConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [, startTransition] = useTransition();

  const resetState = useCallback(() => {
    setReason(null);
    setIdentityVerified(false);
    setMethod(null);
    setNote('');
    setTypedConfirm('');
    setLoading(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) resetState();
      setOpen(next);
    },
    [resetState],
  );

  const reasonOk = reason !== null;
  const methodOk = method !== null;
  const typedOk = typedConfirm === memberNumberDisplay;
  const canConfirm = reasonOk && identityVerified && methodOk && typedOk;

  async function handleConfirm() {
    if (!canConfirm || reason === null || method === null) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/members/${memberId}/erase`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          reason,
          identityVerified: true,
          verificationMethod: method,
          note: note.trim() || null,
        }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { cascadesComplete?: boolean };
        toast.success(
          data.cascadesComplete === false
            ? t('eraseSuccessPending', { companyName })
            : t('eraseSuccess', { companyName }),
        );
        setOpen(false);
        resetState();
        startTransition(() => router.refresh());
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        toast.error(data.error?.message ?? t('eraseError'));
      }
    } catch {
      toast.error(t('eraseError'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger
        className={buttonVariants({ variant: 'destructive-outline' })}
        aria-label={t('eraseCta')}
      >
        <ShieldXIcon className="size-4" aria-hidden="true" />
        {t('eraseCta')}
      </AlertDialogTrigger>
      <AlertDialogContent initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('dialogTitle')}</AlertDialogTitle>
          {/* Prominent permanence callout (UX M3) — destructive treatment, not
              a muted AlertDialogDescription. */}
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm font-medium text-destructive">
            {t('permanenceCallout', { companyName, memberNumber: memberNumberDisplay })}
          </p>
        </AlertDialogHeader>

        <div className="flex flex-col gap-4">
          {/* Reason — legal basis */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t('reasonLegend')}</legend>
            <RadioGroup value={reason ?? ''} onValueChange={(v) => setReason(v as Reason)}>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="gdpr_erasure_request" id="erase-reason-gdpr" />
                <Label htmlFor="erase-reason-gdpr" className="font-normal">{t('reasonGdpr')}</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="pdpa_deletion_request" id="erase-reason-pdpa" />
                <Label htmlFor="erase-reason-pdpa" className="font-normal">{t('reasonPdpa')}</Label>
              </div>
            </RadioGroup>
          </fieldset>

          {/* Art.12 attestation */}
          <div className="flex items-start gap-2">
            <Checkbox
              id="erase-attestation"
              checked={identityVerified}
              onCheckedChange={(c) => setIdentityVerified(c === true)}
            />
            <Label htmlFor="erase-attestation" className="font-normal leading-snug">
              {t('attestationLabel')}
            </Label>
          </div>

          {/* Verification method */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="erase-method">{t('methodLabel')}</Label>
            <Select value={method ?? ''} onValueChange={(v) => setMethod(v as VerificationMethod)}>
              <SelectTrigger id="erase-method" aria-label={t('methodLabel')}>
                <SelectValue placeholder={t('methodPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {VERIFICATION_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(`method.${m}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Optional note */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="erase-note">{t('noteLabel')}</Label>
            <Textarea
              id="erase-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder={t('notePlaceholder')}
            />
            <p className="text-xs text-muted-foreground">{t('noteHelper')}</p>
          </div>

          {/* Type-to-confirm */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="erase-confirm">
              {t('confirmLabel', { memberNumber: memberNumberDisplay })}
            </Label>
            <Input
              id="erase-confirm"
              value={typedConfirm}
              onChange={(e) => setTypedConfirm(e.target.value)}
              placeholder={memberNumberDisplay}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          {/* a11y M1 — remaining-conditions checklist, announced politely. */}
          {!canConfirm && (
            <div
              id="erase-gate-checklist"
              role="status"
              className="rounded-md bg-muted p-3 text-xs text-muted-foreground"
            >
              <p className="font-medium">{t('gateHeading')}</p>
              <ul className="mt-1 list-disc pl-4">
                {!reasonOk && <li>{t('gateReason')}</li>}
                {!identityVerified && <li>{t('gateAttestation')}</li>}
                {!methodOk && <li>{t('gateMethod')}</li>}
                {!typedOk && <li>{t('gateTyped')}</li>}
              </ul>
            </div>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={loading}>
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            aria-disabled={!canConfirm || undefined}
            aria-describedby={!canConfirm ? 'erase-gate-checklist' : undefined}
            aria-busy={loading}
            className={buttonVariants({ variant: 'destructive' })}
            onClick={(e) => {
              e.preventDefault();
              if (!canConfirm) return;
              void handleConfirm();
            }}
          >
            {loading && (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            )}
            {loading ? t('erasingInProgress') : t('confirmCta')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
