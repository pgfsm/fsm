// Delay: 2000 — the `after: { 2000: … }` timer of spec011Parent. A numeric
// key is the delay itself, so the fsmlet doesn't call this; it returns the
// same value for anyone who does.
export function delay2000(_context: any, _event: any): number {
  return 2000;
}
