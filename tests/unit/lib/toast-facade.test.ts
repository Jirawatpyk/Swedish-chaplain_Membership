/**
 * `@/lib/toast` — the product's single toast API (spec 122 FR-007,
 * contracts/toast-facade.md), backed by AURA's `toast`. Every call site and
 * every test mock goes through this module, so the library behind it changes
 * in one place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const impl = vi.hoisted(() => {
  const fn = vi.fn(() => 'id-plain') as ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>;
  fn.success = vi.fn(() => 'id-success');
  fn.error = vi.fn(() => 'id-error');
  fn.warning = vi.fn(() => 'id-warning');
  fn.info = vi.fn(() => 'id-info');
  fn.loading = vi.fn(() => 'id-loading');
  fn.dismiss = vi.fn();
  return fn;
});
vi.mock('@jirawatpyk/aura-react', () => ({ toast: impl }));

import { toast } from '@/lib/toast';

describe('@/lib/toast facade (AURA)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['success', 'error', 'warning', 'info', 'loading'] as const)(
    '%s forwards the title and the option subset, and returns the id',
    (method) => {
      const onClick = vi.fn();
      const id = toast[method]('Saved', {
        description: 'The plan was updated.',
        id: 'plan-save',
        duration: 8000,
        action: { label: 'Undo', onClick },
      });
      expect(id).toBe(`id-${method}`);
      expect(impl[method]).toHaveBeenCalledWith('Saved', {
        description: 'The plan was updated.',
        id: 'plan-save',
        duration: 8000,
        action: { label: 'Undo', onClick },
      });
    },
  );

  it('an error toast stays until dismissed unless a duration is given (ux-standards § 4.2)', () => {
    toast.error('Could not save');
    expect(impl.error).toHaveBeenCalledWith('Could not save', { duration: Infinity });
    toast.error('Retrying', { duration: 4000 });
    expect(impl.error).toHaveBeenLastCalledWith('Retrying', { duration: 4000 });
    toast.success('Saved');
    expect(impl.success).toHaveBeenCalledWith('Saved', undefined);
  });

  it('forwards rich descriptions and link actions untouched (AURA 5.6, handoff #53)', () => {
    const description = { type: 'ul' } as unknown as React.ReactNode;
    toast.warning('Bills to void', { description, action: { label: 'Open', href: '/admin/invoices/x', dismiss: false } });
    expect(impl.warning).toHaveBeenCalledWith('Bills to void', {
      description,
      action: { label: 'Open', href: '/admin/invoices/x', dismiss: false },
    });
  });

  it('dismiss forwards the id', () => {
    toast.dismiss('plan-save');
    expect(impl.dismiss).toHaveBeenCalledWith('plan-save');
  });
});
