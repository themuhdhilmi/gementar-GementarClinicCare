-- ENC-R-09 and §14: the administrator's recovery hatch, in the backstop too.
--
-- A visit cannot be cancelled once the consultation has begun. That rule is
-- right, and it is the application that enforces it. But a patient who walks
-- out halfway through still has to come off the board, and the answer has to
-- be an administrator saying so in writing rather than somebody editing the
-- database directly.
--
-- So the trigger learns the same recovery moves the service does. It stays
-- the looser of the two, which is the correct relationship between a rule
-- and its backstop: the service decides who may do this and demands a
-- reason, and the trigger only insists the result is a state that exists.
--
-- `transitions.spec.ts` compares the two lists and fails if this one is
-- missing anything the code allows.

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
    ('IN_CONSULTATION', 'DOCTOR_WAITING'),
    ('IN_CONSULTATION', 'PROCEDURE_WAITING'),
    ('IN_CONSULTATION', 'PHARMACY_WAITING'),
    ('IN_CONSULTATION', 'PAYMENT_WAITING'),
    ('IN_CONSULTATION', 'COMPLETED'),
    -- Procedures.
    ('PROCEDURE_WAITING', 'PROCEDURE_DONE'),
    ('PROCEDURE_DONE', 'PHARMACY_WAITING'),
    ('PROCEDURE_DONE', 'PAYMENT_WAITING'),
    ('PROCEDURE_DONE', 'COMPLETED'),
    -- Dispensing and payment, in either order.
    ('PHARMACY_WAITING', 'DISPENSING'),
    ('DISPENSING', 'PAYMENT_WAITING'),
    ('DISPENSING', 'COMPLETED'),
    ('PAYMENT_WAITING', 'PHARMACY_WAITING'),
    ('PAYMENT_WAITING', 'COMPLETED'),
    -- Leaving before being seen.
    ('REGISTERED', 'CANCELLED'),
    ('TRIAGE_WAITING', 'CANCELLED'),
    ('TRIAGE_IN_PROGRESS', 'CANCELLED'),
    ('DOCTOR_WAITING', 'CANCELLED'),
    ('DOCTOR_WAITING', 'NO_SHOW'),
    ('TRIAGE_WAITING', 'NO_SHOW'),
    ('PHARMACY_WAITING', 'NO_SHOW'),
    ('PAYMENT_WAITING', 'NO_SHOW'),
    -- Coming back, and reopening.
    ('NO_SHOW', 'DOCTOR_WAITING'),
    ('COMPLETED', 'PAYMENT_WAITING'),
    ('COMPLETED', 'PHARMACY_WAITING'),
    ('COMPLETED', 'IN_CONSULTATION'),
    -- Recovery. Administrator only, with a reason, and audited loudly. The
    -- service will not offer these on any screen.
    ('IN_CONSULTATION', 'CANCELLED'),
    ('PROCEDURE_WAITING', 'CANCELLED'),
    ('PROCEDURE_WAITING', 'COMPLETED'),
    ('PROCEDURE_DONE', 'CANCELLED'),
    ('PHARMACY_WAITING', 'CANCELLED'),
    ('PHARMACY_WAITING', 'COMPLETED'),
    ('DISPENSING', 'CANCELLED'),
    ('PAYMENT_WAITING', 'CANCELLED'),
    ('REGISTERED', 'COMPLETED'),
    ('TRIAGE_WAITING', 'COMPLETED'),
    ('TRIAGE_IN_PROGRESS', 'COMPLETED'),
    ('DOCTOR_WAITING', 'COMPLETED')
  );
$$;
