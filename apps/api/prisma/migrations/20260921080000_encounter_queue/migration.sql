-- Encounter & Queue (ENC, v0-04-encounter-queue.md).
--
-- An encounter is one visit. The queue is the same row seen from the waiting
-- room. Three things here are not ordinary table creation: the partial
-- unique index that allows one open visit per patient per branch, the
-- trigger that refuses an invalid status change made outside the
-- application, and row-level security on all five tables.

-- CreateEnum
CREATE TYPE "EncounterType" AS ENUM ('WALK_IN', 'APPOINTMENT', 'FOLLOW_UP', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "EncounterStatus" AS ENUM ('REGISTERED', 'TRIAGE_WAITING', 'TRIAGE_IN_PROGRESS', 'DOCTOR_WAITING', 'IN_CONSULTATION', 'PROCEDURE_WAITING', 'PROCEDURE_DONE', 'PHARMACY_WAITING', 'DISPENSING', 'PAYMENT_WAITING', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "EncounterPriority" AS ENUM ('NORMAL', 'URGENT', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "RoomType" AS ENUM ('CONSULT', 'TRIAGE', 'PROCEDURE', 'OTHER');

-- DropIndex
DROP INDEX "patient_name_trgm_idx";

-- DropIndex
DROP INDEX "patient_recent_lookup_idx";

-- CreateTable
CREATE TABLE "encounter" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_no" VARCHAR(40) NOT NULL,
    "queue_no" VARCHAR(20) NOT NULL,
    "type" "EncounterType" NOT NULL,
    "status" "EncounterStatus" NOT NULL,
    "priority" "EncounterPriority" NOT NULL DEFAULT 'NORMAL',
    "priority_reason" VARCHAR(300),
    "attending_doctor_id" UUID,
    "room_id" UUID,
    "registered_by" UUID NOT NULL,
    "registered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_since" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "called_at" TIMESTAMPTZ(3),
    "call_count" INTEGER NOT NULL DEFAULT 0,
    "skip_count" INTEGER NOT NULL DEFAULT 0,
    "triage_at" TIMESTAMPTZ(3),
    "consultation_started_at" TIMESTAMPTZ(3),
    "consultation_ended_at" TIMESTAMPTZ(3),
    "dispensed_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "cancelled_by" UUID,
    "reopened_at" TIMESTAMPTZ(3),
    "reopened_by" UUID,
    "reopen_reason" VARCHAR(500),
    "follow_up_due" DATE,
    "follow_up_note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "encounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "from_status" VARCHAR(30),
    "to_status" VARCHAR(30) NOT NULL,
    "action" VARCHAR(20) NOT NULL,
    "actor_id" UUID,
    "actor_name" VARCHAR(120) NOT NULL,
    "note" VARCHAR(500),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encounter_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_room" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "type" "RoomType" NOT NULL DEFAULT 'CONSULT',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branch_room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_sequence" (
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "prefix" VARCHAR(8) NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "queue_sequence_pkey" PRIMARY KEY ("tenant_id","branch_id","day","prefix")
);

-- CreateTable
CREATE TABLE "display_token" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "display_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "encounter_queue_idx" ON "encounter"("tenant_id", "branch_id", "status", "priority", "status_since");

-- CreateIndex
CREATE INDEX "encounter_patient_idx" ON "encounter"("tenant_id", "patient_id", "registered_at");

-- CreateIndex
CREATE INDEX "encounter_branch_day_idx" ON "encounter"("tenant_id", "branch_id", "registered_at");

-- CreateIndex
CREATE INDEX "encounter_doctor_idx" ON "encounter"("tenant_id", "attending_doctor_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_tenant_no_key" ON "encounter"("tenant_id", "encounter_no");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_id_tenant_key" ON "encounter"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "encounter_event_timeline_idx" ON "encounter_event"("tenant_id", "encounter_id", "occurred_at");

-- CreateIndex
CREATE INDEX "encounter_event_time_idx" ON "encounter_event"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "branch_room_branch_idx" ON "branch_room"("tenant_id", "branch_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "branch_room_code_key" ON "branch_room"("tenant_id", "branch_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "branch_room_id_tenant_key" ON "branch_room"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "display_token_branch_idx" ON "display_token"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "display_token_hash_key" ON "display_token"("token_hash");

-- CreateIndex
CREATE INDEX "patient_recent_lookup_idx" ON "patient_recent"("tenant_id", "user_id", "branch_id", "opened_at");

-- RenameForeignKey
ALTER TABLE "patient_recent" RENAME CONSTRAINT "patient_recent_patient_fkey" TO "patient_recent_patient_id_tenant_id_fkey";

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_branch_id_tenant_id_fkey" FOREIGN KEY ("branch_id", "tenant_id") REFERENCES "branch"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_patient_id_tenant_id_fkey" FOREIGN KEY ("patient_id", "tenant_id") REFERENCES "patient"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_room_id_tenant_id_fkey" FOREIGN KEY ("room_id", "tenant_id") REFERENCES "branch_room"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "encounter_event" ADD CONSTRAINT "encounter_event_encounter_id_tenant_id_fkey" FOREIGN KEY ("encounter_id", "tenant_id") REFERENCES "encounter"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "branch_room" ADD CONSTRAINT "branch_room_branch_id_tenant_id_fkey" FOREIGN KEY ("branch_id", "tenant_id") REFERENCES "branch"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "display_token" ADD CONSTRAINT "display_token_branch_id_tenant_id_fkey" FOREIGN KEY ("branch_id", "tenant_id") REFERENCES "branch"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- --------------------------------------------------------------------------
-- One open encounter per patient per branch (ENC-R-06)
--
-- Partial, because the rule is about *open* visits: the same patient comes
-- back next week, and both rows have to coexist. Closed, cancelled and
-- no-show encounters are out of scope of the constraint, which is what makes
-- it a partial index rather than a check.
-- --------------------------------------------------------------------------
CREATE UNIQUE INDEX encounter_one_open_per_branch
  ON "encounter" ("tenant_id", "patient_id", "branch_id")
  WHERE "status" NOT IN ('COMPLETED', 'CANCELLED', 'NO_SHOW');

-- --------------------------------------------------------------------------
-- The transition table, in the database (ENC-R-01, ENC-T-10)
--
-- The application owns this rule and enforces it first, with a better error
-- message and the branch's own settings in hand. This is the backstop: it
-- catches a direct UPDATE from a psql prompt, a migration that means well,
-- and any future code path that writes `status` without going through
-- `EncounterService.transition()`.
--
-- It deliberately does not know about branch settings. Where the two differ
-- the application is stricter, and a backstop that is stricter than the
-- thing it backs up would reject work that is legitimately allowed.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION encounter_allowed_transition(from_status text, to_status text)
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT (from_status, to_status) IN (
    -- Checking in, and the two ways past reception.
    ('REGISTERED', 'TRIAGE_WAITING'),
    ('REGISTERED', 'DOCTOR_WAITING'),
    -- Triage.
    ('TRIAGE_WAITING', 'TRIAGE_IN_PROGRESS'),
    ('TRIAGE_IN_PROGRESS', 'DOCTOR_WAITING'),
    -- Consultation, and everything it can route to.
    ('DOCTOR_WAITING', 'IN_CONSULTATION'),
    ('IN_CONSULTATION', 'DOCTOR_WAITING'),          -- called the wrong patient
    ('IN_CONSULTATION', 'PROCEDURE_WAITING'),
    ('IN_CONSULTATION', 'PHARMACY_WAITING'),
    ('IN_CONSULTATION', 'PAYMENT_WAITING'),
    ('IN_CONSULTATION', 'COMPLETED'),               -- nothing to charge for
    -- Procedures.
    ('PROCEDURE_WAITING', 'PROCEDURE_DONE'),
    ('PROCEDURE_DONE', 'PHARMACY_WAITING'),
    ('PROCEDURE_DONE', 'PAYMENT_WAITING'),
    ('PROCEDURE_DONE', 'COMPLETED'),
    -- Dispensing, and payment. Both orders are legal here, because the
    -- branch setting decides which one a given clinic uses.
    ('PHARMACY_WAITING', 'DISPENSING'),
    ('DISPENSING', 'PAYMENT_WAITING'),
    ('DISPENSING', 'COMPLETED'),
    ('PAYMENT_WAITING', 'PHARMACY_WAITING'),
    ('PAYMENT_WAITING', 'COMPLETED'),
    -- Leaving without being seen.
    ('REGISTERED', 'CANCELLED'),
    ('TRIAGE_WAITING', 'CANCELLED'),
    ('TRIAGE_IN_PROGRESS', 'CANCELLED'),
    ('DOCTOR_WAITING', 'CANCELLED'),
    ('DOCTOR_WAITING', 'NO_SHOW'),
    ('TRIAGE_WAITING', 'NO_SHOW'),
    ('PHARMACY_WAITING', 'NO_SHOW'),
    ('PAYMENT_WAITING', 'NO_SHOW'),
    -- Coming back the same day, and an administrator reopening a visit
    -- closed by mistake.
    ('NO_SHOW', 'DOCTOR_WAITING'),
    ('COMPLETED', 'PAYMENT_WAITING'),
    ('COMPLETED', 'PHARMACY_WAITING'),
    ('COMPLETED', 'IN_CONSULTATION')
  );
$$;

CREATE OR REPLACE FUNCTION encounter_status_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT encounter_allowed_transition(OLD.status::text, NEW.status::text) THEN
    RAISE EXCEPTION
      'An encounter cannot go from % to %. Status changes belong to EncounterService.transition() (ENC-R-01).',
      OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- ENC-R-03: the queue is ordered by this, so a status change that left it
  -- behind would put the patient in the wrong place in the queue.
  IF NEW.status_since = OLD.status_since THEN
    RAISE EXCEPTION
      'status_since must move when status does (ENC-R-03).'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER encounter_status_guard_trigger
  BEFORE UPDATE OF status ON "encounter"
  FOR EACH ROW EXECUTE FUNCTION encounter_status_guard();

-- --------------------------------------------------------------------------
-- The timeline is append-only (ENC-F-04)
--
-- Same reasoning as the audit trail: a record of what happened, in what
-- order, is worthless if it can be tidied up afterwards.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION encounter_event_append_only() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'encounter_event is append-only: % is not permitted.', TG_OP;
END
$$;

CREATE TRIGGER encounter_event_no_update
  BEFORE UPDATE ON "encounter_event"
  FOR EACH ROW EXECUTE FUNCTION encounter_event_append_only();

CREATE TRIGGER encounter_event_no_delete
  BEFORE DELETE ON "encounter_event"
  FOR EACH ROW EXECUTE FUNCTION encounter_event_append_only();

-- --------------------------------------------------------------------------
-- Row-level security (TEN-F-11)
--
-- The display token table is included. A waiting-room screen authenticates
-- with a token rather than a session, and resolving it still happens inside
-- the clinic's own scope.
-- --------------------------------------------------------------------------
ALTER TABLE "encounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "encounter" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "encounter"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "encounter_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "encounter_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "encounter_event"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "branch_room" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branch_room" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "branch_room"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "queue_sequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "queue_sequence" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "queue_sequence"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- The display token is the one exception to "no bypass outside identity".
-- A screen in the waiting room presents a token and no session, so the
-- lookup that turns it into a branch has to happen before any tenant is
-- known. It is narrow: the bypass reads this table and nothing else, and the
-- request switches into the tenant's own scope immediately afterwards.
ALTER TABLE "display_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "display_token" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "display_token"
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY auth_bypass ON "display_token"
  USING      (app_auth_bypass())
  WITH CHECK (app_auth_bypass());
