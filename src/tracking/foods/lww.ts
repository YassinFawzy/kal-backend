/**
 * Kal — the LWW comparator (wave-03 contract §1.4, frozen).
 *
 * Per entity (user_id + kind + entityId) the winner is the op with the higher
 * `clientUpdatedAt`; on equal timestamps the higher `opId` (lexicographic UUID
 * string compare) wins — `(clientUpdatedAt, opId)` is a total order, so
 * convergence is deterministic across devices with no third state. Rows store
 * the winning op's `clientUpdatedAt` as `updated_at` and its `opId` as
 * `last_op_id`. REST-created rows (`last_op_id NULL`) lose to ANY sync op.
 *
 * Equal `(clientUpdatedAt, opId)` (the same op re-applied under batch retry)
 * never wins a second time — replay safety without relying on dedupe (I9).
 * Instants compare at millisecond precision on both sides (ISO instants in,
 * millisecond-truncated instants stored).
 *
 * REST-created rows (`last_op_id NULL`, user foods only): the contract is
 * unconditional — "any sync op then wins" (§1.4); the row has no op id to
 * tiebreak against, so the op applies regardless of the server-authored
 * create instant (a client can only have learned the id AFTER the create —
 * it is server-generated — so its edit is naturally newer).
 */
export function lwwOpWins(opUpdatedAtMs: number, opId: string, rowUpdatedAt: Date, rowLastOpId: string | null): boolean {
  if (rowLastOpId === null) {
    return true; // REST-created row (user foods only): any sync op wins (§1.4)
  }
  const rowMs = rowUpdatedAt.getTime();
  if (opUpdatedAtMs !== rowMs) {
    return opUpdatedAtMs > rowMs;
  }
  return opId > rowLastOpId;
}
