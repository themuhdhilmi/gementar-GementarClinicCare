-- Patient Registry (PAT, v0-03-patient.md).
--
-- The patient is tenant-scoped and carries no branch (PAT-R-08). One person,
-- one record, wherever in the clinic company they are seen; it is the visit
-- that happened at a branch, not the patient.
--
-- Three things in here are not ordinary table creation and are worth reading
-- before changing anything: the search extensions, the name normalisation
-- trigger, and the partial unique index on identity documents.

-- --------------------------------------------------------------------------
-- Extensions
--
-- pg_trgm gives the trigram index that makes partial name search fast enough
-- for a receptionist typing (PAT-F-17). unaccent strips diacritics so that
-- "Zulkiflí" and "Zulkifli" are the same person to the search box.
-- --------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- CreateEnum
CREATE TYPE "IdType" AS ENUM ('MYKAD', 'MYKID', 'PASSPORT', 'ARMY', 'POLICE', 'OTHER', 'NONE');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MaritalStatus" AS ENUM ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BloodGroup" AS ENUM ('A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PatientStatus" AS ENUM ('ACTIVE', 'DECEASED', 'MERGED', 'DELETED');

-- CreateEnum
CREATE TYPE "AllergyType" AS ENUM ('DRUG', 'FOOD', 'ENVIRONMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "AllergySeverity" AS ENUM ('MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING');

-- CreateEnum
CREATE TYPE "AllergyStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REFUTED');

-- CreateEnum
CREATE TYPE "ConditionStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ConsentChannel" AS ENUM ('SMS', 'WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('REMINDERS', 'MARKETING');

-- CreateEnum
CREATE TYPE "PatientDocumentType" AS ENUM ('ID_COPY', 'REFERRAL_IN', 'LAB_RESULT', 'CONSENT', 'PHOTO', 'OTHER');

-- CreateTable
CREATE TABLE "patient" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mrn" VARCHAR(40) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "name_normalised" VARCHAR(200) NOT NULL DEFAULT '',
    "id_type" "IdType" NOT NULL,
    "id_number" VARCHAR(40),
    "id_number_last4" VARCHAR(4),
    "passport_country" CHAR(2),
    "passport_expiry" DATE,
    "date_of_birth" DATE,
    "dob_estimated" BOOLEAN NOT NULL DEFAULT false,
    "gender" "Gender" NOT NULL,
    "nationality" CHAR(2) NOT NULL DEFAULT 'MY',
    "race" VARCHAR(60),
    "religion" VARCHAR(60),
    "marital_status" "MaritalStatus",
    "occupation" VARCHAR(120),
    "preferred_language" VARCHAR(8),
    "phone" VARCHAR(24),
    "phone_alt" VARCHAR(24),
    "email" VARCHAR(254),
    "address_line1" VARCHAR(200),
    "address_line2" VARCHAR(200),
    "postcode" VARCHAR(20),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "country" CHAR(2) DEFAULT 'MY',
    "blood_group" "BloodGroup",
    "nkda_recorded" BOOLEAN,
    "nkda_recorded_by" UUID,
    "nkda_recorded_at" TIMESTAMPTZ(3),
    "notes" VARCHAR(1000),
    "photo_key" VARCHAR(200),
    "status" "PatientStatus" NOT NULL DEFAULT 'ACTIVE',
    "merged_into_id" UUID,
    "merged_at" TIMESTAMPTZ(3),
    "merge_manifest" JSONB,
    "deceased_at" DATE,
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_reason" VARCHAR(500),
    "source" VARCHAR(60) NOT NULL DEFAULT 'MANUAL',
    "last_visit_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_contact" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "relationship" VARCHAR(60),
    "phone" VARCHAR(24) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patient_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_consent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "channel" "ConsentChannel" NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "recorded_by" UUID,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" VARCHAR(60),

    CONSTRAINT "patient_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_allergy" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "type" "AllergyType" NOT NULL,
    "substance" VARCHAR(120) NOT NULL,
    "product_id" UUID,
    "drug_class" VARCHAR(120),
    "reaction" VARCHAR(300),
    "severity" "AllergySeverity",
    "status" "AllergyStatus" NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "refuted_by" UUID,
    "refuted_at" TIMESTAMPTZ(3),
    "refuted_reason" VARCHAR(500),
    "notes" VARCHAR(500),

    CONSTRAINT "patient_allergy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_condition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "condition" VARCHAR(200) NOT NULL,
    "icd10_code" VARCHAR(10),
    "onset_date" DATE,
    "status" "ConditionStatus" NOT NULL DEFAULT 'ACTIVE',
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" DATE,
    "notes" VARCHAR(500),

    CONSTRAINT "patient_condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "type" "PatientDocumentType" NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "mime" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" VARCHAR(300) NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scanned_at" TIMESTAMPTZ(3),
    "scan_result" VARCHAR(60),
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by" UUID,

    CONSTRAINT "patient_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_import_batch" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "merged" INTEGER NOT NULL DEFAULT 0,
    "dry_run" BOOLEAN NOT NULL,
    "report" JSONB,
    "run_by" UUID NOT NULL,
    "run_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mrn_sequence" (
    "tenant_id" UUID NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "mrn_sequence_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateIndex
CREATE INDEX "patient_tenant_phone_idx" ON "patient"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "patient_tenant_id4_idx" ON "patient"("tenant_id", "id_number_last4");

-- CreateIndex
CREATE INDEX "patient_tenant_status_idx" ON "patient"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "patient_tenant_last_visit_idx" ON "patient"("tenant_id", "last_visit_at");

-- CreateIndex
CREATE UNIQUE INDEX "patient_tenant_mrn_key" ON "patient"("tenant_id", "mrn");

-- CreateIndex
CREATE UNIQUE INDEX "patient_id_tenant_key" ON "patient"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "patient_contact_patient_idx" ON "patient_contact"("tenant_id", "patient_id");

-- CreateIndex
CREATE INDEX "patient_consent_patient_idx" ON "patient_consent"("tenant_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_consent_unique" ON "patient_consent"("patient_id", "channel", "purpose");

-- CreateIndex
CREATE INDEX "patient_allergy_patient_status_idx" ON "patient_allergy"("tenant_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "patient_condition_patient_status_idx" ON "patient_condition"("tenant_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "patient_document_patient_type_idx" ON "patient_document"("tenant_id", "patient_id", "type");

-- CreateIndex
CREATE INDEX "patient_import_tenant_time_idx" ON "patient_import_batch"("tenant_id", "run_at");

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_merged_into_id_tenant_id_fkey" FOREIGN KEY ("merged_into_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "patient_contact" ADD CONSTRAINT "patient_contact_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "patient_consent" ADD CONSTRAINT "patient_consent_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "patient_document" ADD CONSTRAINT "patient_document_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- --------------------------------------------------------------------------
-- Name normalisation (PAT-F-20, PAT-R-09)
--
-- Malaysian names carry particles that say how someone relates to their
-- father, not what they are called: "bin", "binti", "a/l", "a/p", "s/o",
-- "d/o". A receptionist types "ali ahmad" and means "Ali bin Ahmad", so the
-- particles are removed before matching rather than searched for.
--
-- The two-argument form of unaccent is used deliberately. The one-argument
-- form is STABLE, because it resolves the dictionary by name at run time, and
-- a STABLE function cannot be used in an index expression. Naming the
-- dictionary makes this IMMUTABLE and therefore indexable, which matters if
-- this ever moves from a stored column to a generated one.
--
-- It is a trigger rather than application code because search that silently
-- stops matching is the kind of bug nobody reports: the receptionist assumes
-- the patient is new and registers a duplicate.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION patient_normalise_name(raw text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(unaccent('unaccent'::regdictionary, coalesce(raw, ''))),
          '[^a-z0-9]+', ' ', 'g'),
        -- Particles, once punctuation has already become spaces, so "a/l"
        -- arrives here as "a l".
        '(^| )(bin|binti|bt|bte|a l|a p|s o|d o)( |$)', ' ', 'g'),
      '\s+', ' ', 'g'));
$$;

COMMENT ON FUNCTION patient_normalise_name(text) IS
  'PAT-F-20: lower case, no diacritics, no Malaysian name particles. Used by the search index.';

CREATE OR REPLACE FUNCTION patient_set_name_normalised() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- Whatever the application sent is discarded. This column is the database's.
  NEW.name_normalised := patient_normalise_name(NEW.name);
  RETURN NEW;
END
$$;

CREATE TRIGGER patient_normalise_name_trigger
  BEFORE INSERT OR UPDATE OF name ON "patient"
  FOR EACH ROW EXECUTE FUNCTION patient_set_name_normalised();

-- --------------------------------------------------------------------------
-- Search indexes (PAT-F-16, PAT-F-17)
-- --------------------------------------------------------------------------

-- Partial name matching. gin_trgm_ops is what makes `name_normalised LIKE
-- '%ali%'` an index scan rather than a sequential read of every patient.
CREATE INDEX patient_name_trgm_idx
  ON "patient" USING gin ("name_normalised" gin_trgm_ops);

-- --------------------------------------------------------------------------
-- One active patient per identity document (PAT-R-01)
--
-- Partial, because it must not apply to a patient with no document at all
-- (infants, undocumented: PAT-F-05), nor to records that have been merged
-- away or deleted, whose numbers have to be free for the surviving record.
--
-- Passport number includes the country, because two countries issue the same
-- number to different people and both of them may walk into the clinic.
-- --------------------------------------------------------------------------
CREATE UNIQUE INDEX patient_identity_key
  ON "patient" ("tenant_id", "id_type", "id_number")
  WHERE "id_type" <> 'NONE'
    AND "id_type" <> 'PASSPORT'
    AND "id_number" IS NOT NULL
    AND "status" IN ('ACTIVE', 'DECEASED');

CREATE UNIQUE INDEX patient_passport_key
  ON "patient" ("tenant_id", "passport_country", "id_number")
  WHERE "id_type" = 'PASSPORT'
    AND "id_number" IS NOT NULL
    AND "status" IN ('ACTIVE', 'DECEASED');

-- --------------------------------------------------------------------------
-- An allergy is never deleted (PAT-R-03)
--
-- Removal is a status of REFUTED with a reason and an author. The application
-- refuses a delete as well; this is the layer that still holds when the
-- application is wrong, and when someone is at a psql prompt.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION patient_allergy_no_delete() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'patient_allergy rows are never deleted. Set status = REFUTED with a reason instead (PAT-R-03).';
END
$$;

CREATE TRIGGER patient_allergy_no_delete_trigger
  BEFORE DELETE ON "patient_allergy"
  FOR EACH ROW EXECUTE FUNCTION patient_allergy_no_delete();

-- --------------------------------------------------------------------------
-- Row-level security (TEN-F-11)
--
-- Every one of these tables is tenant-owned, so every one gets ENABLE plus
-- FORCE and a policy with both USING and WITH CHECK. None of them gets an
-- authentication bypass: nothing about signing in needs to read a patient.
--
-- The generated test (TEN-T-06) reads the live catalogue, so a table added
-- here without these three lines fails CI rather than shipping.
-- --------------------------------------------------------------------------
ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "patient_contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_contact" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_contact"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "patient_consent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_consent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_consent"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "patient_allergy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_allergy" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_allergy"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "patient_condition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_condition" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_condition"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "patient_document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_document" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_document"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "patient_import_batch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_import_batch" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_import_batch"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "mrn_sequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mrn_sequence" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mrn_sequence"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
