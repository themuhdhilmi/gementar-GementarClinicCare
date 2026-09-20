# Lab Integration (LAB)

| | |
|---|---|
| **Version** | V2 |
| **Status** | Not started |
| **Spec sections** | 37 |
| **Depends on** | CON, PAT, DOC, BIL, NTF, INT, AUD |
| **Depended on by** | PPT, ANL, TEL |
| **Est. effort** | ~60 h |

---

## 1. Purpose & business value

Order tests from the consultation, track samples, receive results from external labs (file first, structured later), notify the doctor, release to the patient. Closes the loop that today runs on printed forms and phone calls.

## 2. Actors & permissions

| Action | DOCTOR | NURSE | FRONTDESK | ADMIN |
|---|:-:|:-:|:-:|:-:|
| `lab.order` | ✓ | – | – | – |
| `lab.sample` — collect, label, dispatch | ✓ | ✓ | – | – |
| `lab.result.receive` — attach/import results | ✓ | ✓ | ✓ | ✓ |
| `lab.result.review` — acknowledge, annotate, release to patient | ✓ | – | – | – |
| Configure labs, catalogues, prices | – | – | – | ✓ |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| LAB-F-01 | Lab partners: name, contacts, catalogue of tests (code, name, specimen, TAT, price cost/sell, LOINC optional), request form template, result delivery method (`PORTAL_DOWNLOAD`, `EMAIL`, `SFTP`, `API`). | Must |
| LAB-F-02 | Order from CON plan: select tests (panels), clinical info, fasting flag, priority; printed request form (DOC); BIL line at sell price (or on result per policy). | Must |
| LAB-F-03 | Sample workflow: collect (who/when, specimen type, container), label print (barcode = order id), dispatch batch to lab (manifest), status tracking. | Must |
| LAB-F-04 | Results intake: upload PDF/image against the order (manual), email ingestion (parse attachment, match by order barcode/patient), SFTP/API import (structured HL7/CSV per lab) in V3; unmatched results queue. | Must |
| LAB-F-05 | Structured results (when available): analyte, value, unit, reference range, abnormal flag; stored per order; trend across orders. | Should |
| LAB-F-06 | Doctor review: notification (in-app/NTF), acknowledge, annotate, decide: release to patient (PPT) / call patient / book follow-up (APT); critical values flagged. | Must |
| LAB-F-07 | Turnaround and overdue tracking; lab performance. | Should |
| LAB-F-08 | Results visible in CON workspace (latest and history), in patient record (Clinical), and in PPT after release. | Must |

## 4. Key workflows

Order FBC + lipid → request form prints → nurse collects, labels, dispatches 16:00 batch → next day result PDF emailed → auto-matched by barcode → doctor notified → reviews, annotates "normal, continue" → releases → patient notified.

## 5. Data model

```
lab_partner          id, tenant_id, name, contacts, delivery_method, config jsonb, status
lab_test             id, lab_partner_id, code, name, panel bool, components jsonb, specimen, container, tat_hours, cost_sen, sell_price_sen, loinc, fasting
lab_order            id, tenant_id, branch_id, patient_id, encounter_id, consultation_id, lab_partner_id, order_no, status, priority, clinical_info, fasting, ordered_by, ordered_at, invoice_line_id
lab_order_test       id, lab_order_id, lab_test_id, status, result_id
lab_sample           id, lab_order_id, specimen, container, collected_by, collected_at, barcode, dispatch_batch_id, status
lab_dispatch_batch   id, tenant_id, branch_id, lab_partner_id, dispatched_at, manifest_key, sample_count
lab_result           id, lab_order_id, received_at, source enum(UPLOAD, EMAIL, SFTP, API), document_id (DOC), structured bool, status enum(RECEIVED, REVIEWED, RELEASED, AMENDED), reviewed_by, reviewed_at, annotation, released_at, critical bool
lab_result_value     id, lab_result_id, analyte_code, analyte_name, value_num, value_text, unit, ref_low, ref_high, flag enum(L, H, LL, HH, A, N), loinc
lab_unmatched        id, tenant_id, received_at, source, document_id, parsed jsonb, resolved_order_id, resolved_by
```

## 6. State machines

Order: `ORDERED → COLLECTED → DISPATCHED → RESULT_RECEIVED → REVIEWED → RELEASED | CLOSED`; `→ CANCELLED`. Result: as in table.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| LAB-R-01 | Results are clinical records: immutable once REVIEWED; amendments create new result versions. | Service + trigger |
| LAB-R-02 | Release to patient requires doctor review; critical values require acknowledgement with action recorded. | Service |
| LAB-R-03 | Matching inbound results to orders is by barcode/order no first; patient-name matching is a suggestion needing human confirmation. | Service |
| LAB-R-04 | Billing of lab tests follows tenant policy (on order or on result); refunds via FIN if cancelled after billing. | BIL |
| LAB-R-05 | Every result view audited (`clinical.viewed`). | Controller |

## 8. API surface

`/lab-partners` + `/tests` · `POST /consultations/:id/lab-orders` · `/lab-orders/:id` + `/cancel` · `POST /lab-orders/:id/samples` + `/label` · `/lab-dispatch-batches` · `POST /lab-orders/:id/results` (upload) · inbound email/SFTP handlers (INT) · `/lab-unmatched` + `/resolve` · `POST /lab-results/:id/review|release|amend` · `/patients/:id/lab-results` · `/reports/lab/tat`.

## 9. Domain events

**Emits:** `lab.ordered`, `lab.sample_collected`, `lab.dispatched`, `lab.result_received`, `lab.result_critical`, `lab.result_reviewed`, `lab.result_released`, `lab.result_unmatched`, `lab.overdue`
**Consumes:** `consultation.signed` (activate orders), `encounter.cancelled`

## 10. Audit events

Orders, cancellations, result receipt/matching decisions, reviews/annotations, releases, amendments, views.

## 11. Screens & UX requirements

Order picker in CON (panels, prices, fasting flags) · Sample station (collect, print label, batch dispatch with manifest) · Results inbox for doctors (new/critical/overdue) with viewer and annotate/release · Unmatched results queue · Patient results tab with trends (structured) · Lab admin (partners, catalogue, delivery config).

## 12. Validation

Tests belong to the partner; specimen/container required for collection; result upload mime allow-list; release requires review.

## 13. Non-functional requirements

Email ingestion ≤ 5 min · label print ≤ 1 s · results inbox ≤ 500 ms · PHI in inbound email handled per NTF/INT security rules.

## 14. Edge cases & failure modes

Result for a cancelled order (unmatched queue; doctor decides) · partial panel results (order stays open; per-test status) · duplicate result delivery (dedupe by lab reference) · wrong patient matched (unlink with reason; audited) · lab changes reference ranges (per result snapshot).

## 15. Compliance

Results are clinical records (integrity, access, retention); patient release policy; lab partner data-processing terms; critical-value handling supports duty-of-care documentation.

## 16. Reporting outputs

Orders by test/partner; TAT and overdue; critical results and time-to-acknowledge; lab revenue and cost margin (FIN).

## 17. Acceptance tests (representative)

LAB-T-01 order → request form document with barcode · T-02 result upload with barcode → auto-matched; without → unmatched queue · T-03 release before review → 409 · T-04 critical flag → doctor notification and acknowledgement required · T-05 reviewed result immutable; amendment creates version.

## 18. Migration & rollout

Partner catalogue loaded; email ingestion for the main lab; manual upload for others; structured import when a lab provides a feed.

## 19. Out of scope

In-house analysers (POCT device integration) → V3 · HL7/FHIR structured feeds → V3 `INT` · imaging (DICOM) → not planned.

## 20. Open questions

LAB-Q-01 which labs, delivery methods, and volumes · Q-02 billing on order vs result · Q-03 release-to-patient policy · Q-04 any labs offering structured feeds.

## 21. Definition of done

- [ ] Must requirements implemented; LAB-T-01 … T-05 green
- [ ] Main lab's email ingestion live and matching ≥ 95% automatically
- [ ] Open questions answered
