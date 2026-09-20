# Open Questions

A living checklist. Items marked **blocking** should be answered before the phase named. Work the clinic ones through in a single sitting with the pilot if you can.

---

## For the pilot clinic

### Operations — **blocking Phase 1**
- [ ] Walk-in only, or do they run appointments today? If appointments are a real part of their day, scheduling moves into V0 and something else moves out.
- [ ] Patients per day, and the peak hour rate?
- [ ] How many consultation rooms, and how many doctors on at once?
- [ ] Do they triage every patient, or only some?
- [ ] Who dispenses — a pharmacist, a dispenser, or the doctor?
- [ ] **Do they collect payment before or after dispensing?** This reorders the encounter state machine (`04`).
- [ ] How many staff, and does one person cover reception + cashier + dispensing? Determines whether four V0 roles are right.

### Billing — **blocking Phase 4**
- [ ] What share of patients are panel or corporate? If it is large, see risk 8 in `07`.
- [ ] Which panels do they deal with, and how are claims submitted today?
- [ ] Payment methods actually in use, and rough mix?
- [ ] Do they discount, and on what basis?
- [ ] Is a consultation fee flat, or does it vary by doctor or visit type?

### Inventory — **blocking Phase 3**
- [ ] Roughly how many SKUs?
- [ ] Do they track batch and expiry today, or not at all?
- [ ] **Do they dispense controlled substances / scheduled poisons?** If yes, what register do they keep and what does the law require? (`05`)
- [ ] Is there an existing stock list to import?
- [ ] When could a full opening stock count realistically happen?

### Data — **blocking Phase 0**
- [ ] What system are they on now, and can it export? Get a real sample file as early as possible.
- [ ] How many historical patient records?
- [ ] How far back does clinical history need to come across — or is a fresh start acceptable with the old system kept read-only?
- [ ] How are allergies recorded today? (Expect: free text in notes.)

### Compliance — **blocking Phase 5**
- [ ] Their annual revenue band, for the MyInvois e-Invoice phase-in — and their actual deadline.
- [ ] Do they issue e-invoices today?
- [ ] Any existing PDPA documentation, retention policy or DPO?
- [ ] Record retention period they currently work to.

### Environment — **blocking Phase 0**
- [ ] **Which exact receipt printer, label printer and document printer?** Needed for the Phase 0 printing spike (risk 1 in `07`).
- [ ] Internet connection — type, and is there any failover?
- [ ] What computers do staff use, which browser, and how old?
- [ ] Is there a waiting-room screen for the queue display, or does one need buying?

---

## For you — product and business

- [ ] Is "Gementar ClinicCare" the final name? Check trademark and domain before it appears on printed receipts.
- [ ] Pilot commercial terms: free, discounted, or paid? Written down either way.
- [ ] Do you intend to sell this, or is it primarily for this clinic and its group? Changes how much of `03`'s tenancy work is justified today.
- [ ] Target customer for clinic number two — single GP clinic, or a small chain? Chains need branches sooner.
- [ ] Pricing shape (your section 49) — worth sketching before V1, since module toggles affect V1 architecture.
- [ ] What is your actual sustainable weekly hours? The `06` estimate hinges on it.
- [ ] Any budget at all for paid help on discrete pieces — PDF templates, the UI design system, data migration? A few hundred ringgit spent well could remove a month.

---

## Technical decisions to make

- [ ] **ICD-10 code list** — is a usable, appropriately-licensed list available cheaply? If not, V0 ships free-text diagnosis with a `code` column left nullable, and coding lands in V1.
- [ ] **Medicine catalogue seed** — build it from the clinic's own stock list, or start from a Malaysian drug reference? Generic names and drug classes are required for allergy checking (`05`).
- [ ] **PDF generation** — headless Chromium (flexible, heavy) vs a typesetting library (light, fiddly). Decide in the Phase 0 printing spike.
- [ ] **UI component library** — shadcn/ui or similar, chosen in Phase 0 and not revisited. Consistency matters more than the choice.
- [ ] **Error tracking** — self-hosted or a free-tier service. Must not receive patient data.
- [ ] **Object storage provider** for documents — must be comfortable with Malaysian data residency expectations; confirm whether the clinic has a view on data leaving Malaysia.
- [ ] **Session vs JWT** — recommended: server-side sessions (`05`). Confirm and move on.

---

## Resolved

| Question | Decision | Date |
|---|---|---|
| Who is building this | Solo, nights and weekends | 2026-09-20 |
| Multi-tenancy timing | Tenant-aware from day one, Postgres RLS | 2026-09-20 |
| Pilot | Committed clinic, plan works backwards from their workflow | 2026-09-20 |
| V1 scope | Cut a smaller V0 first — "one patient, door to door" | 2026-09-20 |
| Stack | Next.js + NestJS + Postgres + Prisma, modular monolith | 2026-09-20 |
