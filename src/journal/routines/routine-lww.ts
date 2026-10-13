/**
 * Kal — the LWW comparator for journal client entities (wave-04; the frozen
 * wave-03 §1.4 comparator inherited verbatim — transcription pin of
 * `src/tracking/diary/diary-lww.ts`; module gates keep the journal module
 * self-contained, and the comparator is two lines of frozen arithmetic).
 *
 * Per entity (user_id + kind + entityId): the winner is the op with the
 * HIGHER `clientUpdatedAt`; on equal timestamps the HIGHER `opId`
 * (lexicographic, UUID string compare) wins. `(clientUpdatedAt, opId)` is a
 * total order, so convergence is deterministic across devices with no third
 * state and no duplication.
 *
 * Deletes are NOT arbitrated here: per contract §1.3 a delete on an active
 * row applies unconditionally (tombstones win over stale ops — §1.5), and
 * an update never undeletes. Journal rows are sync-created only (no REST
 * mutation surface exists in w4), so `last_op_id` is never NULL on a live
 * row; the NULL branch is kept for parity with the frozen comparator and
 * fail-closed semantics (a comparator-less row loses to ANY sync op).
 */

/** True when the incoming op strictly beats the stored row (a loser changes nothing but is still acked `applied`). */
export function opWinsLww(
  op: { readonly clientUpdatedAt: Date; readonly opId: string },
  row: { readonly updatedAt: Date; readonly lastOpId: string | null },
): boolean {
  if (row.lastOpId === null) {
    // Comparator-less row: any sync op wins (§1.4 — parity with the frozen comparator).
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
