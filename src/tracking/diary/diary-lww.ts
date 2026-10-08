/**
 * Kal — the LWW comparator (wave-03 contract §1.4, frozen).
 *
 * Per entity (user_id + kind + entityId): the winner is the op with the
 * HIGHER `clientUpdatedAt`; on equal timestamps the HIGHER `opId`
 * (lexicographic, UUID string compare) wins. `(clientUpdatedAt, opId)` is a
 * total order, so convergence is deterministic across devices with no third
 * state and no duplication (PRD §23.1 recovery criterion). Rows store the
 * winning op's `clientUpdatedAt` as `updated_at` and its `opId` as
 * `last_op_id` (the comparator). Rows with a NULL `last_op_id` (REST-created
 * rows — user foods only) lose to ANY sync op.
 *
 * Deletes are NOT arbitrated here: per contract §1.3 a delete on an active
 * row applies unconditionally (tombstones win over stale ops — §1.5), and
 * an update never undeletes.
 */

/** True when the incoming op strictly beats the stored row (a loser changes nothing but is still acked `applied`). */
export function opWinsLww(op: { readonly clientUpdatedAt: Date; readonly opId: string }, row: { readonly updatedAt: Date; readonly lastOpId: string | null }): boolean {
  if (row.lastOpId === null) {
    // REST-created row (user foods only): no comparator exists — any sync op wins (§1.4).
    return true;
  }
  const opMs = op.clientUpdatedAt.getTime();
  const rowMs = row.updatedAt.getTime();
  if (opMs !== rowMs) {
    return opMs > rowMs;
  }
  // Deterministic total order: lexicographic UUID string compare (higher wins).
  return op.opId > row.lastOpId;
}
