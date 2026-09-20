-- CreateTable
CREATE TABLE `tenant` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `slug` VARCHAR(60) NOT NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'CLOSED') NOT NULL,
    `plan` VARCHAR(40) NOT NULL DEFAULT 'pilot',
    `timezone` VARCHAR(60) NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
    `currency` CHAR(3) NOT NULL DEFAULT 'MYR',
    `settings` JSON NOT NULL,
    `modules` JSON NOT NULL,
    `tin` VARCHAR(40) NULL,
    `business_reg_no` VARCHAR(40) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `tenant_slug_key`(`slug`),
    INDEX `tenant_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `branch` (
    `id` CHAR(36) NOT NULL,
    `tenant_id` CHAR(36) NOT NULL,
    `code` VARCHAR(16) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `address_line1` VARCHAR(200) NULL,
    `address_line2` VARCHAR(200) NULL,
    `city` VARCHAR(100) NULL,
    `state` VARCHAR(100) NULL,
    `postcode` VARCHAR(20) NULL,
    `phone` VARCHAR(32) NULL,
    `email` VARCHAR(254) NULL,
    `licence_no` VARCHAR(60) NULL,
    `timezone` VARCHAR(60) NULL,
    `operating_hours` JSON NOT NULL,
    `settings` JSON NOT NULL,
    `letterhead` JSON NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `branch_tenant_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `branch_tenant_code_key`(`tenant_id`, `code`),
    UNIQUE INDEX `branch_id_tenant_key`(`id`, `tenant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user` (
    `id` CHAR(36) NOT NULL,
    `tenant_id` CHAR(36) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `password_hash` VARCHAR(255) NULL,
    `name` VARCHAR(120) NOT NULL,
    `phone` VARCHAR(32) NULL,
    `status` ENUM('INVITED', 'ACTIVE', 'DISABLED', 'LOCKED') NOT NULL,
    `locked_until` DATETIME(3) NULL,
    `failed_attempts` INTEGER NOT NULL DEFAULT 0,
    `mfa_secret_enc` VARBINARY(1024) NULL,
    `mfa_enabled` BOOLEAN NOT NULL DEFAULT false,
    `mfa_recovery_enc` VARBINARY(4096) NULL,
    `mfa_enrolled_at` DATETIME(3) NULL,
    `permission_version` INTEGER NOT NULL DEFAULT 1,
    `last_login_at` DATETIME(3) NULL,
    `default_branch_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `user_tenant_status_idx`(`tenant_id`, `status`),
    INDEX `user_email_idx`(`email`),
    INDEX `user_default_branch_idx`(`default_branch_id`, `tenant_id`),
    UNIQUE INDEX `user_tenant_email_key`(`tenant_id`, `email`),
    UNIQUE INDEX `user_id_tenant_key`(`id`, `tenant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_branch_role` (
    `id` CHAR(36) NOT NULL,
    `tenant_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `role` ENUM('ADMIN', 'DOCTOR', 'NURSE', 'FRONTDESK') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `ubr_branch_role_idx`(`branch_id`, `role`),
    INDEX `ubr_tenant_role_idx`(`tenant_id`, `role`),
    INDEX `ubr_branch_tenant_idx`(`branch_id`, `tenant_id`),
    UNIQUE INDEX `ubr_user_branch_role_key`(`user_id`, `branch_id`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `session` (
    `id` CHAR(36) NOT NULL,
    `tenant_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `token_hash` BINARY(32) NOT NULL,
    `active_branch_id` CHAR(36) NOT NULL,
    `permission_version` INTEGER NOT NULL,
    `mfa_verified` BOOLEAN NOT NULL DEFAULT false,
    `reauth_at` DATETIME(3) NULL,
    `ip` VARCHAR(45) NULL,
    `user_agent` VARCHAR(512) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoked_reason` VARCHAR(120) NULL,

    INDEX `session_user_revoked_idx`(`user_id`, `revoked_at`),
    INDEX `session_expires_idx`(`expires_at`),
    INDEX `session_tenant_user_idx`(`tenant_id`, `user_id`),
    INDEX `session_branch_tenant_idx`(`active_branch_id`, `tenant_id`),
    UNIQUE INDEX `session_token_hash_key`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `password_reset_token` (
    `id` CHAR(36) NOT NULL,
    `tenant_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `token_hash` BINARY(32) NOT NULL,
    `purpose` ENUM('RESET', 'INVITE') NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` CHAR(36) NULL,

    INDEX `prt_user_used_idx`(`user_id`, `used_at`),
    INDEX `prt_expires_idx`(`expires_at`),
    UNIQUE INDEX `prt_token_hash_key`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trusted_device` (
    `id` CHAR(36) NOT NULL,
    `tenant_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `token_hash` BINARY(32) NOT NULL,
    `label` VARCHAR(200) NULL,
    `last_seen_at` DATETIME(3) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `td_user_revoked_idx`(`user_id`, `revoked_at`),
    INDEX `td_expires_idx`(`expires_at`),
    UNIQUE INDEX `td_token_hash_key`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mfa_replay` (
    `id` CHAR(36) NOT NULL,
    `tenant_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `time_step` BIGINT NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `mfa_replay_expires_idx`(`expires_at`),
    UNIQUE INDEX `mfa_replay_user_step_key`(`user_id`, `time_step`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `login_attempt` (
    `id` CHAR(36) NOT NULL,
    `email_key` VARCHAR(254) NOT NULL,
    `ip` VARCHAR(45) NULL,
    `user_agent` VARCHAR(512) NULL,
    `outcome` ENUM('SUCCESS', 'BAD_CREDENTIALS', 'UNKNOWN_EMAIL', 'AMBIGUOUS_EMAIL', 'NOT_LOGINABLE', 'RATE_LIMITED', 'MFA_FAILED') NOT NULL,
    `tenant_id` CHAR(36) NULL,
    `user_id` CHAR(36) NULL,
    `attempted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `login_attempt_email_time_idx`(`email_key`, `attempted_at`),
    INDEX `login_attempt_ip_time_idx`(`ip`, `attempted_at`),
    INDEX `login_attempt_time_idx`(`attempted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log` (
    `id` CHAR(36) NOT NULL,
    `tenant_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NULL,
    `actor_id` CHAR(36) NULL,
    `actor_name` VARCHAR(120) NOT NULL,
    `actor_role` VARCHAR(40) NULL,
    `action` VARCHAR(80) NOT NULL,
    `entity_type` VARCHAR(60) NOT NULL,
    `entity_id` CHAR(36) NULL,
    `subject_patient_id` CHAR(36) NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `diff` JSON NULL,
    `reason` VARCHAR(500) NULL,
    `ip` VARCHAR(45) NULL,
    `user_agent` VARCHAR(512) NULL,
    `request_id` VARCHAR(64) NULL,
    `occurred_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_tenant_time_idx`(`tenant_id`, `occurred_at`),
    INDEX `audit_tenant_actor_time_idx`(`tenant_id`, `actor_id`, `occurred_at`),
    INDEX `audit_tenant_patient_time_idx`(`tenant_id`, `subject_patient_id`, `occurred_at`),
    INDEX `audit_tenant_entity_idx`(`tenant_id`, `entity_type`, `entity_id`),
    INDEX `audit_tenant_action_time_idx`(`tenant_id`, `action`, `occurred_at`),
    INDEX `audit_branch_tenant_idx`(`branch_id`, `tenant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `branch` ADD CONSTRAINT `branch_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `user` ADD CONSTRAINT `user_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `user` ADD CONSTRAINT `user_default_branch_id_tenant_id_fkey` FOREIGN KEY (`default_branch_id`, `tenant_id`) REFERENCES `branch`(`id`, `tenant_id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `user_branch_role` ADD CONSTRAINT `user_branch_role_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `user_branch_role` ADD CONSTRAINT `user_branch_role_user_id_tenant_id_fkey` FOREIGN KEY (`user_id`, `tenant_id`) REFERENCES `user`(`id`, `tenant_id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `user_branch_role` ADD CONSTRAINT `user_branch_role_branch_id_tenant_id_fkey` FOREIGN KEY (`branch_id`, `tenant_id`) REFERENCES `branch`(`id`, `tenant_id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `session` ADD CONSTRAINT `session_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `session` ADD CONSTRAINT `session_user_id_tenant_id_fkey` FOREIGN KEY (`user_id`, `tenant_id`) REFERENCES `user`(`id`, `tenant_id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `session` ADD CONSTRAINT `session_active_branch_id_tenant_id_fkey` FOREIGN KEY (`active_branch_id`, `tenant_id`) REFERENCES `branch`(`id`, `tenant_id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `password_reset_token` ADD CONSTRAINT `password_reset_token_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `password_reset_token` ADD CONSTRAINT `password_reset_token_user_id_tenant_id_fkey` FOREIGN KEY (`user_id`, `tenant_id`) REFERENCES `user`(`id`, `tenant_id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `trusted_device` ADD CONSTRAINT `trusted_device_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `trusted_device` ADD CONSTRAINT `trusted_device_user_id_tenant_id_fkey` FOREIGN KEY (`user_id`, `tenant_id`) REFERENCES `user`(`id`, `tenant_id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `mfa_replay` ADD CONSTRAINT `mfa_replay_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `mfa_replay` ADD CONSTRAINT `mfa_replay_user_id_tenant_id_fkey` FOREIGN KEY (`user_id`, `tenant_id`) REFERENCES `user`(`id`, `tenant_id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_branch_id_tenant_id_fkey` FOREIGN KEY (`branch_id`, `tenant_id`) REFERENCES `branch`(`id`, `tenant_id`) ON DELETE RESTRICT ON UPDATE NO ACTION;
