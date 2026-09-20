-- PAT-F-19: the patients this person has opened at this branch.
--
-- Deliberately its own table rather than a query over the audit trail. The
-- trail records a plain demographic read nowhere — §10 lists `clinical.viewed`
-- and `patient.id_unmasked`, not "somebody looked at a name and a telephone
-- number" — and adding that would mean an audit row on every keystroke's
-- worth of browsing, for a list that is a convenience.
--
-- Per user and per branch, because the list is "who was I dealing with at
-- this counter", not "who has this clinic seen".

CREATE TABLE "patient_recent" (
  "tenant_id"  uuid NOT NULL,
  "user_id"    uuid NOT NULL,
  "branch_id"  uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "opened_at"  timestamptz(3) NOT NULL DEFAULT now(),

  CONSTRAINT "patient_recent_pkey" PRIMARY KEY ("tenant_id", "user_id", "branch_id", "patient_id")
);

-- The read is "the last twenty for this person here", newest first.
CREATE INDEX "patient_recent_lookup_idx"
  ON "patient_recent" ("tenant_id", "user_id", "branch_id", "opened_at" DESC);

-- Cascades, because this is a convenience list: when the patient goes, the
-- entry has no reason to survive and must not block anything.
ALTER TABLE "patient_recent"
  ADD CONSTRAINT "patient_recent_patient_fkey"
  FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "patient_recent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_recent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_recent"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
