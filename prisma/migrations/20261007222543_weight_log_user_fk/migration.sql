-- AddForeignKey
ALTER TABLE "weight_log" ADD CONSTRAINT "weight_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- W3 Stage-1 carryover (G2 evidence §6-E; wave-02 contract §5 recorded the
-- deferral). The W1 pilot table shipped without a user FK because no consumer
-- table existed yet; the identity wave owns the decision recorded here:
-- a PLAIN FK suffices — weight_log is an owned ROOT table with no children,
-- so the compound (id, user_id) reference pattern has no structural target
-- ("compound per I3 where sensible" — here: not sensible, nothing references
-- weight logs). ON DELETE RESTRICT keeps account deletion an explicit
-- platform job that removes children itself. The RLS policy and column
-- grants are UNAFFECTED (the policy expression references the user_id
-- column, which the FK does not touch). Dev `kal` was reset with empty
-- `users` and zero weight_log rows, so validation over existing rows is a
-- no-op; ephemeral harness databases apply the full history cold.
