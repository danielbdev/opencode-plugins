/**
 * Gate for the settled-turn resync.
 *
 * A turn that settled is when usage actually moves, so it is the signal worth
 * re-reading on. The endpoint is undocumented and reports only three windows, so
 * the read is gated rather than free: `allow()` returns true at most once per
 * `minMs` and false for every turn in between.
 *
 * It lives here, next to the model, so the gate is testable without a host. The
 * clock is injectable for the same reason.
 */
export function createResyncGate(minMs: number, now: () => number = Date.now): () => boolean {
  let lastAllowed = Number.NEGATIVE_INFINITY

  return () => {
    const at = now()
    if (at - lastAllowed < minMs) return false
    lastAllowed = at
    return true
  }
}
