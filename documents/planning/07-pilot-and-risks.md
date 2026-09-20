# Pilot Rollout and Risks

You have a committed pilot clinic. That is the single biggest advantage in this project — most clinic software is built by guessing. It is also a responsibility: a live clinic has patients in the waiting room, and your bugs land on them.

---

## Working with the pilot

### Shadow before you build

One clinic day of observation before each phase. Not a meeting — sit in the corner and watch.

What to watch for specifically:
- **What they write on paper and why.** Every scrap is a requirement you would otherwise miss.
- **Where the queue actually jams.** It is rarely where people say it is.
- **How many patients per hour at peak**, and what the doctor's real consultation time is.
- **What the receptionist does with their hands.** If they currently type one number and get a patient, your search screen must be at least that fast.
- **Every workaround.** Workarounds are unmet requirements wearing a disguise.

### Set expectations explicitly

Write these down and have the clinic owner acknowledge them:

- Roughly eight months to the full system, with useful pieces from about week 11
- They are a pilot: they get the software free or heavily discounted, and in exchange they tolerate rough edges and give real feedback
- Paper stays as the fallback until go-live is signed off
- You are one person with a day job; support is best-effort with agreed response expectations, not 24/7

The failure mode to avoid is a clinic that expected a finished product in two months. That conversation is much easier now than in month four.

### A single named contact

One person at the clinic who collects feedback and makes decisions. Feedback arriving from six staff through three WhatsApp groups will consume more of your time than the coding.

---

## Data migration

Their existing patient records are the first hard problem, and it arrives in Phase 1.

- **Get a real export early**, in Phase 0, before the schema is final. Their data's actual shape should influence the schema while that is still free.
- Expect: duplicates, inconsistent IC formats, missing dates of birth, names in mixed conventions, phone numbers in five formats, and allergies recorded as free text inside a notes field.
- **Never import allergies from free text automatically.** A missed allergy is a patient safety event. Import them as unverified notes requiring clinical confirmation, and make the UI say so loudly.
- Import is a script, versioned in the repo, re-runnable, with a dry-run mode and a reconciliation report. You will run it more than once.
- Plan a data-cleaning pass with the clinic. This is their work, not yours, but it needs your tooling — a merge-duplicates screen earns its keep immediately.

---

## Training

Train by role, not by feature. Each session is 45 minutes with the real system and realistic data:

- **Reception** — register, search, check-in, queue. The heaviest users; train them best.
- **Nurse** — triage entry.
- **Doctor** — consultation workspace. Shortest session, highest stakes. If it needs more than 20 minutes, the UI is wrong.
- **Dispenser** — pharmacy queue, batch selection, labels.
- **Cashier** — billing, payment, receipts, end-of-day.

A one-page laminated quick reference per station beats a manual nobody opens.

### Go-live

- Choose the clinic's quietest day. Not a Monday.
- Be on site, the whole day.
- Paper running in parallel for the first day, reconciled that evening.
- Two weeks of hypercare with a fast response channel.
- A rollback decision made in advance: what would make you say "back to paper today"? Decide it while calm.

---

## Top risks

### 1. Printing · high likelihood, high impact
Thermal receipt printers (58/80 mm), medication labels, and A4 letterhead documents. Browser printing is unreliable across drivers and margin handling, label alignment is fiddly, and "the receipt prints with a huge gap" will consume days.

**Mitigate:** spike this in **Phase 0**, not Phase 4. Buy or borrow the exact printer models the clinic uses and print a real receipt, a real label and a real MC before you design the billing module. If browser printing proves unworkable, a small local print agent is the fallback — and you want to know that early, not in month seven.

### 2. Doctor adoption · medium likelihood, project-ending impact
If documenting a consultation is slower than writing on a card, the doctors stop using it, and a clinic system nobody documents in is worthless.

**Mitigate:** time a real consultation against paper. Target parity or better by R2. Keyboard-first, templates for their top 20 presentations, zero modals. If it is slower, fix that before building anything else.

### 3. Stock accuracy · medium likelihood, high impact
If the system says 40 and the shelf says 12, the clinic stops trusting the system — and that distrust spreads to the parts that are correct.

**Mitigate:** the ledger invariant and reconciliation job in `04`, plus a careful opening count, plus a physical spot check every week for the first month.

### 4. Internet outage · medium likelihood, high impact
A cloud system with no connection means a stopped clinic.

**Mitigate:** ask about their connection (`08`). Recommend a 4G failover router — cheap, and it removes the worst version of this. Write the paper fallback process. Offline-first is not a V0 option; it would roughly double the build.

### 5. Scope creep from an enthusiastic clinic · high likelihood, medium impact
Once they see it working, requests arrive weekly. Each is small. Together they are another year.

**Mitigate:** a visible backlog and a standing answer: "yes, that is a good idea, it goes after go-live." Only patient-safety issues jump the queue.

### 6. Solo burnout · medium likelihood, project-ending impact
Eight months of evenings, with a live clinic depending on you, is a long time.

**Mitigate:** the release structure exists partly for this — shipping something real every few months is what sustains motivation. Take the week after each release off from the project. Do not let support requests bleed into every evening; set hours and hold them.

### 7. Tenant isolation defect · low likelihood, company-ending impact
Low likelihood *because* of the work in `03`. Keep it that way: never ship a new table without the RLS test, and never accept a tenant id from a request.

### 8. The clinic asks for panel billing early · medium likelihood, medium impact
If a large share of their patients are panel or corporate, V0 without it may not actually let them retire paper.

**Mitigate:** find out now (`08`). If panel volume is high, V0's billing phase needs a minimal panel path — record the payer, mark the invoice as panel-billed, produce a statement — even if full claim tracking waits for V1.

---

## What success looks like

At go-live:
- The clinic runs a full day with no paper except the agreed fallback
- Cash reconciles to the sen
- Stock matches a physical count
- The doctor is not slower than they were on paper
- You have a reference customer, a real dataset, and a clear-eyed sense of what V1 must contain to sell to clinic number two
