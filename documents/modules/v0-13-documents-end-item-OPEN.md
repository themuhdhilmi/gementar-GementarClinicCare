# Documents — open end items

Everything about `DOC` that is **not finished, not provable here, or
waiting on a module that does not exist yet**.

The documents are made, numbered, stored, hashed, reprinted and
cancelled, and every one of those behaviours is proved. What has not
happened is the part the specification put first: **nothing here has ever
touched the clinic's printers.** DOC-F-01 makes a Phase 0 printing spike
a precondition of this module and the spike has not been done, so the
rendering decision was made provisionally and everything downstream of
it — paper sizes, thermal payloads, label stock, whether a print dialog
appears — is a guess that prints correctly in a browser and has never
met a printer.

| | |
|---|---|
| **Module** | [v0-13-documents.md](v0-13-documents.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. The one that was supposed to happen first

| # | Item | Done when |
|---|---|---|
| **DOC-OPEN-01** | **The Phase 0 printing spike never happened (DOC-F-01, DOC-F-03, DOC-Q-01).** The specification makes it blocking, and it blocks nothing today because the choice was made without it: documents are deterministic HTML, stored as bytes, printed by the browser. That is the path DOC-F-03 already specifies for receipts and labels, so it is a shipped decision rather than a placeholder — but three things rest on it and none are settled. Whether an A4 certificate comes out of their printer with the margins the template assumes. Whether an 80 mm receipt needs ESC/POS rather than HTML. Whether a 50×30 mm label lands on the label and not across two of them. **Until a real MC, a real receipt and a real label have come out of the clinic's own machines, this module is unproven where it matters most.** | An afternoon at the clinic with their printers, real stock, and DOC-T-06 recorded with a photograph. Then DOC-F-01 and DOC-F-03 are rewritten to say what was chosen, and whatever the spike breaks is fixed. |

## B. Before a certificate is handed to a patient

| # | Item | Done when |
|---|---|---|
| **DOC-OPEN-02** | **The MC wording is invented (DOC-Q-04).** Bilingual, plausible, and written by somebody who has never issued one. A medical certificate is a legal document an employer acts on; the phrasing is not a detail. The same goes for the referral and the generic letter. | The doctor reads the printed MC and either approves the wording or rewrites it. Ask for a sample of what they issue today — `DOC-Q-04` exists precisely because copying theirs is faster than defending ours. |
| **DOC-OPEN-03** | **The full identity number is printed on every certificate (DOC-R-08, DOC-Q-02).** That is what the specification says and it has not been confirmed with anybody. It is the one place in the system where an unmasked number goes onto paper that leaves the building, and the decision belongs to the clinic, not to this code. | The clinic confirms their current practice, and if it differs the rule changes in `issueMc` — one line, plus the test that asserts it. |
| **DOC-OPEN-04** | **Numbering starts at 000001 (DOC-Q-03).** Per branch, per type, per year, gapless and locked. If the clinic has an existing MC series — and a clinic that has been open for years has one — continuing it is an `UPDATE` to `document_series.next_seq` before the first issue, and it must be deliberate, because the series has no tidy way to take inserted numbers afterwards. | The owner says "continue from 4,412" or "start fresh", the counter is set, and the first number is read off the first printed certificate by eye. |
| **DOC-OPEN-05** | **No doctor has uploaded a signature (DOC-F-16, DOC-Q-05).** The upload works, sniffs the file type rather than trusting the browser, and embeds the image in the document; with nothing uploaded a certificate carries a typed block and says `TYPED`. Both paths are tested. Neither has been seen by a doctor. | Each doctor uploads theirs at setup, and one printed certificate is held up next to a handwritten one. |
| **DOC-OPEN-06** | **A certificate carries no registration number (DOC-F-05).** The signature block prints the doctor's name and nothing else, because the MMC registration number is a field on the employee record that `IAM` does not have yet — `IAM-OPEN-13`. An employer checking a certificate has the name and the clinic, which is probably enough and is not what the specification asks for. | `IAM-OPEN-13` adds the column; `signatureFor` reads it; the template already has the slot. |

## C. No screen, or not enough screen

| # | Item | Done when |
|---|---|---|
| **DOC-OPEN-07** | **There is no signature-upload screen.** `PUT /me/signature` and `GET /me/signature` work and have no UI, so a doctor's signature is uploaded with `curl`. | A block on the profile screen: preview, replace, remove. Small, and needed before `DOC-OPEN-05` can happen without a laptop and a shell. |
| **DOC-OPEN-08** | **There is no template-editing screen (DOC §8 `/document-templates`).** The specification asks for editable blocks in V0. What exists is the branch letterhead — header text, footer text, logo — which is rendered onto every A4 document and editable on the branch screen. The template bodies themselves are code. | Decide whether "editable blocks in V0" means more than the letterhead. If it does, it is a table and a screen; if it does not, strike it from §8. |
| **DOC-OPEN-09** | **A reprint is counted, not confirmed.** `POST /documents/:id/print` records that a document was *sent* to the browser's print dialog. Whether paper came out — whether the user pressed Cancel — is not knowable from a web page. A document showing `printed 3×` may have been printed once. | Nothing, probably; this is the honest limit of browser printing and is worth knowing rather than fixing. If `DOC-OPEN-01` chooses a print agent, the agent can report what it actually spooled. |

## D. Waiting on another module

| # | Item | Lands with |
|---|---|---|
| **DOC-OPEN-10** | ~~**No receipt (DOC-F-08).**~~ **Closed by `v0-12-payment.md`.** An 80 mm thermal receipt with the rounding line, the tender and the change, issued once per payment and returned rather than re-made when asked again — which is §14's power-cut case. It keeps `PAY`'s gapless `receipt_no` rather than taking a second number from the document series. | Done, except that it has never met a printer — `DOC-OPEN-01`, `PAY-OPEN-01`. |
| **DOC-OPEN-11** | **No printable consultation record (CON-F-19, `CON-OPEN-05`).** `CONSULT_RECORD` is in the enum with an A4 target and has no template and no route. The certificate, referral, letter, lab request and prescription printouts all exist; this one was left because "print the whole note" needs a decision about how much of the note an outsider should see, and nobody has made it. | A template and a route, once somebody says whether it prints the full note or a summary. Cheap after that. |
| **DOC-OPEN-12** | **No immunisation record (PRC-F-11, `PRC-OPEN-09`).** The data is complete — vaccine, batch, expiry, site, who gave it, when. There is no template. | A template and a route, the same shape as the letter. The card a parent carries is a real request and worth doing properly. |
| **DOC-OPEN-13** | **Public verification is V1 (DOC §8 `/verify/:code`).** Every certificate carries a ten-character code, generated, stored and printed. Nothing resolves it, so the code on the paper is currently decoration. | V1. The column is populated from today, so certificates issued now become verifiable later rather than being the gap in the series. |

## E. Smaller things, honestly listed

| # | Item | Why it is here |
|---|---|---|
| **DOC-OPEN-14** | **The list route is not the path the specification names.** §8 asks for `GET /patients/:id/documents`; `PAT` already owns that path for the files attached *to* a patient — scanned identity cards, letters that came in. Two different things cannot share one name, so issued documents are at `GET /patients/:id/issued-documents`. The patient screen shows both, in separate cards, because the distinction is real and users will not care about it. Either the spec changes or the path does. |
| **DOC-OPEN-15** | **Nothing enforces one certificate per visit.** A doctor can issue five MCs from one consultation and the twenty-at-once test relies on exactly that. Real duplicates get cancelled with a reason, which is the designed answer, but the screen offers no warning that a certificate has already been issued for this visit. |
| **DOC-OPEN-16** | **The replacement link is set by SQL, not by an endpoint.** `linkReplacement` exists on the service and no route calls it, so "cancel and reissue" is two independent actions on the screen and the cross-reference is only populated by the test. The column, the flow and the display are all there. |
| **DOC-OPEN-17** | **Document fees are a naming convention.** A billable item coded `DOC_MC`, `DOC_REFERRAL`, `DOC_LETTER` or `DOC_LAB_REQUEST` makes that document fee-bearing; no such item means it is free. That is deliberate — the priced item *is* the configuration, with no second switch to forget — and it is undiscoverable without reading this line or the code. It belongs in the administration screen `BIL-OPEN-04` will build. |
| **DOC-OPEN-18** | **The integrity job reads every document's bytes off disk each night**, capped at 2,000 per clinic. At the pilot's volume that is minutes; at fifty clinics it is not. The cap means the oldest documents stop being checked rather than the job running long, which is the wrong trade for exactly the documents most likely to have been tampered with. |
| **DOC-OPEN-19** | **`TEMPLATE_VERSION` is 1 and no process bumps it.** Every document records the version it was rendered at, which is what makes "why does the reprint look different" answerable — but only if somebody remembers to increment the constant when a template changes. Nothing checks. |

---

## What is actually finished

Worth stating plainly, because the list above is long.

- Certificates, referrals, letters, lab requests, prescription printouts,
  invoice printouts and dispensing labels all issue, from signed records
  only, with the letterhead and logo of the branch that issued them.
- Numbering is gapless per branch, per type, per year, under a row lock —
  twenty concurrent issues get twenty consecutive numbers.
- The stored bytes are hashed at issue, the row cannot be updated or
  deleted, and a nightly job re-reads every file and reports any that no
  longer matches.
- A reprint serves the original bytes; the COPY and CANCELLED watermarks
  are applied on the way out, so the hash keeps meaning something.
- Cancelling keeps the number and records a reason. Clinical documents
  are invisible to roles without `clinical.read`, in the list as well as
  the detail.
- Rendering and disk writes happen outside any transaction, and the
  number is allocated only after the file exists — so a failed render
  never spends a number and never leaves a row pointing at nothing.
