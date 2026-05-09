/**
 * F8 Phase 8 R10 S11 close — unit tests for the pure
 * `selectActionErrorKey` dispatcher that maps `(action, rawCode)` to a
 * i18n key.
 *
 * Coverage matrix:
 *   - `forbidden` → per-action key (3 actions)
 *   - 7 other wire codes × 1 action each (shared key)
 *   - `offline` (client-synthetic) → shared key
 *   - Untrusted server-side code (e.g. `'evil'`) → `unknown` fallback
 *   - Empty string → `unknown` fallback
 */
import { describe, it, expect } from 'vitest';
import {
  WIRE_ERROR_CODES,
  isWireErrorCode,
  selectActionErrorKey,
} from '@/app/(staff)/admin/renewals/tasks/_components/_describe-error';

describe('selectActionErrorKey (R10 S11)', () => {
  it('forbidden → per-action key for done', () => {
    expect(selectActionErrorKey('done', 'forbidden')).toBe(
      'actions.done.errors.forbidden',
    );
  });

  it('forbidden → per-action key for skip', () => {
    expect(selectActionErrorKey('skip', 'forbidden')).toBe(
      'actions.skip.errors.forbidden',
    );
  });

  it('forbidden → per-action key for reassign', () => {
    expect(selectActionErrorKey('reassign', 'forbidden')).toBe(
      'actions.reassign.errors.forbidden',
    );
  });

  it('task_not_open → shared key', () => {
    expect(selectActionErrorKey('done', 'task_not_open')).toBe(
      'actions.errors.task_not_open',
    );
  });

  it('task_not_found → shared key', () => {
    expect(selectActionErrorKey('skip', 'task_not_found')).toBe(
      'actions.errors.task_not_found',
    );
  });

  it('feature_disabled → shared key', () => {
    expect(selectActionErrorKey('reassign', 'feature_disabled')).toBe(
      'actions.errors.feature_disabled',
    );
  });

  it('unauthenticated → shared key', () => {
    expect(selectActionErrorKey('done', 'unauthenticated')).toBe(
      'actions.errors.unauthenticated',
    );
  });

  it('invalid_input → shared key', () => {
    expect(selectActionErrorKey('skip', 'invalid_input')).toBe(
      'actions.errors.invalid_input',
    );
  });

  it('invalid_cursor → shared key', () => {
    expect(selectActionErrorKey('reassign', 'invalid_cursor')).toBe(
      'actions.errors.invalid_cursor',
    );
  });

  it('server_error → shared key', () => {
    expect(selectActionErrorKey('done', 'server_error')).toBe(
      'actions.errors.server_error',
    );
  });

  it('offline (client-synthetic) → shared key', () => {
    // R6 IMP-3 separation — `offline` is generated locally from a
    // TypeError fetch failure, never sent by the server. The
    // dispatcher accepts it as a special-case pass-through.
    expect(selectActionErrorKey('done', 'offline')).toBe(
      'actions.errors.offline',
    );
  });

  it('unknown wire code (e.g. drifted server response) → unknown fallback', () => {
    expect(selectActionErrorKey('done', 'evil_freetext_code')).toBe(
      'actions.errors.unknown',
    );
  });

  it('empty string → unknown fallback (defence-in-depth)', () => {
    expect(selectActionErrorKey('skip', '')).toBe('actions.errors.unknown');
  });

  it('isWireErrorCode narrows to literal union', () => {
    // Sanity check on the type guard — every code in the const tuple
    // returns true; arbitrary strings return false.
    for (const code of WIRE_ERROR_CODES) {
      expect(isWireErrorCode(code)).toBe(true);
    }
    expect(isWireErrorCode('not_in_set')).toBe(false);
    expect(isWireErrorCode('')).toBe(false);
  });
});
