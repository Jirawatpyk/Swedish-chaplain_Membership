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
 * a11y: mirrors confirmation-dialog.tsx — focus starts on Cancel; the gated
 * action uses aria-disabled + aria-describedby + a role=status checklist of
 * remaining conditions so screen-reader users learn WHY it is blocked (a
 * native `disabled` button is neither focusable nor announced).
 *
 * Spec 122 US5b-1: an AURA `Dialog role="alertdialog"` (a stray scrim click
 * never throws the form away; its body scrolls on a short screen while the
 * footer stays put) with AURA `RadioGroup`, `Checkbox`, `Select`, `Textarea`
 * and `TextField`. Behaviour and gates unchanged.
 */

import { useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ShieldXIcon } from 'lucide-react';
import { Alert, Button, Checkbox, Dialog, RadioGroup, Select, TextField, Textarea, buttonClass } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
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
        const data = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        // Map the server error CODE to localized copy — never render the
        // server's raw English `error.message`.
        toast.error(
          data.error?.code === 'not_found' ? t('eraseNotFound') : t('eraseError'),
        );
      }
    } catch {
      toast.error(t('eraseError'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button variant="danger-secondary" onClick={() => handleOpenChange(true)}>
        <ShieldXIcon className="size-4" aria-hidden="true" />
        {t('eraseCta')}
      </Button>
      <Dialog
        role="alertdialog"
        open={open}
        onClose={() => handleOpenChange(false)}
        // No Escape / close while the erasure runs.
        dismissible={!loading}
        title={t('dialogTitle')}
        footer={
          <>
            <Button variant="secondary" data-autofocus disabled={loading} onClick={() => handleOpenChange(false)}>
              {t('cancel')}
            </Button>
            {/* A plain button with AURA's classes: AURA's Button replaces a
                passed aria-disabled with its own loading flag, and this gate
                must stay focusable and announced while blocked (AURA handoff). */}
            <button
              type="button"
              className={buttonClass({ variant: 'danger', loading })}
              aria-busy={loading || undefined}
              aria-disabled={!canConfirm || loading || undefined}
              aria-describedby={!canConfirm ? 'erase-gate-checklist' : undefined}
              onClick={() => {
                if (!canConfirm || loading) return;
                void handleConfirm();
              }}
            >
              {loading ? t('erasingInProgress') : t('confirmCta')}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {/* Prominent permanence callout (UX M3) — the danger treatment, not a
              muted description. A note, not a live region: it is read with
              the dialog. */}
          <Alert tone="danger" role="note">
            {t('permanenceCallout', { companyName, memberNumber: memberNumberDisplay })}
          </Alert>

          <RadioGroup
            label={t('reasonLegend')}
            name="erase-reason"
            value={reason ?? ''}
            onChange={(v) => setReason(v as Reason)}
            options={[
              { value: 'gdpr_erasure_request', label: t('reasonGdpr') },
              { value: 'pdpa_deletion_request', label: t('reasonPdpa') },
            ]}
          />

          <Checkbox
            id="erase-attestation"
            checked={identityVerified}
            onChange={(c) => setIdentityVerified(c)}
          >
            {t('attestationLabel')}
          </Checkbox>

          <Select
            id="erase-method"
            label={t('methodLabel')}
            placeholder={t('methodPlaceholder')}
            value={method ?? ''}
            onChange={(e) => setMethod((e.target.value || null) as VerificationMethod | null)}
            options={VERIFICATION_METHODS.map((m) => ({ value: m, label: t(`method.${m}`) }))}
          />

          <Textarea
            id="erase-note"
            label={t('noteLabel')}
            hint={t('noteHelper')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder={t('notePlaceholder')}
          />

          {/* Type-to-confirm */}
          <TextField
            id="erase-confirm"
            label={t('confirmLabel', { memberNumber: memberNumberDisplay })}
            value={typedConfirm}
            onChange={(e) => setTypedConfirm(e.target.value)}
            placeholder={memberNumberDisplay}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />

          {/* a11y M1 — remaining-conditions checklist, announced politely. */}
          {!canConfirm && (
            <div
              id="erase-gate-checklist"
              role="status"
              className="rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] p-3 text-xs text-[var(--aura-fg-secondary)]"
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
      </Dialog>
    </>
  );
}
