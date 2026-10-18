/**
 * `playwright.config.ts` loads `.env.local` with its own minimal parser (no
 * dotenv dependency). In CI that file is a copy of `.env.example`, whose lines
 * carry inline comments (`CLAMAV_TIMEOUT_MS="300000"   # 5-minute …`); the old
 * parser kept the comment in the value, env validation read NaN, and every
 * spec that imports `@/lib/db` failed collection (e2e-critical run
 * 39096465335, 0 tests). Developers' `vercel env pull` files have no inline
 * comments, so it never showed locally.
 */
import { describe, expect, it } from 'vitest';
import { parseEnvLine } from '../../e2e/helpers/parse-env-line';

describe('parseEnvLine', () => {
  it('takes a double-quoted value and ignores an inline comment after the closing quote', () => {
    expect(parseEnvLine('CLAMAV_TIMEOUT_MS="300000"           # 5-minute scan timeout per FR-013')).toEqual({
      key: 'CLAMAV_TIMEOUT_MS',
      value: '300000',
    });
  });

  it('takes a single-quoted value and ignores an inline comment', () => {
    expect(parseEnvLine("APP_NAME='Chamber OS' # display name")).toEqual({ key: 'APP_NAME', value: 'Chamber OS' });
  });

  it('strips a whitespace-preceded # comment from an unquoted value', () => {
    expect(parseEnvLine('CLAMAV_PORT=3310   # default port')).toEqual({ key: 'CLAMAV_PORT', value: '3310' });
  });

  it('keeps a # inside quotes, and a # with no whitespace before it in an unquoted value', () => {
    expect(parseEnvLine('SECRET="abc#def # not a comment" # comment')).toEqual({
      key: 'SECRET',
      value: 'abc#def # not a comment',
    });
    expect(parseEnvLine('COLOR=#fff')).toEqual({ key: 'COLOR', value: '#fff' });
    expect(parseEnvLine('ANCHOR=a#b')).toEqual({ key: 'ANCHOR', value: 'a#b' });
  });

  it('keeps = inside the value', () => {
    expect(parseEnvLine('DATABASE_URL=postgres://u:p@h/db?sslmode=require&x=1')).toEqual({
      key: 'DATABASE_URL',
      value: 'postgres://u:p@h/db?sslmode=require&x=1',
    });
    expect(parseEnvLine('TOKEN="a=b=c"')).toEqual({ key: 'TOKEN', value: 'a=b=c' });
  });

  it('skips blank lines, comment lines and lines that are not KEY=VALUE', () => {
    expect(parseEnvLine('')).toBeNull();
    expect(parseEnvLine('   ')).toBeNull();
    expect(parseEnvLine('# CLAMAV_HOST=localhost')).toBeNull();
    expect(parseEnvLine('   # indented comment')).toBeNull();
    expect(parseEnvLine('not a pair')).toBeNull();
  });

  it('accepts an `export ` prefix, surrounding whitespace and a CRLF remainder', () => {
    expect(parseEnvLine('export FOO=bar')).toEqual({ key: 'FOO', value: 'bar' });
    expect(parseEnvLine('  FOO = "bar"  \r')).toEqual({ key: 'FOO', value: 'bar' });
  });

  it('reads an empty value as the empty string', () => {
    expect(parseEnvLine('CLAMAV_HOST=""                       # e.g. "clamav.internal"')).toEqual({
      key: 'CLAMAV_HOST',
      value: '',
    });
    expect(parseEnvLine('EMPTY=')).toEqual({ key: 'EMPTY', value: '' });
    expect(parseEnvLine('KEY=   # c')).toEqual({ key: 'KEY', value: '' });
  });
});
