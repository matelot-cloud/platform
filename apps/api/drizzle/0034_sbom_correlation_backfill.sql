-- SBOMs stored before correlation tracking (or correlated under the old flow and left 'pending' because they have no
-- findings) must not make gates wait: anything older than the rollout is done.
UPDATE "sboms" SET "correlation_status" = 'done', "correlated_at" = coalesce("correlated_at", "created_at") WHERE "correlation_status" = 'pending' AND "created_at" < now() - interval '10 minutes';
