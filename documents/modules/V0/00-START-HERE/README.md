# Start here

Sixteen files, one per V0 module, for **using** the system rather than
reading about it. Each one is: set it up in two lines, walk through what
it does, then try to break it.

They describe what is **actually built**, not what the specification
hoped for. Where the two differ, the file says so and names the open
item. If something here does not match what you see, that is a bug in
this document and worth fixing first — a test guide you cannot trust is
worse than none.

| | |
|---|---|
| **Written** | 2026-09-21, when all fifteen V0 modules were built |
| **Sibling** | [`../../../TEST-ACCOUNTS.md`](../../../../TEST-ACCOUNTS.md) — the quick tour. This is the thorough one. |
| **Registers** | Each module's `*-end-item-OPEN.md` in the parent folder says what is unfinished |

---

## Before anything

The database is already migrated if you have been running the tests.
From a clean one:

```bash
npm run db:migrate --workspace @gementar/api
npm run db:seed --workspace @gementar/api
```

Then the data that makes the screens worth looking at. **Order matters**
— the patients' allergies link to catalogue medicines:

```bash
npm run catalogue:seed  --workspace @gementar/api   # ~25 medicines
npm run patients:seed   --workspace @gementar/api   # 7 people
npm run procedures:seed --workspace @gementar/api   # procedure catalogue
npm run billing:seed    --workspace @gementar/api   # fee schedule, billable items
```

All four are safe to re-run; they bring things up to date rather than
duplicating. Re-running `patients:seed` is also how you repair the seven
patients after you have broken one.

Start the app yourself:

```bash
npm run dev
```

Sign in at **http://localhost:3000/login**.

The menu is a **left rail**, grouped the way a clinic thinks about its
day — the floor, care, money, stock, insight, setup — and it only shows
what your role can reach. Signing in as the doctor and as the cashier
gives two different menus, which is the quickest way to see what a role
actually is. Six accounts, all with the
password `ujian-klinik-2026-selamat` — the table is in
[`TEST-ACCOUNTS.md`](../../../../TEST-ACCOUNTS.md). Start as **Dr Farid**
(`doctor@klinikpilot.test`) unless a file says otherwise.

---

## One patient, end to end

Do this once before anything else. It is the sentence the whole of V0
exists to make true, and it takes about four minutes.

ujian-klinik-2026-selamat

**As Puan Zana** (`frontdesk@klinikpilot.test`):

1. **Patients → New patient.** Type `900101-14-5678` into the identity
   number. The date of birth and sex fill themselves in from the card.
   Give her a name and a phone number. Save.
2. On her record, **Check in**. She joins today's queue with a number.

**As Jururawat Mei** (`nurse@klinikpilot.test`):

3. **Today.** She is waiting. Call her, then **Triage**. Enter a
   temperature of `38.5` and a pulse of `105`. Both flag amber as you
   type. Save.

**As Dr Farid** (`doctor@klinikpilot.test`):

4. **Today → her row → Consultation.** The vitals are already there and
   the abnormal ones are marked. Type a complaint. Add a diagnosis.
5. In **Prescription**, add a medicine. Watch the on-hand quantity and
   the nearest expiry appear beside it.
6. Tick **They need a certificate, referral or letter**, then **Sign and
   finish**. You stay on the page.
7. In the **Documents** card that has appeared, issue a **medical
   certificate** for two days. Read the line that says what it covers.

**As En Kamal** (`dispenser@klinikpilot.test`):

8. **Pharmacy.** Her prescription is waiting. Dispense it. A batch is
   chosen by expiry; the label text is generated.

**As Cik Rina** (`cashier@klinikpilot.test`):

9. **Drawer → open it** with a float of RM 200.
10. **Billing → her bill.** The consultation fee and the medicine are
    already on it. Issue it, then take the money in cash. Read the
    rounding line.
11. **Today → her row → Complete.** It works, because the bill is paid.
    Try it before paying and it refuses.

**As Dr Aisyah** (`admin@klinikpilot.test`, needs an authenticator app):

12. **Dashboard.** Every number moved. **Audit.** Every step is there,
    with your name on it.

If all twelve worked, the system does what it claims. Everything else in
this folder is detail and edge cases.

---

## The files

| | Module | What it is for |
|---|---|---|
| [01](../01-identity-access/README.md) | IAM | Signing in, MFA, roles, lockout, sessions |
| [02](../02-tenancy-branch/README.md) | TEN | Clinic and branch settings, letterhead, isolation |
| [03](../03-patient/README.md) | PAT | Registering, MyKad, duplicates, allergies, merge |
| [04](../04-encounter-queue/README.md) | ENC | The queue, calling, the waiting-room screen |
| [05](../05-triage/README.md) | TRI | Vitals, the flags, amending |
| [06](../06-consultation/README.md) | CON | The note, signing, amending, templates |
| [07](../07-prescription/README.md) | RX | Prescribing, allergy and interaction warnings |
| [08](../08-dispensing/README.md) | DSP | The pharmacy counter, batches, labels |
| [09](../09-inventory/README.md) | INV | Stock, batches, counts, alerts |
| [10](../10-procedures/README.md) | PRC | Ordering and performing, consumables |
| [11](../11-billing/README.md) | BIL | The bill, discounts, issuing, voiding |
| [12](../12-payment/README.md) | PAY | The drawer, rounding, receipts, voids, refunds |
| [13](../13-documents/README.md) | DOC | Certificates, referrals, letters, reprints |
| [14](../14-audit-trail/README.md) | AUD | Who did what, and proving it cannot be rewritten |
| [15](../15-reporting-dashboard/README.md) | RPT | The tiles, the reports, the exports |

---

## How to use the Notes sections

Every file ends with one. It is yours. The useful shape is:

```
- [ ] The X screen does Y when I expected Z          ← a bug
- [ ] Takes four clicks; should take one             ← friction
- [ ] What happens if two people do this at once?    ← a question
- [ ] The wording of X is wrong for a Malaysian clinic
```

Anything in there that turns out to be real belongs in that module's
`*-end-item-OPEN.md` register, so it survives being forgotten.
