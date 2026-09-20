-- Stock ledger (INV, the second half of v0-09-inventory.md).
--
-- The whole module rests on one invariant: a batch's quantity_on_hand is
-- the sum of its movements. Everything below exists to make that true and
-- to make it stay true — a single write path, an append-only ledger, a
-- non-negative constraint the database enforces rather than the service,
-- and a nightly job that recomputes the sum and tells somebody.
--
-- `prisma migrate diff` cannot see a GIN index, so it proposes dropping
-- every hand-written one. Those drops are stripped here; raw-indexes.e2e
-- asserts the survivors against the live database.
-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('ACTIVE', 'DEPLETED', 'EXPIRED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('OPENING', 'RECEIVE', 'DISPENSE', 'DISPENSE_REVERSAL', 'CONSUME', 'CONSUME_REVERSAL', 'ADJUST_IN', 'ADJUST_OUT', 'DAMAGE', 'EXPIRE', 'RETURN_TO_SUPPLIER', 'RETURN_FROM_PATIENT', 'QUARANTINE_IN', 'QUARANTINE_OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'COUNT_ADJUST');

-- CreateTable
CREATE TABLE "product_batch" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_no" VARCHAR(60) NOT NULL,
    "expiry_date" DATE,
    "cost_price" BIGINT NOT NULL DEFAULT 0,
    "selling_price" BIGINT,
    "quantity_on_hand" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "quantity_quarantined" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_type" VARCHAR(20),
    "source_id" UUID,
    "barcode" VARCHAR(60),
    "status" "BatchStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_cost" BIGINT NOT NULL DEFAULT 0,
    "balance_after" DECIMAL(12,3) NOT NULL,
    "reference_type" VARCHAR(40),
    "reference_id" UUID,
    "reason_code" VARCHAR(40),
    "reason_text" VARCHAR(500),
    "performed_by" UUID,
    "performed_by_name" VARCHAR(120),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_run" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "batches_checked" INTEGER NOT NULL DEFAULT 0,
    "mismatches" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "reconciliation_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_batch_fefo_idx" ON "product_batch"("branch_id", "product_id", "expiry_date");

-- CreateIndex
CREATE INDEX "product_batch_branch_idx" ON "product_batch"("tenant_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "product_batch_expiry_idx" ON "product_batch"("tenant_id", "expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "product_batch_key" ON "product_batch"("branch_id", "product_id", "batch_no");

-- CreateIndex
CREATE UNIQUE INDEX "product_batch_id_tenant_key" ON "product_batch"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "stock_movement_batch_idx" ON "stock_movement"("tenant_id", "batch_id", "occurred_at");

-- CreateIndex
CREATE INDEX "stock_movement_product_idx" ON "stock_movement"("tenant_id", "branch_id", "product_id", "occurred_at");

-- CreateIndex
CREATE INDEX "stock_movement_type_idx" ON "stock_movement"("tenant_id", "type", "occurred_at");

-- CreateIndex
CREATE INDEX "stock_movement_reference_idx" ON "stock_movement"("reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movement_id_tenant_key" ON "stock_movement"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "reconciliation_run_idx" ON "reconciliation_run"("tenant_id", "run_at");

-- AddForeignKey
ALTER TABLE "product_batch" ADD CONSTRAINT "product_batch_product_id_tenant_id_fkey" FOREIGN KEY ("product_id", "tenant_id") REFERENCES "product"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_batch" ADD CONSTRAINT "product_batch_branch_id_tenant_id_fkey" FOREIGN KEY ("branch_id", "tenant_id") REFERENCES "branch"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_batch_id_tenant_id_fkey" FOREIGN KEY ("batch_id", "tenant_id") REFERENCES "product_batch"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- --------------------------------------------------------------------------
-- Stock cannot go negative (INV-R-04)
--
-- A service check is not enough: it races with itself, and it is one
-- refactor away from being skipped. The constraint holds whatever runs.
-- --------------------------------------------------------------------------
ALTER TABLE "product_batch" ADD CONSTRAINT "product_batch_not_negative"
  CHECK (quantity_on_hand >= 0 AND quantity_quarantined >= 0);

-- A movement of nothing is not a movement.
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_not_zero"
  CHECK (quantity <> 0);

ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_balance_not_negative"
  CHECK (balance_after >= 0);

-- A batch of something that is tracked by lot has to say which lot, and
-- when it goes off. The synthetic 'NB' batch is the exception, and it is
-- the only one.
ALTER TABLE "product_batch" ADD CONSTRAINT "product_batch_has_expiry"
  CHECK (batch_no = 'NB' OR expiry_date IS NOT NULL);

-- --------------------------------------------------------------------------
-- The ledger is append-only (INV-R-06)
--
-- A stock movement is an assertion that something physically happened.
-- Editing one is rewriting history; deleting one breaks the invariant
-- silently, because quantity_on_hand would no longer match the sum.
-- The correction for a wrong movement is another movement.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stock_movement_append_only() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'stock_movement is append-only: % is not permitted. Post a correcting movement instead.',
    TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER stock_movement_no_update
  BEFORE UPDATE ON "stock_movement"
  FOR EACH ROW EXECUTE FUNCTION stock_movement_append_only();

CREATE TRIGGER stock_movement_no_delete
  BEFORE DELETE ON "stock_movement"
  FOR EACH ROW EXECUTE FUNCTION stock_movement_append_only();

-- --------------------------------------------------------------------------
-- A batch's status follows its quantity (INV §6)
--
-- Derived rather than set, because a status somebody has to remember to
-- update is a status that drifts. BLOCKED is the exception: it is a human
-- decision (a recall), so it is never overwritten here.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION product_batch_derive_status() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'BLOCKED' THEN
    RETURN NEW;
  END IF;

  IF NEW.expiry_date IS NOT NULL AND NEW.expiry_date < CURRENT_DATE THEN
    NEW.status := 'EXPIRED';
  ELSIF NEW.quantity_on_hand = 0 AND NEW.quantity_quarantined = 0 THEN
    NEW.status := 'DEPLETED';
  ELSE
    NEW.status := 'ACTIVE';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER product_batch_derive_status_trigger
  BEFORE INSERT OR UPDATE OF quantity_on_hand, quantity_quarantined, expiry_date ON "product_batch"
  FOR EACH ROW EXECUTE FUNCTION product_batch_derive_status();

-- --------------------------------------------------------------------------
-- Row-level security (TEN-F-11)
-- --------------------------------------------------------------------------
ALTER TABLE "product_batch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_batch" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product_batch"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "stock_movement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movement" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_movement"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "reconciliation_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reconciliation_run" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reconciliation_run"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
