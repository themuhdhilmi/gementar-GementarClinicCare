-- Procedures (PRC, v0-10-procedures.md).
--
-- The rules worth having the database hold: a vaccination has to name
-- the vaccine, a performed procedure has to say who performed it and
-- when, and a consumable line has to point at the ledger movement that
-- took it off the shelf. That last one is what makes a void reversible
-- rather than a guess.
--
-- Hand-written GIN indexes are stripped from the generated drop list;
-- raw-indexes.e2e asserts the survivors against the live database.
-- CreateEnum
CREATE TYPE "ProcedureCategory" AS ENUM ('INJECTION', 'NEBULISER', 'DRESSING', 'MINOR_SURGERY', 'VACCINATION', 'SCREENING', 'OTHER');

-- CreateEnum
CREATE TYPE "ProcedureStatus" AS ENUM ('ORDERED', 'PERFORMED', 'CANCELLED', 'VOIDED');

-- CreateEnum
CREATE TYPE "Laterality" AS ENUM ('LEFT', 'RIGHT', 'BILATERAL', 'NA');

-- CreateTable
CREATE TABLE "procedure_catalog" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "category" "ProcedureCategory" NOT NULL,
    "price" BIGINT NOT NULL DEFAULT 0,
    "requires_consent" BOOLEAN NOT NULL DEFAULT false,
    "requires_doctor" BOOLEAN NOT NULL DEFAULT false,
    "vaccine_product_id" UUID,
    "default_duration_min" INTEGER,
    "protocol" VARCHAR(4000),
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "procedure_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procedure_consumable" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "procedure_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "optional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "procedure_consumable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procedure_price_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "procedure_id" UUID NOT NULL,
    "price" BIGINT NOT NULL,
    "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "set_by" UUID,
    "reason" VARCHAR(500),

    CONSTRAINT "procedure_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter_procedure" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "consultation_id" UUID,
    "procedure_id" UUID NOT NULL,
    "name_snapshot" VARCHAR(160) NOT NULL,
    "price_snapshot" BIGINT NOT NULL,
    "status" "ProcedureStatus" NOT NULL DEFAULT 'ORDERED',
    "ordered_by" UUID,
    "ordered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nurse_initiated" BOOLEAN NOT NULL DEFAULT false,
    "performed_by" UUID,
    "performed_at" TIMESTAMPTZ(3),
    "site" VARCHAR(120),
    "laterality" "Laterality",
    "consent_given" BOOLEAN,
    "consent_by" VARCHAR(160),
    "consent_at" TIMESTAMPTZ(3),
    "notes" VARCHAR(2000),
    "complications" VARCHAR(2000),
    "cancel_reason" VARCHAR(500),
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "encounter_procedure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter_procedure_consumable" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "encounter_procedure_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "stock_movement_id" UUID NOT NULL,
    "reversal_movement_id" UUID,

    CONSTRAINT "encounter_procedure_consumable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vaccination_record" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_procedure_id" UUID NOT NULL,
    "vaccine_product_id" UUID NOT NULL,
    "vaccine_name" VARCHAR(200) NOT NULL,
    "batch_no" VARCHAR(60) NOT NULL,
    "expiry" DATE,
    "dose_number" INTEGER,
    "site" VARCHAR(120),
    "given_by" UUID NOT NULL,
    "given_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vaccination_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "procedure_catalog_category_idx" ON "procedure_catalog"("tenant_id", "category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "procedure_catalog_code_key" ON "procedure_catalog"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "procedure_catalog_id_tenant_key" ON "procedure_catalog"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "procedure_consumable_product_idx" ON "procedure_consumable"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "procedure_consumable_key" ON "procedure_consumable"("procedure_id", "product_id");

-- CreateIndex
CREATE INDEX "procedure_price_history_idx" ON "procedure_price_history"("tenant_id", "procedure_id", "effective_from");

-- CreateIndex
CREATE INDEX "encounter_procedure_encounter_idx" ON "encounter_procedure"("tenant_id", "encounter_id");

-- CreateIndex
CREATE INDEX "encounter_procedure_queue_idx" ON "encounter_procedure"("tenant_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "encounter_procedure_patient_idx" ON "encounter_procedure"("tenant_id", "patient_id", "performed_at");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_procedure_id_tenant_key" ON "encounter_procedure"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "encounter_procedure_consumable_idx" ON "encounter_procedure_consumable"("tenant_id", "encounter_procedure_id");

-- CreateIndex
CREATE INDEX "encounter_procedure_consumable_batch_idx" ON "encounter_procedure_consumable"("tenant_id", "batch_id");

-- CreateIndex
CREATE INDEX "vaccination_record_patient_idx" ON "vaccination_record"("tenant_id", "patient_id", "given_at");

-- AddForeignKey
ALTER TABLE "procedure_catalog" ADD CONSTRAINT "procedure_catalog_vaccine_product_id_tenant_id_fkey" FOREIGN KEY ("vaccine_product_id", "tenant_id") REFERENCES "product"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "procedure_consumable" ADD CONSTRAINT "procedure_consumable_procedure_id_tenant_id_fkey" FOREIGN KEY ("procedure_id", "tenant_id") REFERENCES "procedure_catalog"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "procedure_consumable" ADD CONSTRAINT "procedure_consumable_product_id_tenant_id_fkey" FOREIGN KEY ("product_id", "tenant_id") REFERENCES "product"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "procedure_price_history" ADD CONSTRAINT "procedure_price_history_procedure_id_tenant_id_fkey" FOREIGN KEY ("procedure_id", "tenant_id") REFERENCES "procedure_catalog"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_procedure_id_tenant_id_fkey" FOREIGN KEY ("procedure_id", "tenant_id") REFERENCES "procedure_catalog"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_encounter_id_tenant_id_fkey" FOREIGN KEY ("encounter_id", "tenant_id") REFERENCES "encounter"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "encounter_procedure_consumable" ADD CONSTRAINT "encounter_procedure_consumable_encounter_procedure_id_tena_fkey" FOREIGN KEY ("encounter_procedure_id", "tenant_id") REFERENCES "encounter_procedure"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vaccination_record" ADD CONSTRAINT "vaccination_record_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vaccination_record" ADD CONSTRAINT "vaccination_record_encounter_procedure_id_tenant_id_fkey" FOREIGN KEY ("encounter_procedure_id", "tenant_id") REFERENCES "encounter_procedure"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- --------------------------------------------------------------------------
-- Shape
-- --------------------------------------------------------------------------

-- PRC-F-03: a vaccination with no vaccine is a note, not a vaccination.
-- Without this the batch and expiry never reach the patient's record,
-- and a recall has nothing to search.
ALTER TABLE "procedure_catalog" ADD CONSTRAINT "procedure_catalog_vaccine_named"
  CHECK (category <> 'VACCINATION' OR vaccine_product_id IS NOT NULL);

ALTER TABLE "procedure_catalog" ADD CONSTRAINT "procedure_catalog_price_not_negative"
  CHECK (price >= 0);

ALTER TABLE "procedure_consumable" ADD CONSTRAINT "procedure_consumable_positive"
  CHECK (quantity > 0);

ALTER TABLE "encounter_procedure_consumable" ADD CONSTRAINT "encounter_procedure_consumable_positive"
  CHECK (quantity > 0);

-- A performed procedure says who and when; an unperformed one says
-- neither. Anything else is a row nobody can interpret later.
ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_performed_is_attributed"
  CHECK (
    (status IN ('PERFORMED', 'VOIDED') AND performed_by IS NOT NULL AND performed_at IS NOT NULL)
    OR
    (status IN ('ORDERED', 'CANCELLED') AND performed_by IS NULL AND performed_at IS NULL)
  );

ALTER TABLE "encounter_procedure" ADD CONSTRAINT "encounter_procedure_void_has_reason"
  CHECK (status <> 'VOIDED' OR (voided_by IS NOT NULL AND void_reason IS NOT NULL));

-- --------------------------------------------------------------------------
-- A price is history (PRC-F-04)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION procedure_price_history_append_only() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'procedure_price_history is append-only: % is not permitted.', TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER procedure_price_history_no_update
  BEFORE UPDATE ON "procedure_price_history"
  FOR EACH ROW EXECUTE FUNCTION procedure_price_history_append_only();

CREATE TRIGGER procedure_price_history_no_delete
  BEFORE DELETE ON "procedure_price_history"
  FOR EACH ROW EXECUTE FUNCTION procedure_price_history_append_only();

-- --------------------------------------------------------------------------
-- A vaccination record is what a recall reads (PRC-F-11)
--
-- It may be corrected while the procedure stands, and it may not be
-- deleted: the point of it is that it can be found years later.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vaccination_record_no_delete() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'A vaccination record is kept. Void the procedure instead, which leaves the record with its reason.'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER vaccination_record_no_delete_trigger
  BEFORE DELETE ON "vaccination_record"
  FOR EACH ROW EXECUTE FUNCTION vaccination_record_no_delete();

-- --------------------------------------------------------------------------
-- Row-level security (TEN-F-11)
-- --------------------------------------------------------------------------
ALTER TABLE "procedure_catalog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procedure_catalog" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "procedure_catalog"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "procedure_consumable" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procedure_consumable" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "procedure_consumable"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "procedure_price_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procedure_price_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "procedure_price_history"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "encounter_procedure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "encounter_procedure" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "encounter_procedure"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "encounter_procedure_consumable" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "encounter_procedure_consumable" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "encounter_procedure_consumable"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "vaccination_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vaccination_record" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vaccination_record"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
