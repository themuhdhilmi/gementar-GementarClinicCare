-- Consultation / EMR (CON, v0-06-consultation.md).
--
-- A signed consultation is a legal document. The two triggers at the end of
-- this migration are the reason it can be described that way: after signing,
-- no clinical column of the record or its diagnoses can change, whatever
-- writes to them. The application refuses first, with a better message;
-- this is what still holds when the application is wrong.

-- CreateEnum
CREATE TYPE "ConsultationStatus" AS ENUM ('DRAFT', 'SIGNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DiagnosisRank" AS ENUM ('PRIMARY', 'SECONDARY');

-- CreateEnum
CREATE TYPE "DiagnosisCertainty" AS ENUM ('PROVISIONAL', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "AmendmentType" AS ENUM ('ADDENDUM', 'CORRECTION');

-- CreateEnum
CREATE TYPE "TemplateScope" AS ENUM ('TENANT', 'USER');

-- CreateTable
CREATE TABLE "consultation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "status" "ConsultationStatus" NOT NULL DEFAULT 'DRAFT',
    "chief_complaint" VARCHAR(20000),
    "hpi" VARCHAR(20000),
    "history" VARCHAR(20000),
    "examination" VARCHAR(20000),
    "plan_text" VARCHAR(20000),
    "template_id" UUID,
    "copied_from_id" UUID,
    "follow_up_due" DATE,
    "follow_up_note" VARCHAR(500),
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_autosave_at" TIMESTAMPTZ(3),
    "signed_at" TIMESTAMPTZ(3),
    "signed_by" UUID,
    "signed_ip" VARCHAR(45),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "content_hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "consultation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnosis" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "consultation_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "rank" "DiagnosisRank" NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "icd10_code" VARCHAR(10),
    "icd10_label" VARCHAR(300),
    "certainty" "DiagnosisCertainty" NOT NULL DEFAULT 'PROVISIONAL',
    "is_chronic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultation_amendment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "consultation_id" UUID NOT NULL,
    "type" "AmendmentType" NOT NULL,
    "field" VARCHAR(40),
    "previous" JSONB,
    "current" JSONB NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "amended_by" UUID NOT NULL,
    "amended_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amended_ip" VARCHAR(45),

    CONSTRAINT "consultation_amendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultation_attachment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "consultation_id" UUID NOT NULL,
    "patient_document_id" UUID NOT NULL,
    "caption" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultation_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_template" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope" "TemplateScope" NOT NULL,
    "owner_id" UUID,
    "name" VARCHAR(120) NOT NULL,
    "keywords" VARCHAR(40)[],
    "content" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clinical_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quick_phrase" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "trigger" VARCHAR(40) NOT NULL,
    "expansion" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quick_phrase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consultation_encounter_idx" ON "consultation"("tenant_id", "encounter_id");

-- CreateIndex
CREATE INDEX "consultation_patient_idx" ON "consultation"("tenant_id", "patient_id", "signed_at");

-- CreateIndex
CREATE INDEX "consultation_doctor_status_idx" ON "consultation"("tenant_id", "doctor_id", "status");

-- CreateIndex
CREATE INDEX "consultation_stale_idx" ON "consultation"("tenant_id", "status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "consultation_encounter_sequence_key" ON "consultation"("encounter_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "consultation_id_tenant_key" ON "consultation"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "diagnosis_consultation_idx" ON "diagnosis"("tenant_id", "consultation_id");

-- CreateIndex
CREATE INDEX "diagnosis_icd10_idx" ON "diagnosis"("tenant_id", "icd10_code");

-- CreateIndex
CREATE INDEX "consultation_amendment_idx" ON "consultation_amendment"("tenant_id", "consultation_id", "amended_at");

-- CreateIndex
CREATE INDEX "consultation_attachment_idx" ON "consultation_attachment"("tenant_id", "consultation_id");

-- CreateIndex
CREATE UNIQUE INDEX "consultation_attachment_key" ON "consultation_attachment"("consultation_id", "patient_document_id");

-- CreateIndex
CREATE INDEX "clinical_template_scope_idx" ON "clinical_template"("tenant_id", "scope", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "clinical_template_id_tenant_key" ON "clinical_template"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "quick_phrase_user_idx" ON "quick_phrase"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "quick_phrase_user_trigger_key" ON "quick_phrase"("user_id", "trigger");

-- AddForeignKey
ALTER TABLE "consultation" ADD CONSTRAINT "consultation_encounter_id_tenant_id_fkey" FOREIGN KEY ("encounter_id", "tenant_id") REFERENCES "encounter"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "consultation" ADD CONSTRAINT "consultation_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "consultation" ADD CONSTRAINT "consultation_template_id_tenant_id_fkey" FOREIGN KEY ("template_id", "tenant_id") REFERENCES "clinical_template"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "consultation" ADD CONSTRAINT "consultation_copied_from_id_tenant_id_fkey" FOREIGN KEY ("copied_from_id", "tenant_id") REFERENCES "consultation"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_consultation_id_tenant_id_fkey" FOREIGN KEY ("consultation_id", "tenant_id") REFERENCES "consultation"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "consultation_amendment" ADD CONSTRAINT "consultation_amendment_consultation_id_tenant_id_fkey" FOREIGN KEY ("consultation_id", "tenant_id") REFERENCES "consultation"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "consultation_attachment" ADD CONSTRAINT "consultation_attachment_consultation_id_tenant_id_fkey" FOREIGN KEY ("consultation_id", "tenant_id") REFERENCES "consultation"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- --------------------------------------------------------------------------
-- A signed record is immutable (CON-R-01, CON-N-05)
--
-- Every clinical column is named rather than the trigger comparing whole
-- rows, because some columns must still be writable after signing: the
-- content hash is written *by* the signing itself, and nothing else here is.
--
-- Listing them means a column added later is not covered until somebody
-- adds it, so the list is asserted against the live schema by a test. A
-- silent gap in an immutability rule is worse than no rule, because
-- everyone believes the record is safe.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION consultation_signed_is_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'SIGNED' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.chief_complaint IS DISTINCT FROM OLD.chief_complaint
     OR NEW.hpi             IS DISTINCT FROM OLD.hpi
     OR NEW.history         IS DISTINCT FROM OLD.history
     OR NEW.examination     IS DISTINCT FROM OLD.examination
     OR NEW.plan_text       IS DISTINCT FROM OLD.plan_text
     OR NEW.follow_up_due   IS DISTINCT FROM OLD.follow_up_due
     OR NEW.follow_up_note  IS DISTINCT FROM OLD.follow_up_note
     OR NEW.doctor_id       IS DISTINCT FROM OLD.doctor_id
     OR NEW.patient_id      IS DISTINCT FROM OLD.patient_id
     OR NEW.encounter_id    IS DISTINCT FROM OLD.encounter_id
     OR NEW.signed_at       IS DISTINCT FROM OLD.signed_at
     OR NEW.signed_by       IS DISTINCT FROM OLD.signed_by
     OR NEW.content_hash    IS DISTINCT FROM OLD.content_hash
  THEN
    RAISE EXCEPTION
      'This consultation was signed on % and cannot be changed. Record an amendment instead (CON-R-01).',
      OLD.signed_at
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER consultation_signed_is_immutable_trigger
  BEFORE UPDATE ON "consultation"
  FOR EACH ROW EXECUTE FUNCTION consultation_signed_is_immutable();

-- A diagnosis belongs to the record it was made in, so it inherits the
-- record's immutability. Checked against the parent's status rather than
-- duplicating a flag that could drift out of step with it.
CREATE OR REPLACE FUNCTION diagnosis_follows_consultation() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  parent_id uuid;
BEGIN
  parent_id := COALESCE(NEW.consultation_id, OLD.consultation_id);
  SELECT status::text INTO parent_status FROM consultation WHERE id = parent_id;

  IF parent_status = 'SIGNED' THEN
    RAISE EXCEPTION
      'The consultation this diagnosis belongs to has been signed. Record an amendment instead (CON-R-01).'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER diagnosis_follows_consultation_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON "diagnosis"
  FOR EACH ROW EXECUTE FUNCTION diagnosis_follows_consultation();

-- An amendment is the record of a change. It cannot itself be changed.
CREATE OR REPLACE FUNCTION consultation_amendment_append_only() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'consultation_amendment is append-only: % is not permitted.', TG_OP;
END
$$;

CREATE TRIGGER consultation_amendment_no_update
  BEFORE UPDATE ON "consultation_amendment"
  FOR EACH ROW EXECUTE FUNCTION consultation_amendment_append_only();

CREATE TRIGGER consultation_amendment_no_delete
  BEFORE DELETE ON "consultation_amendment"
  FOR EACH ROW EXECUTE FUNCTION consultation_amendment_append_only();

-- --------------------------------------------------------------------------
-- Row-level security (TEN-F-11)
-- --------------------------------------------------------------------------
ALTER TABLE "consultation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consultation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "consultation"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "diagnosis" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "diagnosis" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "diagnosis"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "consultation_amendment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consultation_amendment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "consultation_amendment"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "consultation_attachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consultation_attachment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "consultation_attachment"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "clinical_template" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinical_template" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clinical_template"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "quick_phrase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quick_phrase" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quick_phrase"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
