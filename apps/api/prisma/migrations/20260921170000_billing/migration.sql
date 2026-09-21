-- Billing (BIL, v0-11-billing.md).
--
-- Money is integer sen and the database says so: the two totalling
-- invariants are CHECK constraints, not service code, because a total
-- that disagrees with its lines is the one thing that must be
-- impossible rather than merely tested.
--
-- One correction to the specification is made here, deliberately.
-- §5 gives `CHECK (grand_total = subtotal - discount_total + tax_total)`
-- unconditionally, but §14 also says tax-inclusive pricing must never
-- change the customer-facing total. Both cannot hold: with inclusive
-- tax the tax is already inside `subtotal`, so adding it again would
-- overcharge by the tax. The constraint below is therefore written per
-- mode, which is what the two rules together actually mean.
--
-- Hand-written GIN indexes are stripped from the generated drop list;
-- raw-indexes.e2e asserts the survivors against the live database.
-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIAL', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('ENCOUNTER', 'STANDALONE');

-- CreateEnum
CREATE TYPE "InvoiceLineType" AS ENUM ('CONSULTATION', 'MEDICINE', 'PROCEDURE', 'DOCUMENT', 'ITEM', 'MANUAL');

-- CreateEnum
CREATE TYPE "PayerType" AS ENUM ('PATIENT', 'PANEL', 'CORPORATE');

-- CreateEnum
CREATE TYPE "TaxMode" AS ENUM ('INCLUSIVE', 'EXCLUSIVE');

-- CreateEnum
CREATE TYPE "FeeTimeBand" AS ENUM ('ANY', 'AFTER_HOURS', 'WEEKEND', 'PUBLIC_HOLIDAY');

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "encounter_id" UUID,
    "patient_id" UUID,
    "walkup_name" VARCHAR(150),
    "kind" "InvoiceKind" NOT NULL DEFAULT 'ENCOUNTER',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "invoice_no" VARCHAR(40),
    "series_year" INTEGER,
    "series_seq" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'MYR',
    "tax_mode" "TaxMode" NOT NULL DEFAULT 'EXCLUSIVE',
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "discount_total" BIGINT NOT NULL DEFAULT 0,
    "tax_total" BIGINT NOT NULL DEFAULT 0,
    "rounding_adjustment" BIGINT NOT NULL DEFAULT 0,
    "grand_total" BIGINT NOT NULL DEFAULT 0,
    "amount_paid" BIGINT NOT NULL DEFAULT 0,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "invoice_discount_pct" DECIMAL(5,2),
    "invoice_discount_reason" VARCHAR(500),
    "invoice_discount_source" VARCHAR(40),
    "payer_type" "PayerType" NOT NULL DEFAULT 'PATIENT',
    "payer_id" UUID,
    "membership_id" UUID,
    "patient_name_snapshot" VARCHAR(150),
    "patient_id_masked_snapshot" VARCHAR(40),
    "buyer_tin" VARCHAR(40),
    "einvoice_status" VARCHAR(40),
    "einvoice_uuid" VARCHAR(80),
    "einvoice_long_id" VARCHAR(200),
    "einvoice_qr" VARCHAR(500),
    "einvoice_submitted_at" TIMESTAMPTZ(3),
    "issued_at" TIMESTAMPTZ(3),
    "issued_by" UUID,
    "paid_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "void_reason" VARCHAR(500),
    "reissued_from_id" UUID,
    "reissued_as_id" UUID,
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "line_type" "InvoiceLineType" NOT NULL,
    "source_type" VARCHAR(40),
    "source_id" UUID,
    "description" VARCHAR(300) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "quantity_unit" VARCHAR(20),
    "unit_price" BIGINT NOT NULL,
    "gross" BIGINT NOT NULL,
    "discount_pct" DECIMAL(5,2),
    "own_discount_amount" BIGINT NOT NULL DEFAULT 0,
    "discount_amount" BIGINT NOT NULL DEFAULT 0,
    "discount_source" VARCHAR(40),
    "discount_reason" VARCHAR(500),
    "discount_by" UUID,
    "tax_code" VARCHAR(20) NOT NULL DEFAULT 'NONE',
    "tax_rate_bp" INTEGER NOT NULL DEFAULT 0,
    "tax_amount" BIGINT NOT NULL DEFAULT 0,
    "line_total" BIGINT NOT NULL,
    "fee_rule" VARCHAR(80),
    "is_auto" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_series" (
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "next_seq" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "invoice_series_pkey" PRIMARY KEY ("branch_id","year")
);

-- CreateTable
CREATE TABLE "billable_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "default_price" BIGINT NOT NULL DEFAULT 0,
    "tax_code" VARCHAR(20) NOT NULL DEFAULT 'NONE',
    "category" VARCHAR(80),
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "billable_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_schedule" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "encounter_type" VARCHAR(40),
    "doctor_id" UUID,
    "time_band" "FeeTimeBand" NOT NULL DEFAULT 'ANY',
    "fee" BIGINT NOT NULL,
    "tax_code" VARCHAR(20) NOT NULL DEFAULT 'NONE',
    "effective_from" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" DATE,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_branch_idx" ON "invoice"("tenant_id", "branch_id", "status", "issued_at");

-- CreateIndex
CREATE INDEX "invoice_patient_idx" ON "invoice"("tenant_id", "patient_id", "issued_at");

-- CreateIndex
CREATE INDEX "invoice_encounter_idx" ON "invoice"("tenant_id", "encounter_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_no_key" ON "invoice"("tenant_id", "invoice_no");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_series_key" ON "invoice"("branch_id", "series_year", "series_seq");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_id_tenant_key" ON "invoice"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "invoice_line_invoice_idx" ON "invoice_line"("tenant_id", "invoice_id");

-- CreateIndex
CREATE INDEX "invoice_line_source_idx" ON "invoice_line"("source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_line_no_key" ON "invoice_line"("invoice_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_line_id_tenant_key" ON "invoice_line"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "invoice_series_tenant_idx" ON "invoice_series"("tenant_id");

-- CreateIndex
CREATE INDEX "billable_item_status_idx" ON "billable_item"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "billable_item_code_key" ON "billable_item"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "fee_schedule_match_idx" ON "fee_schedule"("tenant_id", "branch_id", "encounter_type");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_encounter_id_tenant_id_fkey" FOREIGN KEY ("encounter_id", "tenant_id") REFERENCES "encounter"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_reissued_from_id_tenant_id_fkey" FOREIGN KEY ("reissued_from_id", "tenant_id") REFERENCES "invoice"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_id_tenant_id_fkey" FOREIGN KEY ("invoice_id", "tenant_id") REFERENCES "invoice"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- --------------------------------------------------------------------------
-- The totals add up (BIL-R-04)
--
-- Not a service check. A service check is one refactor away from being
-- skipped, and this is the number the patient pays.
-- --------------------------------------------------------------------------
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_totals_add_up"
  CHECK (
    (tax_mode = 'EXCLUSIVE' AND grand_total = subtotal - discount_total + tax_total)
    OR
    -- Inclusive: the tax is already inside subtotal (§14).
    (tax_mode = 'INCLUSIVE' AND grand_total = subtotal - discount_total)
  );

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_balance_adds_up"
  CHECK (balance = grand_total + rounding_adjustment - amount_paid);

-- BIL-R-10: cash rounding is a few sen, never a discount in disguise.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_rounding_is_small"
  CHECK (rounding_adjustment BETWEEN -4 AND 4);

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_amounts_not_negative"
  CHECK (subtotal >= 0 AND discount_total >= 0 AND tax_total >= 0
         AND grand_total >= 0 AND amount_paid >= 0);

-- A draft has no number; anything else has one.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_number_when_issued"
  CHECK (
    (status = 'DRAFT' AND invoice_no IS NULL AND series_seq IS NULL)
    OR
    (status <> 'DRAFT' AND invoice_no IS NOT NULL AND series_seq IS NOT NULL
     AND issued_at IS NOT NULL AND issued_by IS NOT NULL)
  );

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_void_has_reason"
  CHECK (status <> 'VOID' OR (voided_by IS NOT NULL AND void_reason IS NOT NULL));

-- BIL-F-18: an invoice is for a visit, or for somebody at the counter
-- who gave a name. Not for nobody.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_has_a_payer"
  CHECK (
    (kind = 'ENCOUNTER' AND encounter_id IS NOT NULL AND patient_id IS NOT NULL)
    OR
    (kind = 'STANDALONE' AND (patient_id IS NOT NULL OR walkup_name IS NOT NULL))
  );

-- BIL-R-02: the line's own arithmetic.
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_gross_is_right"
  CHECK (gross = round(quantity * unit_price));

ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_discount_in_range"
  CHECK (discount_amount >= 0 AND discount_amount <= gross);

-- A line's own discount is part of its total discount, never more.
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_own_discount_in_range"
  CHECK (own_discount_amount >= 0 AND own_discount_amount <= discount_amount);

ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_sane"
  CHECK (quantity > 0 AND unit_price >= 0 AND tax_amount >= 0 AND line_no >= 1);

-- --------------------------------------------------------------------------
-- BIL-F-01: one draft per visit
--
-- A partial unique index, which the schema language cannot express: two
-- drafts for one encounter would mean two totals and a cashier choosing
-- between them.
-- --------------------------------------------------------------------------
CREATE UNIQUE INDEX invoice_one_draft_per_encounter
  ON "invoice" (encounter_id)
  WHERE status = 'DRAFT' AND encounter_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- An issued invoice does not change (BIL-R-05, BIL-N-05)
--
-- The allowed list is short and it is the point of the trigger: what a
-- patient was charged is settled the moment it is handed to them. What
-- may still move is what they have paid, the cash rounding, and the
-- void — all of which are facts that come after.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoice_issued_is_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF NEW.branch_id        IS DISTINCT FROM OLD.branch_id
     OR NEW.encounter_id  IS DISTINCT FROM OLD.encounter_id
     OR NEW.patient_id    IS DISTINCT FROM OLD.patient_id
     OR NEW.walkup_name   IS DISTINCT FROM OLD.walkup_name
     OR NEW.kind          IS DISTINCT FROM OLD.kind
     OR NEW.invoice_no    IS DISTINCT FROM OLD.invoice_no
     OR NEW.series_year   IS DISTINCT FROM OLD.series_year
     OR NEW.series_seq    IS DISTINCT FROM OLD.series_seq
     OR NEW.currency      IS DISTINCT FROM OLD.currency
     OR NEW.tax_mode      IS DISTINCT FROM OLD.tax_mode
     OR NEW.subtotal      IS DISTINCT FROM OLD.subtotal
     OR NEW.discount_total IS DISTINCT FROM OLD.discount_total
     OR NEW.tax_total     IS DISTINCT FROM OLD.tax_total
     OR NEW.grand_total   IS DISTINCT FROM OLD.grand_total
     OR NEW.invoice_discount_pct    IS DISTINCT FROM OLD.invoice_discount_pct
     OR NEW.invoice_discount_reason IS DISTINCT FROM OLD.invoice_discount_reason
     OR NEW.invoice_discount_source IS DISTINCT FROM OLD.invoice_discount_source
     OR NEW.patient_name_snapshot     IS DISTINCT FROM OLD.patient_name_snapshot
     OR NEW.patient_id_masked_snapshot IS DISTINCT FROM OLD.patient_id_masked_snapshot
     OR NEW.issued_at     IS DISTINCT FROM OLD.issued_at
     OR NEW.issued_by     IS DISTINCT FROM OLD.issued_by
  THEN
    RAISE EXCEPTION
      'Invoice % was issued on % and cannot be changed. Void it and reissue.',
      OLD.invoice_no, OLD.issued_at
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER invoice_issued_is_immutable_trigger
  BEFORE UPDATE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION invoice_issued_is_immutable();

-- A line belongs to the invoice it was issued on, so it inherits the
-- invoice's immutability. Checked against the parent rather than
-- duplicating a flag that could drift out of step with it.
CREATE OR REPLACE FUNCTION invoice_line_follows_invoice() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  parent_no text;
BEGIN
  SELECT status::text, invoice_no INTO parent_status, parent_no
    FROM invoice WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  IF parent_status IS NULL OR parent_status = 'DRAFT' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION
    'Invoice % has been issued; its lines cannot be %. Void it and reissue.',
    parent_no, lower(TG_OP)
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER invoice_line_follows_invoice_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION invoice_line_follows_invoice();

-- --------------------------------------------------------------------------
-- Row-level security (TEN-F-11)
-- --------------------------------------------------------------------------
ALTER TABLE "invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoice"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "invoice_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoice_line"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "invoice_series" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_series" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoice_series"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "billable_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billable_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billable_item"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "fee_schedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fee_schedule" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "fee_schedule"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
