/**
 * Kal — the journal session LWW comparator (w3 contract §1.4, inherited
 * verbatim by the w4 contract §1; frozen).
 *
 * Per entity (user_id + kind + entityId): the winner is the op with the
 * HIGHER `clientUpdatedAt`; on equal timestamps the HIGHER `opId`
 * (lexicographic, UUID string compare) wins. `(clientUpdatedAt, opId)` is a
 * total order, so convergence is deterministic across devices with no third
 * state and no duplication. Rows store the winning op's `clientUpdatedAt`
 * as `updated_at` and its `opId` as `last_op_id` (the comparator).
 *
 * Deletes are NOT arbitrated here: per contract §1.3 a delete on an active
 * row applies unconditionally (tombstones win over stale ops — §1.5), and
 * an update never undeletes.
 *
 * Journal-owned transcription of the frozen diary comparator
 * (`diary-lww.ts`) — the W3 two-copies precedent for frozen pure helpers;
 * the journal module never source-imports tracking's internals.
 */

/** True when the incoming op strictly beats the stored row (a loser changes nothing but is still acked `applied`). */
export function opWinsSessionLww(
  op: { readonly clientUpdatedAt: Date; readonly opId: string },
  row: { readonly updatedAt: Date; readonly lastOpId: string | null },
): boolean {
  if (row.lastOpId === null) {
    // No comparator exists on the row. Journal sessions have NO REST create
    // path (the §2 freeze — every row is op-created and carries last_op_id),
    // so this is defensive parity with the frozen diary comparator: any
    // sync op wins.
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
