/**
 * #739 B3a — `formatErrorClass` is what the events module stores about a
 * thrown value: the `webhook_rolled_back` audit payload. It names the class
 * and, one level down, the cause's class — never a message, which for a
 * drizzle error quotes bound parameters (emails, names).
 */
import { describe, it, expect } from 'vitest';
import { formatErrorClass } from '@/modules/events/application/use-cases/_helpers/format-error-with-cause';

describe('#739 — formatErrorClass', () => {
  it('a non-Error is the unknown class', () => {
    expect(formatErrorClass('a@b.example')).toBe('unknown');
    expect(formatErrorClass(null)).toBe('unknown');
  });

  it('an Error is its class, never its message', () => {
    class DrizzleQueryError extends Error {}
    expect(formatErrorClass(new DrizzleQueryError('params: a@b.example'))).toBe('DrizzleQueryError');
  });

  it('an Error cause adds the cause class', () => {
    class PostgresError extends Error {}
    const wrap = new TypeError('audit emit failed: a@b.example', { cause: new PostgresError('x') });
    expect(formatErrorClass(wrap)).toBe('TypeError(cause:PostgresError)');
  });

  it('a synthetic cause names its discriminator through a token-shaped name', () => {
    const synthetic = new Error('db_error: connection lost');
    synthetic.name = 'AuditEmitError';
    expect(formatErrorClass(new Error('wrap', { cause: synthetic }))).toBe('Error(cause:AuditEmitError)');
  });

  it('a name that is not a token falls back to the class', () => {
    const odd = new Error('x');
    odd.name = 'a@b.example';
    expect(formatErrorClass(odd)).toBe('Error');
  });

  it('a non-Error cause is dropped', () => {
    expect(formatErrorClass(new Error('wrap', { cause: 'a@b.example' }))).toBe('Error');
  });
});
