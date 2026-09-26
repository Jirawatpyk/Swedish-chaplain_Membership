/**
 * The product's single toast API (spec 122 FR-007, contracts/toast-facade.md).
 *
 * Every call site imports `toast` from here and every test mocks this module,
 * never a toast library, so the implementation behind it changes in one place
 * (sonner today, AURA next). The option set is deliberately narrow — the
 * subset the product actually uses — and plain-text only: a description is a
 * string, and a toast carries at most one action.
 */
import { toast as impl, type ExternalToast } from 'sonner';

export interface ToastAction {
  readonly label: string;
  readonly onClick?: (() => void) | undefined;
}

export interface ToastOptions {
  readonly description?: string | undefined;
  /** Reusing an id replaces that toast in place. */
  readonly id?: string | undefined;
  readonly action?: ToastAction | undefined;
  /** Milliseconds; `Infinity` keeps the toast until dismissed. */
  readonly duration?: number | undefined;
  /** Accepted for existing callers; the toast is always dismissible. */
  readonly closeButton?: boolean | undefined;
}

type Show = (title: string, opts?: ToastOptions) => string;

export interface Toast extends Show {
  readonly success: Show;
  readonly error: Show;
  readonly warning: Show;
  readonly info: Show;
  readonly loading: Show;
  readonly dismiss: (id: string) => void;
}

function toImpl(opts: ToastOptions | undefined): ExternalToast | undefined {
  if (opts === undefined) return undefined;
  const out: ExternalToast = {};
  if (opts.description !== undefined) out.description = opts.description;
  if (opts.id !== undefined) out.id = opts.id;
  if (opts.duration !== undefined) out.duration = opts.duration;
  if (opts.closeButton !== undefined) out.closeButton = opts.closeButton;
  if (opts.action !== undefined) out.action = { label: opts.action.label, onClick: opts.action.onClick ?? (() => {}) };
  return out;
}

const show = (fn: (title: string, data?: ExternalToast) => string | number): Show =>
  (title, opts) => String(fn(title, toImpl(opts)));

export const toast: Toast = Object.assign(show(impl), {
  success: show(impl.success),
  error: show(impl.error),
  warning: show(impl.warning),
  info: show(impl.info),
  loading: show(impl.loading),
  dismiss: (id: string) => {
    impl.dismiss(id);
  },
});
