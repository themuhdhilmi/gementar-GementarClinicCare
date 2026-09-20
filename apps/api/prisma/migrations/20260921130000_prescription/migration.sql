-- Prescription (RX, v0-07-prescription.md).
--
-- Prescribing is the clinical decision. Dispensing is the physical act.
-- They are separate tables because they are separate facts, and they
-- disagree often enough that merging them loses both: the patient declines
-- one item, the pharmacy substitutes another, the quantity handed over is
-- a whole bottle rather than the 37 ml calculated.
--
-- Nothing here moves stock. Stock moves when something leaves the shelf,
-- which is DSP's job (RX-R-01).
-- CreateEnum
CREATE TYPE "PrescriptionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PrescriptionItemStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PARTIAL', 'DISPENSED', 'DECLINED', 'CANCELLED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "prescription" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "consultation_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "prescribed_by" UUID NOT NULL,
    "status" "PrescriptionStatus" NOT NULL DEFAULT 'DRAFT',
    "language" CHAR(2) NOT NULL DEFAULT 'MS',
    "notes_to_dispenser" VARCHAR(1000),
    "signed_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "prescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "prescription_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedes_id" UUID,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "product_id" UUID,
    "external_name" VARCHAR(200),
    "generic_name" VARCHAR(200) NOT NULL,
    "drug_class" VARCHAR(120),
    "strength" VARCHAR(60),
    "display_name" VARCHAR(200) NOT NULL,
    "dose_value" DECIMAL(10,3) NOT NULL,
    "dose_unit" VARCHAR(20) NOT NULL,
    "route" VARCHAR(20) NOT NULL,
    "frequency_code" VARCHAR(20) NOT NULL,
    "frequency_per_day" DECIMAL(6,3),
    "is_prn" BOOLEAN NOT NULL DEFAULT false,
    "prn_indication" VARCHAR(200),
    "duration_days" INTEGER,
    "until_finished" BOOLEAN NOT NULL DEFAULT false,
    "quantity" DECIMAL(10,3) NOT NULL,
    "quantity_unit" VARCHAR(20) NOT NULL,
    "quantity_auto" BOOLEAN NOT NULL DEFAULT true,
    "instructions" VARCHAR(500),
    "label_text" VARCHAR(600) NOT NULL,
    "is_external" BOOLEAN NOT NULL DEFAULT false,
    "is_controlled" BOOLEAN NOT NULL DEFAULT false,
    "status" "PrescriptionItemStatus" NOT NULL DEFAULT 'DRAFT',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "override_reason" VARCHAR(500),
    "overridden_by" UUID,
    "overridden_at" TIMESTAMPTZ(3),
    "override_confirmed_at" TIMESTAMPTZ(3),
    "cancelled_reason" VARCHAR(500),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "prescription_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rx_favourite" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "defaults" JSONB,
    "uses" INTEGER NOT NULL DEFAULT 1,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rx_favourite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prescription_patient_idx" ON "prescription"("tenant_id", "patient_id", "signed_at");

-- CreateIndex
CREATE INDEX "prescription_pharmacy_queue_idx" ON "prescription"("tenant_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_consultation_key" ON "prescription"("consultation_id");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_consultation_tenant_key" ON "prescription"("consultation_id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_id_tenant_key" ON "prescription"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "prescription_item_current_idx" ON "prescription_item"("tenant_id", "prescription_id", "is_current");

-- CreateIndex
CREATE INDEX "prescription_item_generic_idx" ON "prescription_item"("tenant_id", "generic_name", "created_at");

-- CreateIndex
CREATE INDEX "prescription_item_product_idx" ON "prescription_item"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_item_id_tenant_key" ON "prescription_item"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "rx_favourite_user_idx" ON "rx_favourite"("tenant_id", "user_id", "uses");

-- CreateIndex
CREATE UNIQUE INDEX "rx_favourite_user_product_key" ON "rx_favourite"("user_id", "product_id");

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_encounter_id_tenant_id_fkey" FOREIGN KEY ("encounter_id", "tenant_id") REFERENCES "encounter"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_consultation_id_tenant_id_fkey" FOREIGN KEY ("consultation_id", "tenant_id") REFERENCES "consultation"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_prescription_id_tenant_id_fkey" FOREIGN KEY ("prescription_id", "tenant_id") REFERENCES "prescription"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_product_id_tenant_id_fkey" FOREIGN KEY ("product_id", "tenant_id") REFERENCES "product"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_supersedes_id_tenant_id_fkey" FOREIGN KEY ("supersedes_id", "tenant_id") REFERENCES "prescription_item"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- --------------------------------------------------------------------------
-- Shape of an item
--
-- These are cheap to state and expensive to discover missing. A row that
-- names nothing, or asks for zero of something, is not a prescription.
-- --------------------------------------------------------------------------

-- RX-F-08: either it comes from the catalogue or it is written out by hand
-- for the patient to fill elsewhere. Never neither, never both.
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_names_something"
  CHECK (
    (product_id IS NOT NULL AND external_name IS NULL AND is_external = false)
    OR
    (product_id IS NULL AND external_name IS NOT NULL AND is_external = true)
  );

ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_positive"
  CHECK (quantity > 0 AND dose_value > 0);

-- RX-F-06: a course either runs for a stated number of days or runs until
-- the supply is gone. "Neither" leaves the pharmacy guessing how much.
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_has_duration"
  CHECK (
    (until_finished = true AND duration_days IS NULL)
    OR
    (until_finished = false AND duration_days IS NOT NULL AND duration_days > 0)
  );

-- A superseded version is by definition not the current one.
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_superseded_not_current"
  CHECK (NOT (status = 'SUPERSEDED' AND is_current = true));

-- RX-F-05: "when required" needs to say required for what, or the label
-- reads "take when required" and the patient decides for themselves.
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_prn_has_indication"
  CHECK (is_prn = false OR prn_indication IS NOT NULL);

-- --------------------------------------------------------------------------
-- A prescribed item is immutable (RX-R-06)
--
-- Once it is out of DRAFT the doctor has signed it and the pharmacy may
-- already have read it. Changing the dose underneath them is how somebody
-- gets the wrong drug. A change is a new row that supersedes this one.
--
-- Status is deliberately writable: the item's *journey* continues after
-- signing — the pharmacy part-fills it, the patient declines it, the
-- doctor cancels it. What may not change is what was prescribed.
--
-- As with the consultation trigger, the columns are named rather than the
-- rows compared, and a test asserts the list against the live schema so a
-- column added next month is not silently unguarded.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prescription_item_is_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF NEW.prescription_id  IS DISTINCT FROM OLD.prescription_id
     OR NEW.version         IS DISTINCT FROM OLD.version
     OR NEW.supersedes_id   IS DISTINCT FROM OLD.supersedes_id
     OR NEW.product_id      IS DISTINCT FROM OLD.product_id
     OR NEW.external_name   IS DISTINCT FROM OLD.external_name
     OR NEW.generic_name    IS DISTINCT FROM OLD.generic_name
     OR NEW.drug_class      IS DISTINCT FROM OLD.drug_class
     OR NEW.strength        IS DISTINCT FROM OLD.strength
     OR NEW.display_name    IS DISTINCT FROM OLD.display_name
     OR NEW.dose_value      IS DISTINCT FROM OLD.dose_value
     OR NEW.dose_unit       IS DISTINCT FROM OLD.dose_unit
     OR NEW.route           IS DISTINCT FROM OLD.route
     OR NEW.frequency_code  IS DISTINCT FROM OLD.frequency_code
     OR NEW.frequency_per_day IS DISTINCT FROM OLD.frequency_per_day
     OR NEW.is_prn          IS DISTINCT FROM OLD.is_prn
     OR NEW.prn_indication  IS DISTINCT FROM OLD.prn_indication
     OR NEW.duration_days   IS DISTINCT FROM OLD.duration_days
     OR NEW.until_finished  IS DISTINCT FROM OLD.until_finished
     OR NEW.quantity        IS DISTINCT FROM OLD.quantity
     OR NEW.quantity_unit   IS DISTINCT FROM OLD.quantity_unit
     OR NEW.quantity_auto   IS DISTINCT FROM OLD.quantity_auto
     OR NEW.instructions    IS DISTINCT FROM OLD.instructions
     OR NEW.label_text      IS DISTINCT FROM OLD.label_text
     OR NEW.is_external     IS DISTINCT FROM OLD.is_external
     OR NEW.is_controlled   IS DISTINCT FROM OLD.is_controlled
     OR NEW.warnings        IS DISTINCT FROM OLD.warnings
     OR NEW.override_reason IS DISTINCT FROM OLD.override_reason
     OR NEW.overridden_by   IS DISTINCT FROM OLD.overridden_by
     OR NEW.overridden_at   IS DISTINCT FROM OLD.overridden_at
     OR NEW.created_by      IS DISTINCT FROM OLD.created_by
     OR NEW.created_at      IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'This item was prescribed and cannot be changed. Prescribe a new version of it instead (RX-R-06).'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER prescription_item_is_immutable_trigger
  BEFORE UPDATE ON "prescription_item"
  FOR EACH ROW EXECUTE FUNCTION prescription_item_is_immutable();

-- Removing a draft item is ordinary editing. Removing a prescribed one
-- erases a clinical decision somebody may have acted on: cancel it, which
-- leaves the row and the reason behind.
CREATE OR REPLACE FUNCTION prescription_item_no_hard_delete() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION
      'This item was prescribed and cannot be deleted. Cancel it with a reason instead (RX-R-06).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER prescription_item_no_hard_delete_trigger
  BEFORE DELETE ON "prescription_item"
  FOR EACH ROW EXECUTE FUNCTION prescription_item_no_hard_delete();

-- An item belongs to exactly one prescription, and a prescription to one
-- consultation. Both are already enforced by keys; what is not, is that an
-- item may not be added to a prescription that has been signed except as a
-- new version of something already on it (RX-F-15).
CREATE OR REPLACE FUNCTION prescription_item_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status::text INTO parent_status FROM prescription WHERE id = NEW.prescription_id;

  IF parent_status IN ('CANCELLED', 'COMPLETED') THEN
    RAISE EXCEPTION
      'This prescription is % and cannot take new items.', lower(parent_status)
      USING ERRCODE = 'check_violation';
  END IF;

  IF parent_status = 'ACTIVE' AND NEW.supersedes_id IS NULL AND NEW.status = 'DRAFT' THEN
    RAISE EXCEPTION
      'This prescription has been signed. A new item on it must itself be prescribed (RX-F-15).'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER prescription_item_insert_guard_trigger
  BEFORE INSERT ON "prescription_item"
  FOR EACH ROW EXECUTE FUNCTION prescription_item_insert_guard();

-- --------------------------------------------------------------------------
-- Restore patient_name_trgm_idx
--
-- `prisma migrate diff` cannot see an index the schema language cannot
-- express, so it proposes dropping every hand-written one. The encounter
-- migration (20260921080000) carried such a drop through unnoticed, and
-- patient name search has been reading every row in the tenant since.
--
-- Recreated here, and asserted from now on by raw-indexes.spec.ts so the
-- next diff cannot quietly take it away again.
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS patient_name_trgm_idx
  ON "patient" USING gin ("name_normalised" gin_trgm_ops);

-- --------------------------------------------------------------------------
-- Row-level security (TEN-F-11)
-- --------------------------------------------------------------------------
ALTER TABLE "prescription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prescription" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "prescription"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "prescription_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prescription_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "prescription_item"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "rx_favourite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rx_favourite" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "rx_favourite"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
