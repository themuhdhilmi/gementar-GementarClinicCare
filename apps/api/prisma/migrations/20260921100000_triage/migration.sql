-- Triage / Nurse Station (TRI, v0-05-triage.md).
--
-- Vitals are stored as integers in fixed units (TRI-R-01). A temperature is
-- deci-degrees, a weight is grams, a height is millimetres. Floating point
-- has no business in a measurement that will be compared against a
-- threshold, charted, or used to work out a child's dose.

-- CreateEnum
CREATE TYPE "FlagLevel" AS ENUM ('NONE', 'ABNORMAL', 'CRITICAL');

-- CreateTable
CREATE TABLE "triage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "systolic" SMALLINT,
    "diastolic" SMALLINT,
    "heart_rate" SMALLINT,
    "resp_rate" SMALLINT,
    "temperature_dc" SMALLINT,
    "spo2" SMALLINT,
    "weight_g" INTEGER,
    "height_mm" SMALLINT,
    "bmi_x10" SMALLINT,
    "glucose_x10" SMALLINT,
    "glucose_fasting" BOOLEAN,
    "pain_score" SMALLINT,
    "complaint" VARCHAR(1000),
    "notes" VARCHAR(1000),
    "flags" JSONB NOT NULL DEFAULT '[]',
    "max_flag_level" "FlagLevel" NOT NULL DEFAULT 'NONE',
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),

    CONSTRAINT "triage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triage_amendment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "triage_id" UUID NOT NULL,
    "amended_by" UUID NOT NULL,
    "amended_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(500) NOT NULL,
    "previous" JSONB NOT NULL,
    "current" JSONB NOT NULL,

    CONSTRAINT "triage_amendment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "triage_patient_trend_idx" ON "triage"("tenant_id", "patient_id", "recorded_at");

-- CreateIndex
CREATE INDEX "triage_encounter_idx" ON "triage"("tenant_id", "encounter_id");

-- CreateIndex
CREATE UNIQUE INDEX "triage_encounter_sequence_key" ON "triage"("encounter_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "triage_id_tenant_key" ON "triage"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "triage_amendment_idx" ON "triage_amendment"("tenant_id", "triage_id", "amended_at");

-- AddForeignKey
ALTER TABLE "triage" ADD CONSTRAINT "triage_encounter_id_tenant_id_fkey" FOREIGN KEY ("encounter_id", "tenant_id") REFERENCES "encounter"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "triage" ADD CONSTRAINT "triage_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "triage_amendment" ADD CONSTRAINT "triage_amendment_triage_id_tenant_id_fkey" FOREIGN KEY ("triage_id", "tenant_id") REFERENCES "triage"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- --------------------------------------------------------------------------
-- A locked record is history (TRI-R-04)
--
-- Once the consultation is signed, the vitals it was based on stop being
-- editable. Correcting them afterwards is an amendment: the original stays,
-- and the change says who made it and why.
--
-- The application enforces this first, with a better message. This is the
-- backstop for anything that writes the row without going through the
-- service, which is the same reasoning as the encounter status guard.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION triage_locked_is_history() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- Locking it, and only locking it, is allowed on a locked record: that is
  -- the consultation being signed.
  IF OLD.locked_at IS NOT NULL AND NEW.locked_at IS NOT DISTINCT FROM OLD.locked_at THEN
    RAISE EXCEPTION
      'This triage record was locked when the consultation was signed. Amend it instead (TRI-R-04).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER triage_locked_is_history_trigger
  BEFORE UPDATE ON "triage"
  FOR EACH ROW EXECUTE FUNCTION triage_locked_is_history();

-- An amendment records what happened. Like the audit trail and the
-- encounter timeline, it would be worthless if it could be tidied up.
CREATE OR REPLACE FUNCTION triage_amendment_append_only() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'triage_amendment is append-only: % is not permitted.', TG_OP;
END
$$;

CREATE TRIGGER triage_amendment_no_update
  BEFORE UPDATE ON "triage_amendment"
  FOR EACH ROW EXECUTE FUNCTION triage_amendment_append_only();

CREATE TRIGGER triage_amendment_no_delete
  BEFORE DELETE ON "triage_amendment"
  FOR EACH ROW EXECUTE FUNCTION triage_amendment_append_only();

-- --------------------------------------------------------------------------
-- Row-level security (TEN-F-11)
-- --------------------------------------------------------------------------
ALTER TABLE "triage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "triage" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "triage"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "triage_amendment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "triage_amendment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "triage_amendment"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
