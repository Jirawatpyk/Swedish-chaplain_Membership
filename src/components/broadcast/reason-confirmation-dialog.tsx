/**
 * F114 T004 — promoted to `@/components/shell/reason-confirmation-dialog`
 * (research R13: the change-request decision dialog reuses it, so it is a
 * shell component now, not a broadcasts one). This re-export keeps the 14
 * existing import sites and the dialog-final-focus tests byte-identical;
 * new callers import from `@/components/shell/…` directly.
 */
export {
  ReasonConfirmationDialog,
  useDialogFinalFocus,
  type ReasonConfirmationDialogProps,
} from '@/components/shell/reason-confirmation-dialog';
