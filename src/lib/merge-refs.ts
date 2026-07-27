import type { Ref } from 'react';

/**
 * Merge several React refs into one callback ref that assigns the node to
 * every provided ref (function or object). Refs that are `null`/`undefined`
 * are skipped.
 *
 * ## Why this exists — the Base UI `render`-prop ref trap
 *
 * Base UI parts (`Menu.Trigger`, etc.) render a `<button>` by default and let
 * you swap the element via `render={(props) => <MyButton {...props} />}`. In
 * **React 19 the part's own ref arrives inside that `props` object** (see the
 * Base UI composition docs: "the custom component must forward the ref, and
 * spread all the received props"). Writing `<Button {...props} ref={myRef} />`
 * therefore OVERRIDES Base UI's ref — and Base UI's own `mergeProps` keeps only
 * the rightmost ref, so the part loses its handle on the trigger element. The
 * click handler still fires (it is a plain prop) but the Positioner can no
 * longer anchor the popup, so the menu never visibly opens.
 *
 * The fix is to forward BOTH refs: destructure the part's `ref` out of `props`
 * and merge it with your own —
 * `render={({ ref, ...rest }) => <Button {...rest} ref={mergeRefs(ref, myRef)} />}`.
 */
export function mergeRefs<T>(
  ...refs: ReadonlyArray<Ref<T> | undefined>
): (node: T | null) => void {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref != null) {
        (ref as { current: T | null }).current = node;
      }
    }
  };
}
