/**
 * T034 — Session TTL edge cases for `isSessionValid`.
 *
 * The two TTLs (idle 30 min, absolute 12 h) interact at the boundaries.
 * This file pins the behaviour for every "almost-expired" condition so
 * that a future refactor can't accidentally extend a session past either
 * cap.
 */
import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_LIFETIME_MS,
  IDLE_TIMEOUT_MS,
  isSessionValid,
  nextExpiryAt,
  type Session,
} from '@/modules/auth/domain/session';
import { asSessionToken, asUserId } from '@/modules/auth/domain/branded';

const userId = asUserId('00000000-0000-0000-0000-000000000001');
const sessionId = asSessionToken('a'.repeat(64));

function makeSession(overrides: Partial<Session> = {}): Session {
  const created = new Date('2026-04-09T12:00:00.000Z');
  return {
    id: sessionId,
    userId,
    createdAt: created,
    lastSeenAt: created,
    expiresAt: new Date(created.getTime() + ABSOLUTE_LIFETIME_MS),
    sourceIp: '127.0.0.1',
    ...overrides,
  };
}

describe('isSessionValid', () => {
  it('a brand-new session is valid', () => {
    const session = makeSession();
    expect(isSessionValid(session, session.createdAt)).toBe(true);
  });

  it('valid 1ms before idle cap', () => {
    const session = makeSession();
    const now = new Date(session.lastSeenAt.getTime() + IDLE_TIMEOUT_MS);
    expect(isSessionValid(session, now)).toBe(true);
  });

  it('invalid 1ms after idle cap', () => {
    const session = makeSession();
    const now = new Date(session.lastSeenAt.getTime() + IDLE_TIMEOUT_MS + 1);
    expect(isSessionValid(session, now)).toBe(false);
  });

  it('valid just before absolute cap (with active heartbeat)', () => {
    const session = makeSession({
      // simulate a session that has been heart-beat regularly
      lastSeenAt: new Date('2026-04-09T23:55:00.000Z'),
    });
    const now = new Date(session.expiresAt.getTime() - 1);
    expect(isSessionValid(session, now)).toBe(true);
  });

  it('invalid exactly at absolute cap', () => {
    const session = makeSession({
      lastSeenAt: new Date('2026-04-09T23:55:00.000Z'),
    });
    const now = session.expiresAt;
    expect(isSessionValid(session, now)).toBe(false);
  });

  it('invalid past absolute cap even if recently heart-beat', () => {
    const session = makeSession({
      lastSeenAt: new Date('2026-04-10T00:30:00.000Z'),
    });
    const now = new Date(session.expiresAt.getTime() + 1);
    expect(isSessionValid(session, now)).toBe(false);
  });
});

describe('nextExpiryAt', () => {
  it('returns the idle expiry when it is sooner than the absolute cap', () => {
    const session = makeSession();
    const expected = new Date(session.lastSeenAt.getTime() + IDLE_TIMEOUT_MS);
    expect(nextExpiryAt(session)).toEqual(expected);
  });

  it('returns the absolute cap when the idle window extends beyond it', () => {
    // Heart-beat at 11:50 of the 12-hour window — idle expiry would be
    // 12:20, but absolute expiry is at 12:00. Absolute should win.
    const created = new Date('2026-04-09T00:00:00.000Z');
    const session = makeSession({
      createdAt: created,
      lastSeenAt: new Date('2026-04-09T11:50:00.000Z'),
      expiresAt: new Date(created.getTime() + ABSOLUTE_LIFETIME_MS),
    });
    expect(nextExpiryAt(session)).toEqual(session.expiresAt);
  });
});
