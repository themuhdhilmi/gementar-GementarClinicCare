-- PAT-N-01: an index for looking a patient up by their whole identity number.
--
-- `patient_identity_key` is a partial unique index on (tenant_id, id_type,
-- id_number), so it can only serve a lookup that also names the document
-- type. Search does not know the type: the receptionist typed twelve digits.
-- Without this, that branch of the search is a sequential scan.

CREATE INDEX patient_tenant_id_number_idx
  ON "patient" ("tenant_id", "id_number")
  WHERE "id_number" IS NOT NULL;
