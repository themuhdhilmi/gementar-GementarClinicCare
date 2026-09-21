-- Audit trail (AUD, v0-14-audit-trail.md): partition the log by month.
--
-- AUD-F-14 and §18 both say to do this before go-live, and they are right
-- for a reason worth writing down: converting a populated `audit_log`
-- means copying every row and holding an ACCESS EXCLUSIVE lock while it
-- happens. Today the table holds a few thousand rows of test traffic and
-- the conversion is instant. At five million it is an outage, and it is
-- an outage on the one table you cannot afford to lose.
--
-- The partition key is `occurred_at`, which forces it into the primary
-- key as well — Postgres requires the partition key in every unique
-- constraint. So the key becomes `(id, occurred_at)`. Nothing looks an
-- entry up by id alone; the log is read by time, by actor and by
-- patient, which is what the indexes are for.
--
-- There is a DEFAULT partition, deliberately. A write that finds no
-- partition for its month fails, and because an audit write shares the
-- transaction of the change it describes (AUD-R-02), a failed audit
-- write means a doctor cannot sign a note. A cron job that did not run
-- must not be able to stop the clinic. Rows landing in the default
-- partition are a loud problem — `AuditPartitionJob` reports them — and
-- not a lost one.

-- ------------------------------------------------------------------ out
-- The old table steps aside rather than being altered: a partitioned
-- table cannot be made from an ordinary one in place.
ALTER TABLE "audit_log" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" RENAME TO "audit_log_legacy";
ALTER TABLE "audit_log_legacy" RENAME CONSTRAINT "audit_log_pkey" TO "audit_log_legacy_pkey";
ALTER INDEX "audit_tenant_time_idx" RENAME TO "audit_legacy_tenant_time_idx";
ALTER INDEX "audit_tenant_actor_time_idx" RENAME TO "audit_legacy_tenant_actor_time_idx";
ALTER INDEX "audit_tenant_patient_time_idx" RENAME TO "audit_legacy_tenant_patient_time_idx";
ALTER INDEX "audit_tenant_entity_idx" RENAME TO "audit_legacy_tenant_entity_idx";
ALTER INDEX "audit_tenant_action_time_idx" RENAME TO "audit_legacy_tenant_action_time_idx";
DROP TRIGGER IF EXISTS "audit_log_no_update" ON "audit_log_legacy";
DROP TRIGGER IF EXISTS "audit_log_no_delete" ON "audit_log_legacy";

-- ------------------------------------------------------------------- in
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "actor_id" UUID,
    "actor_name" VARCHAR(120) NOT NULL,
    "actor_role" VARCHAR(40),
    "action" VARCHAR(80) NOT NULL,
    "entity_type" VARCHAR(60) NOT NULL,
    "entity_id" UUID,
    "subject_patient_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "diff" JSONB,
    "reason" VARCHAR(500),
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "request_id" VARCHAR(64),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id", "occurred_at")
) PARTITION BY RANGE ("occurred_at");

-- Declared on the parent, so every partition — including ones created
-- years from now by the maintenance job — inherits them automatically.
CREATE INDEX "audit_tenant_time_idx" ON "audit_log"("tenant_id", "occurred_at");
CREATE INDEX "audit_tenant_actor_time_idx" ON "audit_log"("tenant_id", "actor_id", "occurred_at");
CREATE INDEX "audit_tenant_patient_time_idx" ON "audit_log"("tenant_id", "subject_patient_id", "occurred_at");
CREATE INDEX "audit_tenant_entity_idx" ON "audit_log"("tenant_id", "entity_type", "entity_id");
CREATE INDEX "audit_tenant_action_time_idx" ON "audit_log"("tenant_id", "action", "occurred_at");

-- --------------------------------------------------------- partitioning
-- One function, used by this migration and by the nightly job, so there
-- is exactly one definition of what a month's partition looks like.
CREATE OR REPLACE FUNCTION audit_log_ensure_partition(month_start date)
  RETURNS text
  LANGUAGE plpgsql AS $$
DECLARE
  first_day date := date_trunc('month', month_start)::date;
  next_month date := (first_day + interval '1 month')::date;
  part_name text := 'audit_log_' || to_char(first_day, 'YYYY_MM');
BEGIN
  IF to_regclass(format('public.%I', part_name)) IS NOT NULL THEN
    RETURN part_name;
  END IF;
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF "audit_log" FOR VALUES FROM (%L) TO (%L)',
    part_name, first_day, next_month
  );
  -- A partition reached directly bypasses the parent's policies, so each
  -- one carries its own. Nothing in the application does that; a restore
  -- script or a curious psql session might.
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part_name);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
    part_name
  );
  RETURN part_name;
END;
$$;

-- The month this is deployed, the one before it for anything in flight,
-- and three ahead so a maintenance job that fails silently has a quarter
-- to be noticed in.
SELECT audit_log_ensure_partition((date_trunc('month', now()) - interval '1 month')::date);
SELECT audit_log_ensure_partition(date_trunc('month', now())::date);
SELECT audit_log_ensure_partition((date_trunc('month', now()) + interval '1 month')::date);
SELECT audit_log_ensure_partition((date_trunc('month', now()) + interval '2 month')::date);
SELECT audit_log_ensure_partition((date_trunc('month', now()) + interval '3 month')::date);

CREATE TABLE "audit_log_unclaimed" PARTITION OF "audit_log" DEFAULT;
ALTER TABLE "audit_log_unclaimed" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log_unclaimed" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_log_unclaimed"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ----------------------------------------------------------- carry over
INSERT INTO "audit_log" (
  id, tenant_id, branch_id, actor_id, actor_name, actor_role, action,
  entity_type, entity_id, subject_patient_id, before, after, diff, reason,
  ip, user_agent, request_id, occurred_at
)
SELECT
  id, tenant_id, branch_id, actor_id, actor_name, actor_role, action,
  entity_type, entity_id, subject_patient_id, before, after, diff, reason,
  ip, user_agent, request_id, occurred_at
FROM "audit_log_legacy";

DROP TABLE "audit_log_legacy";

-- ------------------------------------------------------------ and final
-- AUD-R-01 again, on the parent. BEFORE ROW triggers on a partitioned
-- table have worked since Postgres 13 and fire for writes through the
-- parent and directly against a partition alike.
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_log"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
