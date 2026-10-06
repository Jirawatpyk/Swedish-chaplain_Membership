/**
 * Optional step timer a caller can hand to a use-case to learn where a
 * request's time goes (the admin pay route renders it as a `Server-Timing`
 * header). Pure observation: `time` must run `fn` and return its result or
 * rethrow its error unchanged. Absent → the use-case runs untimed.
 */
export interface StepTimerPort {
  time<T>(step: string, fn: () => Promise<T>): Promise<T>;
}
