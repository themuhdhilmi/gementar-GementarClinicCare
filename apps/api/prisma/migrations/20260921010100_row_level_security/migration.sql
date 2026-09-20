-- Tenant isolation, layer two: PostgreSQL row-level security.
--
-- Layer one is the Prisma client extension in src/shared/prisma/tenant-scope.ts,
-- which injects tenant_id into every query. This is the backstop for the day a
-- `where` clause is forgotten, and it is the reason the planning documents chose
-- PostgreSQL (documents/planning/03-multi-tenancy.md).
--
-- Unlike the MySQL triggers this replaces, everything here is installed by
-- `prisma migrate deploy` under the application's own account. There is no
-- separate step for a database administrator to forget.

-- ---------------------------------------------------------------- helpers

-- The tenant for the current transaction. NULL when nothing has been set,
-- which makes every policy below evaluate to false: unset means deny, not
-- "see everything". `true` as the second argument returns NULL for a missing
-- setting instead of raising, so a forgotten scope is a clean deny rather than
-- a confusing 500.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- The narrow, deliberate escape hatch. The authentication path has to read
-- across tenants before it knows which tenant it is dealing with: a session by
-- its token hash, a user by email address, a reset token by its hash. The
-- nightly cleanup job needs the same reach. Nothing else does, and the tables
-- that hold clinical-adjacent data do not grant it at all.
CREATE OR REPLACE FUNCTION app_auth_bypass() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(current_setting('app.auth_bypass', true), 'off') = 'on' $$;

-- --------------------------------------------------- strict tenant tables
-- Reachable only inside a tenant scope. No bypass exists, for any caller.

ALTER TABLE "branch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branch" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "branch"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "user_branch_role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_branch_role" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user_branch_role"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_log"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ------------------------------------------- tenant tables the login needs
-- Same isolation, plus a second permissive policy that only opens when the
-- transaction has explicitly asked for it.

ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY auth_bypass ON "user"
  USING      (app_auth_bypass())
  WITH CHECK (app_auth_bypass());

ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "session"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY auth_bypass ON "session"
  USING      (app_auth_bypass())
  WITH CHECK (app_auth_bypass());

ALTER TABLE "password_reset_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_token" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "password_reset_token"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY auth_bypass ON "password_reset_token"
  USING      (app_auth_bypass())
  WITH CHECK (app_auth_bypass());

ALTER TABLE "trusted_device" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trusted_device" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "trusted_device"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY auth_bypass ON "trusted_device"
  USING      (app_auth_bypass())
  WITH CHECK (app_auth_bypass());

ALTER TABLE "mfa_replay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_replay" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mfa_replay"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY auth_bypass ON "mfa_replay"
  USING      (app_auth_bypass())
  WITH CHECK (app_auth_bypass());

-- ------------------------------------------------------------ the tenant
-- Not tenant-scoped by a column: it is the tenant. A tenant-scoped
-- transaction may see its own row and no other.

ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant"
  USING      (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());
CREATE POLICY auth_bypass ON "tenant"
  USING      (app_auth_bypass())
  WITH CHECK (app_auth_bypass());

-- `login_attempt` is deliberately left without row-level security: an attempt
-- may never resolve to a tenant at all, and the rate limiter has to count
-- attempts before it knows who is knocking. It holds no clinical data. The
-- isolation test asserts this exception explicitly rather than tolerating it.

-- --------------------------------------------------- case-insensitive email
-- The application lower-cases every address at the boundary. This makes it a
-- database guarantee as well, so two accounts cannot differ only by case.
CREATE UNIQUE INDEX user_tenant_email_lower_key ON "user" (tenant_id, lower(email));

-- --------------------------------------------------- audit trail is final
-- AUD-R-01. No application path, and no platform-scope path, may rewrite
-- history. Retention deletion is a deliberate act: drop this trigger in a
-- change window, with the reason recorded.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_IMMUTABLE: audit_log rows cannot be % ',
    lower(TG_OP) USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ------------------------------------------------ last administrator alive
-- IAM-R-05. The service also enforces this while holding a row lock on the
-- tenant, which is what makes it correct under concurrency; this is the
-- backstop for anything that bypasses the service.
CREATE OR REPLACE FUNCTION assert_tenant_keeps_an_admin() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  remaining integer;
BEGIN
  IF TG_TABLE_NAME = 'user' THEN
    IF OLD.status <> 'ACTIVE' OR NEW.status = 'ACTIVE' THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM user_branch_role r WHERE r.user_id = OLD.id AND r.role = 'ADMIN') THEN
      RETURN NEW;
    END IF;
    SELECT count(DISTINCT u.id) INTO remaining
      FROM "user" u
      JOIN user_branch_role r ON r.user_id = u.id
     WHERE u.tenant_id = OLD.tenant_id
       AND u.status = 'ACTIVE'
       AND r.role = 'ADMIN'
       AND u.id <> OLD.id;
    IF remaining = 0 THEN
      RAISE EXCEPTION 'LAST_ADMIN: a tenant must keep at least one active administrator'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- user_branch_role, on delete
  IF OLD.role <> 'ADMIN' THEN
    RETURN OLD;
  END IF;
  SELECT count(DISTINCT u.id) INTO remaining
    FROM "user" u
    JOIN user_branch_role r ON r.user_id = u.id
   WHERE u.tenant_id = OLD.tenant_id
     AND u.status = 'ACTIVE'
     AND r.role = 'ADMIN'
     AND r.id <> OLD.id;
  IF remaining = 0 THEN
    RAISE EXCEPTION 'LAST_ADMIN: a tenant must keep at least one active administrator'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER user_keeps_an_admin
  BEFORE UPDATE ON "user"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_keeps_an_admin();

CREATE TRIGGER role_keeps_an_admin
  BEFORE DELETE ON "user_branch_role"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_keeps_an_admin();
