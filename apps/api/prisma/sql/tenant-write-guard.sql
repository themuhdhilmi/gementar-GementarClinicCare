-- Gementar ClinicCare — database-level tenant write guards (MySQL 8)
--
-- WHY THIS FILE EXISTS
-- The planning documents specify Postgres row-level security as the second,
-- independent layer of tenant isolation. MySQL has no RLS. These triggers are
-- the closest equivalent for writes: they reject any INSERT, UPDATE or DELETE
-- on a tenant-owned table whose tenant_id disagrees with the connection's
-- @app_tenant_id, which the application sets at the start of every unit of work
-- (see src/shared/prisma/db.service.ts). Reads are filtered by the Prisma
-- extension in src/shared/prisma/tenant-scope.ts.
--
-- HOW TO INSTALL
-- Creating triggers needs privileges the application account does not have
-- (with binary logging on, MySQL requires SUPER or SET_USER_ID). Run this as a
-- DBA, once per environment, after migrations:
--
--     mysql -h HOST -u admin -p DATABASE < prisma/sql/tenant-write-guard.sql
--
-- The API checks on boot that they are present and warns, or refuses to start
-- when DB_GUARD_MODE=require.
--
-- HOW TO BYPASS, DELIBERATELY
-- Set @app_tenant_guard_off = 1 on the connection. The application does this
-- only in withPlatform() scopes: login resolution before the tenant is known,
-- the nightly cleanup job, and seeding.

DELIMITER $$

DROP TRIGGER IF EXISTS trg_branch_tenant_guard_ins$$
CREATE TRIGGER trg_branch_tenant_guard_ins BEFORE INSERT ON `branch`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: branch written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to branch rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_branch_tenant_guard_upd$$
CREATE TRIGGER trg_branch_tenant_guard_upd BEFORE UPDATE ON `branch`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: branch written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id OR OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to branch rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_branch_tenant_guard_del$$
CREATE TRIGGER trg_branch_tenant_guard_del BEFORE DELETE ON `branch`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: branch written with no tenant scope';
    END IF;
    IF OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to branch rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_user_tenant_guard_ins$$
CREATE TRIGGER trg_user_tenant_guard_ins BEFORE INSERT ON `user`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: user written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to user rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_user_tenant_guard_upd$$
CREATE TRIGGER trg_user_tenant_guard_upd BEFORE UPDATE ON `user`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: user written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id OR OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to user rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_user_tenant_guard_del$$
CREATE TRIGGER trg_user_tenant_guard_del BEFORE DELETE ON `user`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: user written with no tenant scope';
    END IF;
    IF OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to user rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_user_branch_role_tenant_guard_ins$$
CREATE TRIGGER trg_user_branch_role_tenant_guard_ins BEFORE INSERT ON `user_branch_role`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: user_branch_role written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to user_branch_role rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_user_branch_role_tenant_guard_upd$$
CREATE TRIGGER trg_user_branch_role_tenant_guard_upd BEFORE UPDATE ON `user_branch_role`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: user_branch_role written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id OR OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to user_branch_role rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_user_branch_role_tenant_guard_del$$
CREATE TRIGGER trg_user_branch_role_tenant_guard_del BEFORE DELETE ON `user_branch_role`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: user_branch_role written with no tenant scope';
    END IF;
    IF OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to user_branch_role rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_session_tenant_guard_ins$$
CREATE TRIGGER trg_session_tenant_guard_ins BEFORE INSERT ON `session`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: session written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to session rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_session_tenant_guard_upd$$
CREATE TRIGGER trg_session_tenant_guard_upd BEFORE UPDATE ON `session`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: session written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id OR OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to session rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_session_tenant_guard_del$$
CREATE TRIGGER trg_session_tenant_guard_del BEFORE DELETE ON `session`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: session written with no tenant scope';
    END IF;
    IF OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to session rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_password_reset_token_tenant_guard_ins$$
CREATE TRIGGER trg_password_reset_token_tenant_guard_ins BEFORE INSERT ON `password_reset_token`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: password_reset_token written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to password_reset_token rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_password_reset_token_tenant_guard_upd$$
CREATE TRIGGER trg_password_reset_token_tenant_guard_upd BEFORE UPDATE ON `password_reset_token`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: password_reset_token written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id OR OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to password_reset_token rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_password_reset_token_tenant_guard_del$$
CREATE TRIGGER trg_password_reset_token_tenant_guard_del BEFORE DELETE ON `password_reset_token`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: password_reset_token written with no tenant scope';
    END IF;
    IF OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to password_reset_token rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_trusted_device_tenant_guard_ins$$
CREATE TRIGGER trg_trusted_device_tenant_guard_ins BEFORE INSERT ON `trusted_device`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: trusted_device written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to trusted_device rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_trusted_device_tenant_guard_upd$$
CREATE TRIGGER trg_trusted_device_tenant_guard_upd BEFORE UPDATE ON `trusted_device`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: trusted_device written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id OR OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to trusted_device rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_trusted_device_tenant_guard_del$$
CREATE TRIGGER trg_trusted_device_tenant_guard_del BEFORE DELETE ON `trusted_device`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: trusted_device written with no tenant scope';
    END IF;
    IF OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to trusted_device rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_mfa_replay_tenant_guard_ins$$
CREATE TRIGGER trg_mfa_replay_tenant_guard_ins BEFORE INSERT ON `mfa_replay`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: mfa_replay written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to mfa_replay rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_mfa_replay_tenant_guard_upd$$
CREATE TRIGGER trg_mfa_replay_tenant_guard_upd BEFORE UPDATE ON `mfa_replay`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: mfa_replay written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id OR OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to mfa_replay rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_mfa_replay_tenant_guard_del$$
CREATE TRIGGER trg_mfa_replay_tenant_guard_del BEFORE DELETE ON `mfa_replay`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: mfa_replay written with no tenant scope';
    END IF;
    IF OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to mfa_replay rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_audit_log_tenant_guard_ins$$
CREATE TRIGGER trg_audit_log_tenant_guard_ins BEFORE INSERT ON `audit_log`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: audit_log written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to audit_log rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_audit_log_tenant_guard_upd$$
CREATE TRIGGER trg_audit_log_tenant_guard_upd BEFORE UPDATE ON `audit_log`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: audit_log written with no tenant scope';
    END IF;
    IF NEW.tenant_id <> @app_tenant_id OR OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to audit_log rejected';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_audit_log_tenant_guard_del$$
CREATE TRIGGER trg_audit_log_tenant_guard_del BEFORE DELETE ON `audit_log`
FOR EACH ROW
BEGIN
  IF COALESCE(@app_tenant_guard_off, 0) <> 1 THEN
    IF @app_tenant_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: audit_log written with no tenant scope';
    END IF;
    IF OLD.tenant_id <> @app_tenant_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TENANT_GUARD: cross-tenant write to audit_log rejected';
    END IF;
  END IF;
END$$

-- Audit trail immutability (AUD-R-01). No bypass: not even platform scope may
-- rewrite history. Deletion for retention is done by a DBA who drops these
-- triggers deliberately, in a change window, with the reason recorded.
DROP TRIGGER IF EXISTS trg_audit_log_immutable_upd$$
CREATE TRIGGER trg_audit_log_immutable_upd BEFORE UPDATE ON `audit_log`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AUDIT_IMMUTABLE: audit_log rows cannot be updated';
END$$

DROP TRIGGER IF EXISTS trg_audit_log_immutable_del$$
CREATE TRIGGER trg_audit_log_immutable_del BEFORE DELETE ON `audit_log`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AUDIT_IMMUTABLE: audit_log rows cannot be deleted';
END$$

-- Last-administrator invariant (IAM-R-05). The service also enforces this while
-- holding a row lock on the tenant, which is what makes it correct under
-- concurrency; this trigger is the backstop for anything that bypasses the
-- service.
DROP TRIGGER IF EXISTS trg_user_last_admin_upd$$
CREATE TRIGGER trg_user_last_admin_upd BEFORE UPDATE ON `user`
FOR EACH ROW
BEGIN
  IF OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE' THEN
    IF EXISTS (SELECT 1 FROM user_branch_role r WHERE r.user_id = OLD.id AND r.role = 'ADMIN') THEN
      IF (SELECT COUNT(DISTINCT u.id)
            FROM `user` u
            JOIN user_branch_role r ON r.user_id = u.id
           WHERE u.tenant_id = OLD.tenant_id
             AND u.status = 'ACTIVE'
             AND r.role = 'ADMIN'
             AND u.id <> OLD.id) = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'LAST_ADMIN: a tenant must keep at least one active administrator';
      END IF;
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_ubr_last_admin_del$$
CREATE TRIGGER trg_ubr_last_admin_del BEFORE DELETE ON `user_branch_role`
FOR EACH ROW
BEGIN
  IF OLD.role = 'ADMIN' THEN
    IF (SELECT COUNT(DISTINCT u.id)
          FROM `user` u
          JOIN user_branch_role r ON r.user_id = u.id
         WHERE u.tenant_id = OLD.tenant_id
           AND u.status = 'ACTIVE'
           AND r.role = 'ADMIN'
           AND r.id <> OLD.id) = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'LAST_ADMIN: a tenant must keep at least one active administrator';
    END IF;
  END IF;
END$$

DELIMITER ;

-- Verification. Expect 24 tenant guards plus 4 invariant triggers.
SELECT COUNT(*) AS tenant_guards
  FROM information_schema.triggers
 WHERE trigger_schema = DATABASE()
   AND trigger_name LIKE 'trg_%_tenant_guard_%';
