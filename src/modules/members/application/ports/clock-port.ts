/**
 * Application port — deterministic time source.
 *
 * Every use case receives a Clock instead of calling `new Date()` directly
 * so unit tests can inject a fixed instant. Production adapter returns
 * `new Date()`; the test fixture returns a frozen date.
 */
export interface ClockPort {
  now(): Date;
}
