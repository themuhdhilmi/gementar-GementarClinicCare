-- Documents (DOC, v0-13-documents.md).
--
-- The paper a patient walks out with. Each row points at a stored file
-- and carries the hash of it, because a reprint has to serve what was
-- handed over rather than what the template would produce today.
--
-- A medical certificate is a legal document, so the number series is
-- gapless, a cancellation keeps its number, and the issued row does not
-- change afterwards.
--
-- Hand-written GIN indexes are stripped from the generated drop list;
-- raw-indexes.e2e asserts the survivors against the live database.
-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('MC', 'REFERRAL', 'RX_PRINT', 'INVOICE', 'RECEIPT', 'LABEL', 'QUEUE_TICKET', 'MEDICAL_LETTER', 'LAB_REQUEST', 'CONSULT_RECORD', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SignatureKind" AS ENUM ('IMAGE', 'TYPED', 'NONE');

-- CreateEnum
CREATE TYPE "PrintTarget" AS ENUM ('A4', 'THERMAL_80', 'THERMAL_58', 'LABEL_50x30', 'LABEL_70x40');

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID,
    "encounter_id" UUID,
    "type" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'ISSUED',
    "document_no" VARCHAR(40),
    "series_year" INTEGER,
    "series_seq" INTEGER,
    "source_type" VARCHAR(40),
    "source_id" UUID,
    "template_key" VARCHAR(60) NOT NULL,
    "template_version" INTEGER NOT NULL,
    "target" "PrintTarget" NOT NULL DEFAULT 'A4',
    "language" CHAR(2) NOT NULL DEFAULT 'EN',
    "storage_key" VARCHAR(200) NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "verification_code" VARCHAR(16),
    "issued_by" UUID NOT NULL,
    "issued_by_name" VARCHAR(150),
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature_kind" "SignatureKind" NOT NULL DEFAULT 'NONE',
    "print_count" INTEGER NOT NULL DEFAULT 0,
    "last_printed_at" TIMESTAMPTZ(3),
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "replaced_by_id" UUID,
    "fee_line_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_series" (
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "type" "DocumentType" NOT NULL,
    "year" INTEGER NOT NULL,
    "next_seq" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_series_pkey" PRIMARY KEY ("branch_id","type","year")
);

-- CreateTable
CREATE TABLE "mc_detail" (
    "document_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "days" INTEGER NOT NULL,
    "light_duty" BOOLEAN NOT NULL DEFAULT false,
    "diagnosis_included" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "mc_detail_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "doctor_signature" (
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "storage_key" VARCHAR(200) NOT NULL,
    "mime" VARCHAR(60) NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "doctor_signature_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "document_patient_idx" ON "document"("tenant_id", "patient_id", "type", "issued_at");

-- CreateIndex
CREATE INDEX "document_encounter_idx" ON "document"("tenant_id", "encounter_id");

-- CreateIndex
CREATE INDEX "document_verification_idx" ON "document"("tenant_id", "verification_code");

-- CreateIndex
CREATE INDEX "document_source_idx" ON "document"("source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_no_key" ON "document"("tenant_id", "document_no");

-- CreateIndex
CREATE UNIQUE INDEX "document_id_tenant_key" ON "document"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "document_series_tenant_idx" ON "document_series"("tenant_id");

-- CreateIndex
CREATE INDEX "mc_detail_date_idx" ON "mc_detail"("tenant_id", "from_date");

-- CreateIndex
CREATE UNIQUE INDEX "mc_detail_document_tenant_key" ON "mc_detail"("document_id", "tenant_id");

-- CreateIndex
CREATE INDEX "doctor_signature_tenant_idx" ON "doctor_signature"("tenant_id");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_encounter_id_tenant_id_fkey" FOREIGN KEY ("encounter_id", "tenant_id") REFERENCES "encounter"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_replaced_by_id_tenant_id_fkey" FOREIGN KEY ("replaced_by_id", "tenant_id") REFERENCES "document"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mc_detail" ADD CONSTRAINT "mc_detail_document_id_tenant_id_fkey" FOREIGN KEY ("document_id", "tenant_id") REFERENCES "document"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- --------------------------------------------------------------------------
-- Shape
-- --------------------------------------------------------------------------

-- A numbered type carries its whole number, or none of it.
ALTER TABLE "document" ADD CONSTRAINT "document_number_is_whole"
  CHECK (
    (document_no IS NULL AND series_year IS NULL AND series_seq IS NULL)
    OR
    (document_no IS NOT NULL AND series_year IS NOT NULL AND series_seq IS NOT NULL)
  );

ALTER TABLE "document" ADD CONSTRAINT "document_cancel_has_reason"
  CHECK (status <> 'CANCELLED' OR (cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL));

ALTER TABLE "document" ADD CONSTRAINT "document_print_count_not_negative"
  CHECK (print_count >= 0);

-- DOC-F-05, DOC §12: a certificate covers at least one day, and the last
-- day is the first plus the days minus one. Said here because an MC with
-- the dates the wrong way round is a document somebody has to explain.
ALTER TABLE "mc_detail" ADD CONSTRAINT "mc_detail_dates_agree"
  CHECK (days >= 1 AND to_date = from_date + (days - 1));

-- --------------------------------------------------------------------------
-- An issued document does not change (DOC-R-02)
--
-- What may still move is what happens *to* it afterwards: it gets
-- printed again, or it gets cancelled and replaced. What it says does
-- not, because a reprint has to be the same piece of paper.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION document_is_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.branch_id        IS DISTINCT FROM OLD.branch_id
     OR NEW.patient_id    IS DISTINCT FROM OLD.patient_id
     OR NEW.encounter_id  IS DISTINCT FROM OLD.encounter_id
     OR NEW.type          IS DISTINCT FROM OLD.type
     OR NEW.document_no   IS DISTINCT FROM OLD.document_no
     OR NEW.series_year   IS DISTINCT FROM OLD.series_year
     OR NEW.series_seq    IS DISTINCT FROM OLD.series_seq
     OR NEW.source_type   IS DISTINCT FROM OLD.source_type
     OR NEW.source_id     IS DISTINCT FROM OLD.source_id
     OR NEW.template_key  IS DISTINCT FROM OLD.template_key
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.target        IS DISTINCT FROM OLD.target
     OR NEW.language      IS DISTINCT FROM OLD.language
     OR NEW.storage_key   IS DISTINCT FROM OLD.storage_key
     OR NEW.content_hash  IS DISTINCT FROM OLD.content_hash
     OR NEW.payload       IS DISTINCT FROM OLD.payload
     OR NEW.verification_code IS DISTINCT FROM OLD.verification_code
     OR NEW.issued_by     IS DISTINCT FROM OLD.issued_by
     OR NEW.issued_at     IS DISTINCT FROM OLD.issued_at
     OR NEW.signature_kind IS DISTINCT FROM OLD.signature_kind
  THEN
    RAISE EXCEPTION
      'Document % was issued on % and cannot be changed. Cancel it and issue a replacement.',
      COALESCE(OLD.document_no, OLD.id::text), OLD.issued_at
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER document_is_immutable_trigger
  BEFORE UPDATE ON "document"
  FOR EACH ROW EXECUTE FUNCTION document_is_immutable();

-- A document is never deleted. A medical certificate that can be made to
-- disappear is not evidence of anything.
CREATE OR REPLACE FUNCTION document_no_delete() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'A document is kept. Cancel it with a reason instead.'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER document_no_delete_trigger
  BEFORE DELETE ON "document"
  FOR EACH ROW EXECUTE FUNCTION document_no_delete();

-- The certificate detail belongs to its document and inherits the same
-- rule: it is written once, at issue.
CREATE OR REPLACE FUNCTION mc_detail_is_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'A certificate''s dates cannot be changed. Cancel it and issue a replacement.'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER mc_detail_is_immutable_trigger
  BEFORE UPDATE ON "mc_detail"
  FOR EACH ROW EXECUTE FUNCTION mc_detail_is_immutable();

-- --------------------------------------------------------------------------
-- Row-level security (TEN-F-11)
-- --------------------------------------------------------------------------
ALTER TABLE "document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "document"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "document_series" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_series" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "document_series"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "mc_detail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mc_detail" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mc_detail"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "doctor_signature" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "doctor_signature" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "doctor_signature"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
