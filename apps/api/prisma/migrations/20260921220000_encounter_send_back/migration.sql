-- ENC-F-24: every station can send a patient back.
--
-- A pharmacist who reads a dose that cannot be right, a nurse who called
-- the wrong name, a cashier holding a bill for a procedure that did not
-- happen — each of them has to be able to put the patient back where the
-- problem can be fixed. Until now the only way out of those states was
-- forwards, or an administrator forcing a move, and a clinic that cannot
-- go backwards in the application goes backwards in the corridor instead.
-- Then the queue and the record disagree.
--
-- The backstop learns the same moves. It stays the looser of the two: the
-- service decides who may do this and demands a reason for the ones that
-- cross a station, and the trigger only insists the result is a state that
-- exists. `transitions.spec.ts` compares the two lists and fails if this
-- one is missing anything the code allows.

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
    -- Sending somebody back. All of these land on the doctor's *queue*
    -- rather than in consultation: putting a patient straight into
    -- consultation would assert the doctor is with them, and they are not.
    ('TRIAGE_IN_PROGRESS', 'TRIAGE_WAITING'),
    ('PROCEDURE_WAITING', 'DOCTOR_WAITING'),
    ('PROCEDURE_DONE', 'DOCTOR_WAITING'),
    ('PHARMACY_WAITING', 'DOCTOR_WAITING'),
    ('DISPENSING', 'PHARMACY_WAITING'),
    ('DISPENSING', 'DOCTOR_WAITING'),
    ('PAYMENT_WAITING', 'DOCTOR_WAITING'),
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
