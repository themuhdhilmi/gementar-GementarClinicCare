-- IAM-Q-01: FRONTDESK becomes RECEPTION, DISPENSER and CASHIER.
--
-- Flexibility comes from the assignment, not from one wide role: a user holds
-- any number of (branch, role) pairs, so a one-person front desk gets all
-- three and loses nothing, while a larger clinic can give a cashier no ability
-- to dispense. Every existing FRONTDESK assignment is therefore expanded into
-- all three, which is exactly the access that person has today.

CREATE TYPE "Role_new" AS ENUM ('ADMIN', 'DOCTOR', 'NURSE', 'RECEPTION', 'DISPENSER', 'CASHIER');

-- Row-level security is FORCEd, so it applies to the owner running this
-- migration too, and there is no tenant in scope here. Off for the rewrite,
-- back on immediately afterwards.
ALTER TABLE "user_branch_role" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "user_branch_role"
  ALTER COLUMN "role" TYPE "Role_new"
  USING (CASE WHEN "role"::text = 'FRONTDESK' THEN 'RECEPTION' ELSE "role"::text END)::"Role_new";

-- Everyone who was FRONTDESK is now RECEPTION; give them the other two as well.
INSERT INTO "user_branch_role" (id, tenant_id, user_id, branch_id, "role", created_at, updated_at, created_by, updated_by)
SELECT gen_random_uuid(), ubr.tenant_id, ubr.user_id, ubr.branch_id, extra::"Role_new",
       now(), now(), ubr.created_by, ubr.updated_by
  FROM "user_branch_role" ubr
  CROSS JOIN unnest(ARRAY['DISPENSER', 'CASHIER']) AS extra
 WHERE ubr."role" = 'RECEPTION'
ON CONFLICT DO NOTHING;

ALTER TABLE "user_branch_role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_branch_role" FORCE ROW LEVEL SECURITY;

DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";
