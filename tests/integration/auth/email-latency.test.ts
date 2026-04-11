/**
 * T191 — Email delivery latency budget test (spec SC-002).
 *
 * Spec SC-002 requires that 99% of password-reset emails arrive within
 * 60 seconds of the request. That 60-second budget is a PIPELINE budget:
 *
 *       [our application layer] → [Resend] → [recipient MTA]
 *         ~50 ms                   ~100 ms     ~seconds
 *
 * The only part we can hold our code accountable for is the first hop
 * — the application-layer latency from "user clicks forgot password"
 * to "email handed off to Resend + audit row committed + token row
 * committed". If our code is fast (< 500 ms per request), the 60-second
 * end-to-end budget is not our fault when it's blown: it's Resend, or
 * the recipient's spam filter, or SMTP backpressure.
 *
 * This test therefore uses a STUB email sender that returns immediately
 * and asserts:
 *
 *   1. The application-layer latency of the full `forgotPassword` use
 *      case (rate-limit check + user lookup + token insert + audit
 *      insert + email send + optional second audit) is < 500 ms for
 *      99% of a 100-request sample.
 *   2. No request throws or returns anything other than ok.
 *
 * The end-to-end 60-second SLO is then observable at runtime via the
 * `auth_email_send_duration_seconds` OTel histogram (T180), which is
 * where we catch Resend regressions in production. Staging-environment
 * verification (T187) runs a manual 10-email dispatch against live
 * Resend and reads Resend's own delivery dashboard — that's the test
 * that actually hits the pipeline.
 *
 * This integration test is the last line of defence: if someone later
 * adds a 500 ms sleep to `forgotPassword` in a misguided "make it feel
 * deliberate" refactor, this test fails before the SLO does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  forgotPassword,
  type ForgotPasswordDeps,
  defaultForgotPasswordDeps,
} from '@/modules/auth/application/forgot-password';
import type { EmailMessage, EmailSender } from '@/modules/auth/infrastructure/email/resend-client';
import { Result, ok } from '@/lib/result';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { Redis } from '@upstash/redis';
import { env } from '@/lib/env';

const SAMPLE_SIZE = 100;
/** 99% of requests must finish within this budget. */
const P99_BUDGET_MS = 500;
/** No single request may exceed this hard cap. */
const HARD_CAP_MS = 2_000;

class InstantEmailSender implements EmailSender {
  sendCount = 0;
  async send(
    message: EmailMessage,
  ): Promise<Result<{ messageId: string }, never>> {
    void message;
    this.sendCount += 1;
    // Immediately "accept" the handoff — Resend's real acceptance takes
    // ~20-100 ms, but we're measuring OUR code, not Resend.
    return ok({ messageId: `stub-${this.sendCount}` });
  }
}

async function clearSwechamKeys(): Promise<void> {
  const redis = new Redis({ url: env.upstash.url, token: env.upstash.token });
  let cursor = '0';
  do {
    const [nextCursor, keys] = (await redis.scan(cursor, {
      match: 'swecham*',
      count: 200,
    })) as [string, string[]];
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');
}

describe('integration: email delivery latency budget (T191, SC-002)', () => {
  // Pool of test users so we don't trip the 3/h per-email rate limit
  const users: TestUser[] = [];
  let stubSender: InstantEmailSender;
  let deps: ForgotPasswordDeps;

  beforeAll(async () => {
    await clearSwechamKeys();
    // Create SAMPLE_SIZE / 3 users (each can receive up to 3 resets per
    // hour). With 34 users we get 102 slots, plenty of headroom.
    const userCount = Math.ceil(SAMPLE_SIZE / 3);
    for (let i = 0; i < userCount; i += 1) {
      users.push(await createActiveTestUser('member'));
    }
    stubSender = new InstantEmailSender();
    deps = {
      ...defaultForgotPasswordDeps,
      email: stubSender,
    };
  }, 120_000);

  afterAll(async () => {
    await Promise.all(users.map((u) => deleteTestUser(u)));
    await clearSwechamKeys();
  });

  it(
    `forgotPassword completes under ${P99_BUDGET_MS}ms at p99 across ${SAMPLE_SIZE} requests`,
    async () => {
      const latencies: number[] = [];

      for (let i = 0; i < SAMPLE_SIZE; i += 1) {
        const user = users[i % users.length]!;
        // Use a unique source IP per request so the IP rate limit
        // (10/h per IP) does not trip.
        const sourceIp = `203.0.113.${(i % 250) + 1}`;

        const start = performance.now();
        const result = await forgotPassword(
          {
            email: user.rawEmail,
            sourceIp,
            requestId: `latency-${i}`,
          },
          deps,
        );
        const elapsed = performance.now() - start;

        expect(result.ok).toBe(true);
        expect(elapsed).toBeLessThan(HARD_CAP_MS);
        latencies.push(elapsed);
      }

      const sorted = [...latencies].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
      const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
      const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
      const max = sorted[sorted.length - 1]!;

      console.log(
        `  email-latency: n=${SAMPLE_SIZE}  p50=${p50.toFixed(0)}ms  ` +
          `p95=${p95.toFixed(0)}ms  p99=${p99.toFixed(0)}ms  max=${max.toFixed(0)}ms`,
      );

      expect(p99).toBeLessThan(P99_BUDGET_MS);
      // Sanity: the stub actually got called the expected number of times
      expect(stubSender.sendCount).toBe(SAMPLE_SIZE);
    },
    180_000,
  );
});
