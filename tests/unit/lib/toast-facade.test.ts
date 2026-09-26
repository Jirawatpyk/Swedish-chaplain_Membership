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
        action: { label: 'Undo', onClick: expect.any(Function) },
      });
      const passed = impl[method]!.mock.calls[0]![1] as { action: { onClick: () => void } };
      passed.action.onClick();
      expect(onClick).toHaveBeenCalledTimes(1);
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

  it('after a toast action, focus returns to where it was when the toast appeared', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    toast.success('Removed', { action: { label: 'Undo', onClick: () => {} } });
    // AURA removes the toast (and its focused action button) after the click.
    (document.activeElement as HTMLElement | null)?.blur();
    const passed = impl.success!.mock.calls[0]![1] as { action: { onClick: () => void } };
    passed.action.onClick();
    await Promise.resolve();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('leaves focus alone when the action moved it somewhere on purpose', async () => {
    const trigger = document.createElement('button');
    const target = document.createElement('input');
    document.body.append(trigger, target);
    trigger.focus();
    toast.success('Removed', { action: { label: 'Undo', onClick: () => target.focus() } });
    const passed = impl.success!.mock.calls[0]![1] as { action: { onClick: () => void } };
    passed.action.onClick();
    await Promise.resolve();
    expect(document.activeElement).toBe(target);
    trigger.remove();
    target.remove();
  });

  it('a plain call passes the title (and any options) as one AURA options object', () => {
    expect(toast('Sending in a moment')).toBe('id-plain');
    expect(impl).toHaveBeenCalledWith({ title: 'Sending in a moment' });
    toast('Queued', { id: 'q', duration: 3000 });
    expect(impl).toHaveBeenLastCalledWith({ title: 'Queued', id: 'q', duration: 3000 });
  });

  it('never forwards closeButton — every AURA toast is dismissible', () => {
    toast.warning('Check the bills', { closeButton: true, duration: Infinity });
    expect(impl.warning).toHaveBeenCalledWith('Check the bills', { duration: Infinity });
  });

  it('dismiss forwards the id', () => {
    toast.dismiss('plan-save');
    expect(impl.dismiss).toHaveBeenCalledWith('plan-save');
  });
});
