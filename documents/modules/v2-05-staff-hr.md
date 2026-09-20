# Staff & HR (HR)

| | |
|---|---|
| **Version** | V2 |
| **Status** | Not started |
| **Spec sections** | 23, 24 |
| **Depends on** | IAM, RBC, TEN, FIN, NTF, AUD |
| **Depended on by** | DRM, APT (schedules), BRN, ANL |
| **Est. effort** | ~80 h |

---

## 1. Purpose & business value

Employee records, rosters, attendance, leave, overtime, locums, commissions and claims — the operational HR a clinic chain needs, feeding payroll (external) and commission calculations (from FIN revenue attribution). Separate from IAM (logins) on purpose: an employee may have no login; a login may belong to a contractor.

## 2. Actors & permissions

| Action | ORG_ADMIN | HR role | BRANCH_MANAGER | Employee |
|---|:-:|:-:|:-:|:-:|
| `hr.manage` — employee records, contracts, documents | ✓ | ✓ | view own branch | own profile view |
| `roster.manage` | ✓ | ✓ | ✓ (own branch) | view own |
| `attendance.manage` — corrections, approvals | ✓ | ✓ | ✓ | clock in/out |
| `leave.approve` | ✓ | ✓ | ✓ (own branch) | apply |
| `commission.compute` / `claims.approve` | ✓ | ✓ | – | submit claims |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| HR-F-01 | Employee: personal details, IC, contact, emergency contact, employment (type: permanent/contract/locum/part-time; start/end; position; department; branch(es); reporting line), statutory IDs (EPF, SOCSO, income tax no. — stored encrypted), bank details (encrypted), documents (contract, certificates, APC — with expiry alerts), status. | Must |
| HR-F-02 | Shift templates and **roster**: weekly/monthly roster per branch; assign employees to shifts; conflicts (leave, double-booking); publish; changes notify (NTF); roster feeds APT doctor schedules. | Must |
| HR-F-03 | **Attendance**: clock in/out (web with geofence/IP check, or kiosk PIN), auto from roster with exceptions, late/early flags, corrections with approval, monthly timesheet. | Must |
| HR-F-04 | **Leave**: types (annual, medical, unpaid, public holiday, others per MY Employment Act minimums as defaults), entitlements per employee per year, accrual/pro-rata, apply → approve → balance; MC upload for medical leave; calendar view; blackout dates. | Must |
| HR-F-05 | **Overtime**: from attendance beyond roster; rates per policy; approval; export to payroll. | Should |
| HR-F-06 | **Locums**: locum profile with rate (per hour/session/patient), availability, assignments to sessions, auto-generated locum fee statements (FIN expense). | Must |
| HR-F-07 | **Commission**: schemes per doctor/staff (% of consultation revenue, of procedures, of medicine margin, tiered), computed per period from FIN revenue attribution; statements; adjustments; approval; export. | Must |
| HR-F-08 | **Claims**: staff expense claims with receipts → approval → FIN expense/payable. | Should |
| HR-F-09 | Payroll export: monthly CSV (basic, OT, allowances, deductions, commissions, leave taken) for external payroll; V3 integration. | Must |
| HR-F-10 | Self-service (staff): view roster, apply leave, clock, view payslip summary (from export), update contact. | Should |

## 4. Key workflows

Manager publishes next month's roster → staff notified → doctor schedule updated in APT · Nurse clocks in 09:07 (roster 09:00) → late flag → manager approves with note · Doctor commission: March revenue attribution → scheme 30% consults, 10% procedures → statement → approved → payroll export.

## 5. Data model

```
employee (extends V0)     + personal/statutory/bank (encrypted), employment fields, department_id, manager_employee_id, apc_expiry
employee_document         id, employee_id, type, storage_key, expires_at, verified_by
department                id, tenant_id, name
shift_template            id, tenant_id, branch_id, name, start_time, end_time, break_min, role_hint
roster                    id, tenant_id, branch_id, period, status enum(DRAFT, PUBLISHED), published_by, published_at
roster_shift              id, roster_id, employee_id, date, shift_template_id, start, end, room_id, notes
attendance                id, tenant_id, branch_id, employee_id, date, clock_in, clock_out, source, roster_shift_id, late_min, early_min, ot_min, status, correction_reason, approved_by
leave_type                id, tenant_id, code, name, paid, default_entitlement_days, carry_forward_max
leave_entitlement         id, employee_id, leave_type_id, year, entitled_days, taken_days, carried_days
leave_request             id, employee_id, leave_type_id, from_date, to_date, days, half_day, reason, mc_document_id, status, approved_by, approved_at
locum_profile             id, employee_id, rate_type, rate_sen, availability jsonb
locum_assignment          id, locum_profile_id, branch_id, date, start, end, patients_seen, fee_sen, status, statement_id
commission_scheme         id, tenant_id, name, rules jsonb, active
employee_commission       id, employee_id, scheme_id, effective_from, effective_to
commission_statement      id, employee_id, period, lines jsonb, total, status, approved_by, adjustments jsonb
staff_claim               id, employee_id, category, amount, receipt_key, status, approved_by, expense_id
payroll_export            id, tenant_id, period, storage_key, generated_at, totals jsonb
```

## 6. State machines

Roster `DRAFT → PUBLISHED`; leave `PENDING → APPROVED | REJECTED | CANCELLED`; attendance `RECORDED → CORRECTED → APPROVED`; commission statement `DRAFT → APPROVED → EXPORTED`.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| HR-R-01 | Statutory IDs and bank details encrypted at rest; visible only to HR/ORG_ADMIN with reauth; every view audited. | Service |
| HR-R-02 | Leave balance = entitled + carried − taken (approved); cannot go negative unless type allows. | Service |
| HR-R-03 | Published roster changes create a change log and notifications. | Service |
| HR-R-04 | Commission uses FIN's attributed revenue for the closed period only. | Service |
| HR-R-05 | Locum fees become FIN expenses on statement approval. | Service |
| HR-R-06 | APC expiry blocks rostering a doctor beyond the expiry date (warning 60 days before). | Roster validation |

## 8. API surface

`/hr/employees` CRUD + documents · `/hr/departments` · `/hr/shift-templates` · `/hr/rosters` + shifts + publish · `/hr/attendance` clock/correct/approve + timesheets · `/hr/leave-types|entitlements|requests` + approve · `/hr/locums` + assignments + statements · `/hr/commission-schemes|statements` + compute/approve · `/hr/claims` · `/hr/payroll-exports` · `/me/hr/*` self-service.

## 9. Domain events

**Emits:** `employee.created/updated/terminated`, `roster.published`, `attendance.flagged`, `leave.requested/approved/rejected`, `locum.assigned`, `commission.computed/approved`, `claim.submitted/approved`, `apc.expiring`
**Consumes:** `period.closed` (FIN) for commissions, `encounter.completed` (patients seen for locums)

## 10. Audit events

Sensitive-field views; employment changes; roster publishes; attendance corrections; leave decisions; commission approvals and adjustments.

## 11. Screens & UX requirements

Employee directory and profile (tabs: employment, documents, leave, attendance, commission) · Roster grid (drag assign; conflicts) · Attendance kiosk (PIN) and corrections queue · Leave calendar and approvals inbox · Locum planner and statements · Commission statement view with drill-down to revenue lines · Payroll export page · Staff self-service portal.

## 12. Validation

IC format; dates coherent; leave within entitlement/blackouts; roster no overlaps; commission rules sum sensibly; claim amount > 0 with receipt.

## 13. Non-functional requirements

Roster month for 30 staff ≤ 500 ms · attendance clock ≤ 200 ms · commission compute for 10 doctors ≤ 10 s.

## 14. Edge cases & failure modes

Employee with logins at multiple tenants (not supported; separate records) · shift spanning midnight · public holidays by state (calendar) · locum without login (fee tracking only) · commission on voided invoices (net of voids/credit notes in the period) · terminated employee with pending claims.

## 15. Compliance

Employment Act minimums for leave defaults (confirm current values); PDPA for employee data (stricter for statutory/bank); retention of employment records; APC/MMC currency for doctors (regulatory).

## 16. Reporting outputs

Headcount by branch/role; attendance/lateness; leave utilisation; OT; locum costs; commission by doctor; payroll totals.

## 17. Acceptance tests (representative)

HR-T-01 leave approval reduces balance; over-balance rejected · T-02 roster conflict with approved leave → blocked · T-03 clock-in late → flag; correction requires approval · T-04 commission = rule applied to FIN attribution for closed period · T-05 APC expired → roster assignment beyond date rejected · T-06 statutory field view audited and requires reauth.

## 18. Migration & rollout

Import employees; set leave entitlements/balances as at cut-over; first roster published for the next month; payroll export validated against current payroll provider's template.

## 19. Out of scope

Payroll computation (statutory deductions) → external/V3 · performance reviews → not planned · recruitment → not planned.

## 20. Open questions

HR-Q-01 payroll provider and template · Q-02 commission schemes in use · Q-03 clock method (kiosk/phone) · Q-04 leave policy specifics.

## 21. Definition of done

- [ ] Must requirements implemented; HR-T-01 … T-06 green
- [ ] Employees imported; one month roster/attendance/leave/commission cycle run
- [ ] Open questions answered
