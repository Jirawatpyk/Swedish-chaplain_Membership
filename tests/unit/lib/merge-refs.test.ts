import { describe, it, expect, vi } from 'vitest';
import { mergeRefs } from '@/lib/merge-refs';

describe('mergeRefs', () => {
  it('assigns the node to BOTH an object ref and a callback ref (the Base UI trap)', () => {
    const objectRef: { current: string | null } = { current: null };
    const callbackRef = vi.fn();
    const merged = mergeRefs<string>(objectRef, callbackRef);

    merged('node');

    expect(objectRef.current).toBe('node');
    expect(callbackRef).toHaveBeenCalledWith('node');
  });

  it('propagates null on unmount to every ref', () => {
    const objectRef: { current: string | null } = { current: 'x' };
    const callbackRef = vi.fn();
    const merged = mergeRefs<string>(objectRef, callbackRef);

    merged(null);

    expect(objectRef.current).toBeNull();
    expect(callbackRef).toHaveBeenCalledWith(null);
  });

  it('skips null / undefined refs without throwing', () => {
    const objectRef: { current: number | null } = { current: null };
    const merged = mergeRefs<number>(undefined, null, objectRef);
    expect(() => merged(7)).not.toThrow();
    expect(objectRef.current).toBe(7);
  });

  it('does NOT lose the first ref — the exact regression that broke the menu (only-rightmost-ref-wins)', () => {
    // A bare `ref={triggerRef}` after `{...props}` kept only triggerRef and
    // dropped Base UI's ref (its Positioner lost the anchor → menu never
    // opened). mergeRefs must keep the FIRST (Base UI) ref too.
    const baseUiRef = vi.fn();
    const triggerRef: { current: string | null } = { current: null };
    mergeRefs<string>(baseUiRef, triggerRef)('el');
    expect(baseUiRef).toHaveBeenCalledWith('el'); // Base UI ref NOT lost
    expect(triggerRef.current).toBe('el');
  });
});
