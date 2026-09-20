-- An index on the self-reference a merge leaves behind.
--
-- `patient.merged_into_id` points at the surviving record with ON DELETE
-- RESTRICT, and PostgreSQL does not index the referencing side of a foreign
-- key for you. Without this, every delete of a patient row has to scan the
-- whole patient table to prove nothing points at it.
--
-- Found while cleaning up a hundred thousand seeded rows after the search
-- load test: the delete took over six minutes and held a lock the whole
-- time. It is also on the path of an ordinary merge, which reads the
-- surviving record's dependents.

CREATE INDEX patient_merged_into_idx
  ON "patient" ("tenant_id", "merged_into_id")
  WHERE "merged_into_id" IS NOT NULL;
