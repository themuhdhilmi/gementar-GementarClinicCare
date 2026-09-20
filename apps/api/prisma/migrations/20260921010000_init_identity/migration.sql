-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "BranchStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED', 'LOCKED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'DOCTOR', 'NURSE', 'FRONTDESK');

-- CreateEnum
CREATE TYPE "TokenPurpose" AS ENUM ('RESET', 'INVITE');

-- CreateEnum
CREATE TYPE "LoginOutcome" AS ENUM ('SUCCESS', 'BAD_CREDENTIALS', 'UNKNOWN_EMAIL', 'AMBIGUOUS_EMAIL', 'NOT_LOGINABLE', 'RATE_LIMITED', 'MFA_FAILED');

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "status" "TenantStatus" NOT NULL,
    "plan" VARCHAR(40) NOT NULL DEFAULT 'pilot',
    "timezone" VARCHAR(60) NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
    "currency" CHAR(3) NOT NULL DEFAULT 'MYR',
    "settings" JSONB NOT NULL,
    "modules" JSONB NOT NULL,
    "tin" VARCHAR(40),
    "business_reg_no" VARCHAR(40),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "address_line1" VARCHAR(200),
    "address_line2" VARCHAR(200),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "postcode" VARCHAR(20),
    "phone" VARCHAR(32),
    "email" VARCHAR(254),
    "licence_no" VARCHAR(60),
    "timezone" VARCHAR(60),
    "operating_hours" JSONB NOT NULL,
    "settings" JSONB NOT NULL,
    "letterhead" JSONB,
    "status" "BranchStatus" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(255),
    "name" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(32),
    "status" "UserStatus" NOT NULL,
    "locked_until" TIMESTAMPTZ(3),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "mfa_secret_enc" BYTEA,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_recovery_enc" BYTEA,
    "mfa_enrolled_at" TIMESTAMPTZ(3),
    "permission_version" INTEGER NOT NULL DEFAULT 1,
    "last_login_at" TIMESTAMPTZ(3),
    "default_branch_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_branch_role" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "user_branch_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "active_branch_id" UUID NOT NULL,
    "permission_version" INTEGER NOT NULL,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "reauth_at" TIMESTAMPTZ(3),
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(120),

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_token" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "purpose" "TokenPurpose" NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trusted_device" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "label" VARCHAR(200),
    "last_seen_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_replay" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "time_step" BIGINT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_replay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempt" (
    "id" UUID NOT NULL,
    "email_key" VARCHAR(254) NOT NULL,
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "outcome" "LoginOutcome" NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID,
    "attempted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "actor_id" UUID,
    "actor_name" VARCHAR(120) NOT NULL,
    "actor_role" VARCHAR(40),
    "action" VARCHAR(80) NOT NULL,
    "entity_type" VARCHAR(60) NOT NULL,
    "entity_id" UUID,
    "subject_patient_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "diff" JSONB,
    "reason" VARCHAR(500),
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "request_id" VARCHAR(64),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "tenant_status_idx" ON "tenant"("status");

-- CreateIndex
CREATE INDEX "branch_tenant_status_idx" ON "branch"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "branch_tenant_code_key" ON "branch"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "branch_id_tenant_key" ON "branch"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "user_tenant_status_idx" ON "user"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "user_email_idx" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_default_branch_idx" ON "user"("default_branch_id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenant_email_key" ON "user"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "user_id_tenant_key" ON "user"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "ubr_branch_role_idx" ON "user_branch_role"("branch_id", "role");

-- CreateIndex
CREATE INDEX "ubr_tenant_role_idx" ON "user_branch_role"("tenant_id", "role");

-- CreateIndex
CREATE INDEX "ubr_branch_tenant_idx" ON "user_branch_role"("branch_id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ubr_user_branch_role_key" ON "user_branch_role"("user_id", "branch_id", "role");

-- CreateIndex
CREATE INDEX "session_user_revoked_idx" ON "session"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "session_expires_idx" ON "session"("expires_at");

-- CreateIndex
CREATE INDEX "session_tenant_user_idx" ON "session"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "session_branch_tenant_idx" ON "session"("active_branch_id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "prt_user_used_idx" ON "password_reset_token"("user_id", "used_at");

-- CreateIndex
CREATE INDEX "prt_expires_idx" ON "password_reset_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "prt_token_hash_key" ON "password_reset_token"("token_hash");

-- CreateIndex
CREATE INDEX "td_user_revoked_idx" ON "trusted_device"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "td_expires_idx" ON "trusted_device"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "td_token_hash_key" ON "trusted_device"("token_hash");

-- CreateIndex
CREATE INDEX "mfa_replay_expires_idx" ON "mfa_replay"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_replay_user_step_key" ON "mfa_replay"("user_id", "time_step");

-- CreateIndex
CREATE INDEX "login_attempt_email_time_idx" ON "login_attempt"("email_key", "attempted_at");

-- CreateIndex
CREATE INDEX "login_attempt_ip_time_idx" ON "login_attempt"("ip", "attempted_at");

-- CreateIndex
CREATE INDEX "login_attempt_time_idx" ON "login_attempt"("attempted_at");

-- CreateIndex
CREATE INDEX "audit_tenant_time_idx" ON "audit_log"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_tenant_actor_time_idx" ON "audit_log"("tenant_id", "actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_tenant_patient_time_idx" ON "audit_log"("tenant_id", "subject_patient_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_tenant_entity_idx" ON "audit_log"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_tenant_action_time_idx" ON "audit_log"("tenant_id", "action", "occurred_at");

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_default_branch_id_tenant_id_fkey" FOREIGN KEY ("default_branch_id", "tenant_id") REFERENCES "branch"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_branch_role" ADD CONSTRAINT "user_branch_role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_branch_role" ADD CONSTRAINT "user_branch_role_user_id_tenant_id_fkey" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "user"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_branch_role" ADD CONSTRAINT "user_branch_role_branch_id_tenant_id_fkey" FOREIGN KEY ("branch_id", "tenant_id") REFERENCES "branch"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_tenant_id_fkey" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "user"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_active_branch_id_tenant_id_fkey" FOREIGN KEY ("active_branch_id", "tenant_id") REFERENCES "branch"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_user_id_tenant_id_fkey" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "user"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "trusted_device" ADD CONSTRAINT "trusted_device_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "trusted_device" ADD CONSTRAINT "trusted_device_user_id_tenant_id_fkey" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "user"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mfa_replay" ADD CONSTRAINT "mfa_replay_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mfa_replay" ADD CONSTRAINT "mfa_replay_user_id_tenant_id_fkey" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "user"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
