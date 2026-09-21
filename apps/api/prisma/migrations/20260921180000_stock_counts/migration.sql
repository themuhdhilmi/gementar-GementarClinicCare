-- Stock counts and alerts (INV, the rest of v0-09-inventory.md).
--
-- A count is how the system finds out it was wrong. The expected
-- quantity is frozen before anybody starts counting, both numbers are
-- kept, and the difference is posted as an ordinary ledger movement
-- with the session as its reference — so a variance is readable a year
-- later and nothing is silently overwritten.
--
-- Hand-written GIN indexes are stripped from the generated drop list;
-- raw-indexes.e2e asserts the survivors against the live database.
-- CreateEnum
CREATE TYPE "StockCountType" AS ENUM ('OPENING', 'FULL', 'CYCLE', 'ADHOC');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockAlertKind" AS ENUM ('LOW', 'CRITICAL', 'EXPIRING_90', 'EXPIRING_60', 'EXPIRING_30', 'EXPIRED');

-- CreateTable
CREATE TABLE "stock_count" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "type" "StockCountType" NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'OPEN',
    "scope" JSONB,
    "blind" BOOLEAN NOT NULL DEFAULT false,
    "frozen_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_count_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "count_id" UUID NOT NULL,
    "batch_id" UUID,
    "product_id" UUID NOT NULL,
    "new_batch_no" VARCHAR(60),
    "new_expiry" DATE,
    "new_cost" BIGINT,
    "expected" DECIMAL(12,3),
    "counted" DECIMAL(12,3),
    "variance" DECIMAL(12,3),
    "counted_by" UUID,
    "counted_at" TIMESTAMPTZ(3),
    "note" VARCHAR(500),

    CONSTRAINT "stock_count_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_alert_state" (
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "kind" "StockAlertKind" NOT NULL,
    "first_seen" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observed" DECIMAL(12,3),
    "acknowledged_by" UUID,
    "acknowledged_at" TIMESTAMPTZ(3),

    CONSTRAINT "stock_alert_state_pkey" PRIMARY KEY ("branch_id","product_id","kind")
);

-- CreateIndex
CREATE INDEX "stock_count_branch_idx" ON "stock_count"("tenant_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_id_tenant_key" ON "stock_count"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "stock_count_line_count_idx" ON "stock_count_line"("tenant_id", "count_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_line_batch_key" ON "stock_count_line"("count_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_line_id_tenant_key" ON "stock_count_line"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "stock_alert_state_branch_idx" ON "stock_alert_state"("tenant_id", "branch_id", "kind");

-- AddForeignKey
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_count_id_tenant_id_fkey" FOREIGN KEY ("count_id", "tenant_id") REFERENCES "stock_count"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- --------------------------------------------------------------------------
-- Shape
-- --------------------------------------------------------------------------

-- A line names a batch the system knows, or describes one found on the
-- shelf that it does not. Never neither.
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_names_a_batch"
  CHECK (batch_id IS NOT NULL OR new_batch_no IS NOT NULL);

-- Nothing counts to less than nothing.
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_not_negative"
  CHECK ((expected IS NULL OR expected >= 0) AND (counted IS NULL OR counted >= 0));

-- The variance is the difference, and the database says so rather than
-- trusting whatever wrote the row.
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_variance_is_the_difference"
  CHECK (
    variance IS NULL
    OR counted IS NULL
    OR variance = counted - COALESCE(expected, 0)
  );

-- A session past OPEN has been frozen; one that was approved says by
-- whom and when.
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_frozen_when_started"
  CHECK (status = 'OPEN' OR frozen_at IS NOT NULL);

ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_approval_is_attributed"
  CHECK (status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL));

-- --------------------------------------------------------------------------
-- An approved count is history (INV-F-16)
--
-- Once the adjustments have been posted, the sheet that produced them
-- cannot be edited: it is the evidence for a set of ledger movements,
-- and evidence that can be rewritten afterwards is not evidence.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stock_count_approved_is_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'APPROVED' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'This count was approved on % and its adjustments have been posted. Start another count.',
    OLD.approved_at
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER stock_count_approved_is_immutable_trigger
  BEFORE UPDATE ON "stock_count"
  FOR EACH ROW EXECUTE FUNCTION stock_count_approved_is_immutable();

CREATE OR REPLACE FUNCTION stock_count_line_follows_count() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status::text INTO parent_status
    FROM stock_count WHERE id = COALESCE(NEW.count_id, OLD.count_id);

  IF parent_status IN ('APPROVED', 'CANCELLED') THEN
    RAISE EXCEPTION
      'This count is %; its lines cannot be changed.', lower(parent_status)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER stock_count_line_follows_count_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON "stock_count_line"
  FOR EACH ROW EXECUTE FUNCTION stock_count_line_follows_count();

-- --------------------------------------------------------------------------
-- One open count per branch
--
-- Two people counting the same shelves against two frozen snapshots
-- produce two different truths, and approving both applies the
-- difference twice.
-- --------------------------------------------------------------------------
CREATE UNIQUE INDEX stock_count_one_open_per_branch
  ON "stock_count" (branch_id)
  WHERE status IN ('OPEN', 'SUBMITTED');

-- --------------------------------------------------------------------------
-- Row-level security (TEN-F-11)
-- --------------------------------------------------------------------------
ALTER TABLE "stock_count" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_count" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_count"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "stock_count_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_count_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_count_line"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "stock_alert_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_alert_state" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_alert_state"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
