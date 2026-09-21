-- Dispensing (DSP, v0-08-dispensing.md).
--
-- Two of this module's rules cannot be checked row by row as it writes,
-- because the rows arrive in pieces: an item's batch lines are inserted
-- after the item, and a controlled drug's register entry after the
-- dispense. Both are therefore DEFERRED constraint triggers, checked at
-- commit — which is the only moment at which the question "is this
-- dispense complete and lawful?" has an answer.
--
-- Hand-written GIN indexes are stripped from the generated drop list;
-- raw-indexes.e2e asserts the survivors against the live database.
-- CreateEnum
CREATE TYPE "DispenseStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DispenseOutcome" AS ENUM ('DISPENSED', 'PARTIAL', 'EXTERNAL', 'DECLINED', 'SUBSTITUTED_OUT');

-- CreateEnum
CREATE TYPE "ControlledEntryType" AS ENUM ('RECEIVE', 'DISPENSE', 'ADJUST', 'RETURN', 'DESTROY');

-- CreateTable
CREATE TABLE "dispense" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "prescription_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "status" "DispenseStatus" NOT NULL DEFAULT 'OPEN',
    "opened_by" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_by" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "counselled" BOOLEAN,
    "counselled_by" UUID,
    "notes" VARCHAR(1000),
    "rx_version_seen" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dispense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispense_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "dispense_id" UUID NOT NULL,
    "prescription_item_id" UUID NOT NULL,
    "prescription_item_version" INTEGER NOT NULL,
    "product_id" UUID,
    "is_substitute" BOOLEAN NOT NULL DEFAULT false,
    "substitute_reason" VARCHAR(500),
    "original_product_id" UUID,
    "quantity" DECIMAL(10,3) NOT NULL,
    "quantity_unit" VARCHAR(20) NOT NULL,
    "pack_rounded" BOOLEAN NOT NULL DEFAULT false,
    "unit_price" BIGINT NOT NULL,
    "line_total" BIGINT NOT NULL,
    "outcome" "DispenseOutcome" NOT NULL,
    "outcome_reason" VARCHAR(500),
    "label_text" VARCHAR(600) NOT NULL,
    "label_prints" INTEGER NOT NULL DEFAULT 0,
    "counselled" BOOLEAN,
    "dispensed_by" UUID NOT NULL,
    "dispensed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by" UUID,
    "reversal_reason" VARCHAR(500),
    "returned_quantity" DECIMAL(10,3),
    "returned_at" TIMESTAMPTZ(3),
    "returned_by" UUID,
    "return_reason" VARCHAR(500),
    "idempotency_key" VARCHAR(80),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dispense_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispense_item_batch" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "dispense_item_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "was_suggested" BOOLEAN NOT NULL DEFAULT true,
    "override_reason" VARCHAR(500),
    "stock_movement_id" UUID NOT NULL,
    "reversal_movement_id" UUID,

    CONSTRAINT "dispense_item_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "controlled_drug_register" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "entry_type" "ControlledEntryType" NOT NULL,
    "reference_type" VARCHAR(40),
    "reference_id" UUID,
    "patient_id" UUID,
    "patient_name" VARCHAR(150),
    "patient_ic" VARCHAR(40),
    "prescriber_id" UUID,
    "prescriber_name" VARCHAR(150),
    "batch_id" UUID,
    "batch_no" VARCHAR(60),
    "quantity_in" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "quantity_out" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "balance_after" DECIMAL(12,3) NOT NULL,
    "performed_by" UUID NOT NULL,
    "performed_by_name" VARCHAR(150),
    "witness_id" UUID,
    "witness_name" VARCHAR(150),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "controlled_drug_register_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispense_queue_idx" ON "dispense"("tenant_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "dispense_prescription_idx" ON "dispense"("tenant_id", "prescription_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispense_id_tenant_key" ON "dispense"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "dispense_item_dispense_idx" ON "dispense_item"("tenant_id", "dispense_id");

-- CreateIndex
CREATE INDEX "dispense_item_rx_idx" ON "dispense_item"("tenant_id", "prescription_item_id");

-- CreateIndex
CREATE INDEX "dispense_item_product_idx" ON "dispense_item"("tenant_id", "product_id", "dispensed_at");

-- CreateIndex
CREATE UNIQUE INDEX "dispense_item_idempotency_key" ON "dispense_item"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "dispense_item_id_tenant_key" ON "dispense_item"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "dispense_item_batch_item_idx" ON "dispense_item_batch"("tenant_id", "dispense_item_id");

-- CreateIndex
CREATE INDEX "dispense_item_batch_batch_idx" ON "dispense_item_batch"("tenant_id", "batch_id");

-- CreateIndex
CREATE INDEX "controlled_register_idx" ON "controlled_drug_register"("tenant_id", "branch_id", "product_id", "occurred_at");

-- CreateIndex
CREATE INDEX "controlled_register_reference_idx" ON "controlled_drug_register"("reference_type", "reference_id");

-- AddForeignKey
ALTER TABLE "dispense" ADD CONSTRAINT "dispense_prescription_id_tenant_id_fkey" FOREIGN KEY ("prescription_id", "tenant_id") REFERENCES "prescription"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dispense" ADD CONSTRAINT "dispense_encounter_id_tenant_id_fkey" FOREIGN KEY ("encounter_id", "tenant_id") REFERENCES "encounter"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dispense_item" ADD CONSTRAINT "dispense_item_dispense_id_tenant_id_fkey" FOREIGN KEY ("dispense_id", "tenant_id") REFERENCES "dispense"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dispense_item_batch" ADD CONSTRAINT "dispense_item_batch_dispense_item_id_tenant_id_fkey" FOREIGN KEY ("dispense_item_id", "tenant_id") REFERENCES "dispense_item"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- --------------------------------------------------------------------------
-- Shape
-- --------------------------------------------------------------------------

ALTER TABLE "dispense_item" ADD CONSTRAINT "dispense_item_quantity_sign"
  CHECK (
    (outcome IN ('DISPENSED', 'PARTIAL') AND quantity > 0)
    OR
    (outcome IN ('EXTERNAL', 'DECLINED', 'SUBSTITUTED_OUT') AND quantity = 0)
  );

ALTER TABLE "dispense_item" ADD CONSTRAINT "dispense_item_money_not_negative"
  CHECK (unit_price >= 0 AND line_total >= 0);

-- Nothing is charged for what did not leave the shelf.
ALTER TABLE "dispense_item" ADD CONSTRAINT "dispense_item_nothing_billed_for_nothing"
  CHECK (quantity > 0 OR line_total = 0);

-- Something left the shelf, so something has to say what. The reverse is
-- allowed: an item the patient will fill elsewhere names no product of
-- ours, and hands over nothing.
ALTER TABLE "dispense_item" ADD CONSTRAINT "dispense_item_quantity_names_product"
  CHECK (quantity = 0 OR product_id IS NOT NULL);

ALTER TABLE "dispense_item" ADD CONSTRAINT "dispense_item_substitute_names_original"
  CHECK (is_substitute = false OR (original_product_id IS NOT NULL AND substitute_reason IS NOT NULL));

ALTER TABLE "dispense_item" ADD CONSTRAINT "dispense_item_reversal_has_reason"
  CHECK (reversed_at IS NULL OR (reversed_by IS NOT NULL AND reversal_reason IS NOT NULL));

ALTER TABLE "dispense_item_batch" ADD CONSTRAINT "dispense_item_batch_positive"
  CHECK (quantity > 0);

-- DSP-R-07: a batch chosen against the suggestion has to say why.
ALTER TABLE "dispense_item_batch" ADD CONSTRAINT "dispense_item_batch_override_has_reason"
  CHECK (was_suggested = true OR override_reason IS NOT NULL);

ALTER TABLE "controlled_drug_register" ADD CONSTRAINT "controlled_register_one_direction"
  CHECK (
    (quantity_in >= 0 AND quantity_out >= 0)
    AND NOT (quantity_in > 0 AND quantity_out > 0)
    AND (quantity_in > 0 OR quantity_out > 0)
  );

-- An inspector's first question is who it was given to.
ALTER TABLE "controlled_drug_register" ADD CONSTRAINT "controlled_register_dispense_names_patient"
  CHECK (entry_type <> 'DISPENSE' OR (patient_name IS NOT NULL AND patient_ic IS NOT NULL));

-- --------------------------------------------------------------------------
-- DSP-R-03: the batch lines add up to the item
--
-- Deferred, because they are inserted after the item they belong to. At
-- commit, an item that dispensed 15 must have batch lines totalling 15 —
-- otherwise the ledger and the label disagree about what the patient was
-- given, and there is no way to tell afterwards which is right.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispense_item_batches_add_up() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  item RECORD;
  total numeric(12,3);
BEGIN
  SELECT * INTO item FROM dispense_item WHERE id = COALESCE(NEW.id, OLD.id);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(quantity), 0) INTO total
    FROM dispense_item_batch WHERE dispense_item_id = item.id;

  IF item.quantity <> total THEN
    RAISE EXCEPTION
      'This dispense says % were handed over but its batches account for %. (DSP-R-03)',
      item.quantity, total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER dispense_item_batches_add_up_trigger
  AFTER INSERT OR UPDATE ON "dispense_item"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION dispense_item_batches_add_up();

-- --------------------------------------------------------------------------
-- DSP-R-08: a controlled drug leaves with a register entry, or it does
-- not leave
--
-- Also deferred: the register row is written after the dispense item.
-- This is the one rule in the module with a statute behind it, so it is
-- enforced where the application cannot get around it by accident.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispense_item_controlled_is_registered() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  controlled boolean;
  entries int;
BEGIN
  IF NEW.outcome NOT IN ('DISPENSED', 'PARTIAL') OR NEW.reversed_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.is_controlled INTO controlled FROM product p WHERE p.id = NEW.product_id;
  IF NOT COALESCE(controlled, false) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO entries
    FROM controlled_drug_register r
   WHERE r.reference_type = 'dispense_item' AND r.reference_id = NEW.id;

  IF entries = 0 THEN
    RAISE EXCEPTION
      'A controlled drug cannot be dispensed without an entry in the register (DSP-R-08).'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER dispense_item_controlled_is_registered_trigger
  AFTER INSERT OR UPDATE ON "dispense_item"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION dispense_item_controlled_is_registered();

-- --------------------------------------------------------------------------
-- The register is append-only
--
-- A register an inspector reads is worth nothing if last month's entries
-- can be tidied up. A wrong entry is corrected by another entry.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION controlled_register_append_only() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'The controlled drug register is append-only: % is not permitted. Post a correcting entry.',
    TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER controlled_register_no_update
  BEFORE UPDATE ON "controlled_drug_register"
  FOR EACH ROW EXECUTE FUNCTION controlled_register_append_only();

CREATE TRIGGER controlled_register_no_delete
  BEFORE DELETE ON "controlled_drug_register"
  FOR EACH ROW EXECUTE FUNCTION controlled_register_append_only();

-- --------------------------------------------------------------------------
-- A dispensed item records what happened, and stops changing
--
-- Only the columns that describe something happening *later* may move:
-- the reversal, the return, the label count and whether the patient was
-- counselled. What was handed over does not change.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispense_item_is_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.dispense_id            IS DISTINCT FROM OLD.dispense_id
     OR NEW.prescription_item_id      IS DISTINCT FROM OLD.prescription_item_id
     OR NEW.prescription_item_version IS DISTINCT FROM OLD.prescription_item_version
     OR NEW.product_id          IS DISTINCT FROM OLD.product_id
     OR NEW.is_substitute       IS DISTINCT FROM OLD.is_substitute
     OR NEW.substitute_reason   IS DISTINCT FROM OLD.substitute_reason
     OR NEW.original_product_id IS DISTINCT FROM OLD.original_product_id
     OR NEW.quantity            IS DISTINCT FROM OLD.quantity
     OR NEW.quantity_unit       IS DISTINCT FROM OLD.quantity_unit
     OR NEW.pack_rounded        IS DISTINCT FROM OLD.pack_rounded
     OR NEW.unit_price          IS DISTINCT FROM OLD.unit_price
     OR NEW.line_total          IS DISTINCT FROM OLD.line_total
     OR NEW.outcome             IS DISTINCT FROM OLD.outcome
     OR NEW.outcome_reason      IS DISTINCT FROM OLD.outcome_reason
     OR NEW.label_text          IS DISTINCT FROM OLD.label_text
     OR NEW.dispensed_by        IS DISTINCT FROM OLD.dispensed_by
     OR NEW.dispensed_at        IS DISTINCT FROM OLD.dispensed_at
     OR NEW.idempotency_key     IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at          IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'What was handed over cannot be changed. Undo it, or record a return.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER dispense_item_is_immutable_trigger
  BEFORE UPDATE ON "dispense_item"
  FOR EACH ROW EXECUTE FUNCTION dispense_item_is_immutable();

-- --------------------------------------------------------------------------
-- Row-level security (TEN-F-11)
-- --------------------------------------------------------------------------
ALTER TABLE "dispense" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispense" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dispense"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "dispense_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispense_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dispense_item"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "dispense_item_batch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispense_item_batch" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dispense_item_batch"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "controlled_drug_register" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "controlled_drug_register" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "controlled_drug_register"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
