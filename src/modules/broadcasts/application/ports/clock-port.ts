/**
 * T028 — `ClockPort` Application port (F7).
 *
 * Time retrieval abstraction. Mirrors F4/F5 minimal interface so use
 * cases can be deterministic in tests (inject a `FakeClock` returning
 * a fixed instant) AND production-correct (inject a `SystemClock`
 * returning `new Date()`).
 *
 * `@js-joda/timezone` for Asia/Bangkok fiscal-year boundary math is
 * imported directly at use-case sites where needed (e.g.,
 * `compute-quota-counter.ts` for FR-006/007 quota year resolution).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export interface ClockPort {
  /** Wall-clock time as a JS Date in the system's UTC offset. */
  now(): Date;
}
