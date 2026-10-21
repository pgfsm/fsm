// Delay: 1000 — the `after: { 1000: … }` timer of spec011Parent. A numeric
// key is the delay itself, so the fsmlet doesn't call this; it returns the
// same value for anyone who does.
export function delay1000(_context: any, _event: any): number {
  return 1000;
}
