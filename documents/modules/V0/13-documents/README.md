# 13 · Documents (DOC)

The paper the patient walks out with: certificates, referrals, letters,
prescriptions, invoices, receipts, labels.

**Register:** [`../v0-13-documents-end-item-OPEN.md`](../../v0-13-documents-end-item-OPEN.md)

## Setup

A **signed** consultation ([06](../06-consultation/README.md)) — nothing can be
issued from a draft. Sign in as **Dr Farid**.

## Walk through

1. **In the consultation, tick "They need a certificate, referral or
   letter"** in the sign dialog. You stay on the page after signing
   instead of being sent back to the queue.
2. **The Documents card** appears under the note. Three buttons.
3. **Medical certificate → two days.** Read the line under the dates:
   *Covers 21 Sep 2026 — 22 Sep 2026*. **Two days means today and
   tomorrow**, not today and the next two. That is the thing everybody
   gets wrong, so the screen says it rather than leaving it for an
   employer to discover.
4. **Issue and print.** The letterhead and logo from
   [02](../02-tenancy-branch/README.md) are at the top. The number is
   `BRANCH-MC-YYYY-000001`.
5. **Print it again.** A grey **COPY** watermark. The stored file is
   untouched — the watermark is added on the way out, so the
   fingerprint taken at issue still describes the document.
6. **Cancel one.** It asks why, in a sentence, and **keeps its number**.
   A gap in a certificate series is a question nobody can answer later.
   Reprint it — stamped **CANCELLED** in red.
7. **Backdate one** to yesterday. The dialog demands a reason, which
   goes into the audit trail with the certificate. More than seven days
   back is refused.
8. **Tick "Print the diagnosis"** on one and not on another. Off by
   default, because the person who reads a certificate is usually an
   employer.
9. **A referral** — it prefills the summary from the record and lets the
   doctor reword it. A referral a doctor cannot reword is one they will
   write by hand instead.

## Try to break it

- **Issue from an unsigned consultation.** Refused.
- **Issue from a consultation another doctor signed.** Refused — a
  certificate carries their name.
- **As Puan Zana, open the patient's record → Documents.** The
  certificate is there; **the referral is not**. A referral carries
  clinical detail, so it is invisible without `clinical.read` — in the
  list as well as in the document.
- **Look at the identity number.** Full on a certificate (it is an
  identity document), masked on a referral, and full on a prescription
  **only** when it carries a controlled drug.
- **Upload a doctor's signature**, since there is no screen for it yet:
  ```bash
  curl -sb cookies.txt -X PUT -F file=@signature.png \
    http://localhost:3001/api/v1/me/signature
  ```
  Issue a certificate and the image is embedded. With nothing uploaded
  it prints a typed name block, which is a supported outcome.
  Try uploading a renamed SVG — refused; the file is judged by its
  first bytes.
- **Alter a stored file on disk** under `STORAGE_ROOT` and run the
  nightly integrity job. It finds it. That is what the hash is for: a
  restore from a doctored backup, or a helpful edit with a text editor.
- **Twenty certificates at once.** Twenty consecutive numbers.

## What is deliberately not here

- **Nothing has met a printer** (`DOC-OPEN-01`). **A production
  blocker**, and the one the specification put *first*: DOC-F-01 makes
  a printing spike blocking and it did not happen. A4 margins, 80 mm
  receipts and 50×30 mm labels are all assumptions.
- **The MC wording is invented** (`DOC-OPEN-02`). **Also a blocker.**
  A certificate is a legal document an employer acts on, and the
  clinic's name is on it. Ask for a sample of what they issue today.
- **The full identity number on every certificate is unconfirmed**
  (`DOC-OPEN-03`). It is what the spec says and nobody has checked it
  against their practice.
- **The verification code is decoration** (`DOC-OPEN-13`). Every
  certificate carries one, stored and printed; nothing resolves it
  until V1. Issuing them now means certificates become verifiable later
  rather than being the gap in the series.
- **No consultation record or immunisation card** (`DOC-OPEN-11`,
  `-12`).

## Notes

<!-- yours -->
