import { DocumentType, PrintTarget } from '../../generated/prisma/enums.js';

/**
 * Document templates (DOC-F-01, DOC-F-15, DOC-N-04).
 *
 * Plain functions from a payload to HTML. No template engine and no
 * headless browser, for two reasons.
 *
 * The first is that DOC-F-01 says the rendering approach is settled by a
 * Phase 0 printing spike against the clinic's actual printers, and that
 * spike has not happened. Choosing Chromium now would be pretending it
 * had.
 *
 * The second is DOC-N-04: a template has to render identically every
 * time. A pure function of its payload does, and can be proved to in a
 * unit test, which a browser screenshot cannot.
 *
 * What is stored is the HTML. DOC-F-03 already specifies browser
 * printing for receipts and labels, and lets letters show the dialog, so
 * this is the shipped path rather than a placeholder — and when the
 * spike answers, a PDF renderer slots in behind the same seam because
 * the stored artefact is what a reprint serves either way.
 */

/** Bumped when a template's output changes. Recorded on every document. */
export const TEMPLATE_VERSION = 1;

export type Letterhead = {
  clinicName: string;
  branchName: string;
  /** TEN-F-10: the branch's uploaded artwork, inlined as a data URI. */
  logoDataUri: string | null;
  headerText: string;
  footerText: string;
  addressLine1: string | null;
  addressLine2: string | null;
  phone: string | null;
};

export type SignatureBlock = {
  name: string;
  registrationNo: string | null;
  /** A data URI when the doctor has uploaded one. */
  imageDataUri: string | null;
};

export type McPayload = {
  kind: 'MC';
  letterhead: Letterhead;
  patientName: string;
  /** DOC-R-08: full, because a certificate is an identity document. */
  patientIdNumber: string | null;
  fromDate: string;
  toDate: string;
  days: number;
  lightDuty: boolean;
  diagnosis: string | null;
  signature: SignatureBlock;
  issuedAt: string;
  verificationCode: string;
};

export type ReferralPayload = {
  kind: 'REFERRAL';
  letterhead: Letterhead;
  patientName: string;
  patientIdMasked: string | null;
  patientAge: string | null;
  to: string;
  urgency: string;
  reason: string;
  summary: string;
  signature: SignatureBlock;
  issuedAt: string;
};

export type LetterPayload = {
  kind: 'LETTER';
  letterhead: Letterhead;
  title: string;
  patientName: string;
  patientIdMasked: string | null;
  body: string;
  signature: SignatureBlock;
  issuedAt: string;
};

export type RxPrintPayload = {
  kind: 'RX_PRINT';
  letterhead: Letterhead;
  patientName: string;
  /** Full only when something on it is controlled (DOC-R-08). */
  patientIdNumber: string | null;
  items: Array<{
    displayName: string;
    quantity: string;
    labelText: string;
    controlled: boolean;
  }>;
  signature: SignatureBlock;
  issuedAt: string;
};

export type InvoicePayload = {
  kind: 'INVOICE';
  letterhead: Letterhead;
  invoiceNo: string;
  patientName: string;
  patientIdMasked: string | null;
  lines: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
  }>;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  amountPaid: string;
  balance: string;
  issuedAt: string;
};

/**
 * PAY-F-14, DOC-F-08: the slip the patient keeps.
 *
 * Eighty millimetres wide, because that is what a thermal till printer
 * takes and what the receipt in everybody's pocket already looks like.
 * An A4 variant is the same content in the A4 shell, chosen by the
 * caller rather than by the template.
 */
export type ReceiptPayload = {
  kind: 'RECEIPT';
  clinicName: string;
  branchName: string;
  branchPhone: string | null;
  headerText: string;
  footerText: string;
  receiptNo: string;
  invoiceNo: string | null;
  patientName: string | null;
  lines: Array<{ description: string; quantity: string; lineTotal: string }>;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  /** Present only when it is not zero; BNM rounding on the cash leg. */
  rounding: string | null;
  method: string;
  paid: string;
  tendered: string | null;
  change: string | null;
  balance: string;
  cashier: string;
  paidAt: string;
  /** Marked when the invoice still owes something after this payment. */
  outstanding: boolean;
};

export type LabelPayload = {
  kind: 'LABEL';
  clinicName: string;
  branchPhone: string | null;
  patientName: string;
  product: string;
  quantity: string;
  instructions: string;
  batches: string;
  warnings: string[];
  dispensedAt: string;
};

export type DocumentPayload =
  | McPayload
  | ReferralPayload
  | LetterPayload
  | RxPrintPayload
  | InvoicePayload
  | ReceiptPayload
  | LabelPayload;

/** Which template family and paper each type uses. */
export const TARGET_FOR: Record<DocumentType, PrintTarget> = {
  MC: PrintTarget.A4,
  REFERRAL: PrintTarget.A4,
  MEDICAL_LETTER: PrintTarget.A4,
  LAB_REQUEST: PrintTarget.A4,
  RX_PRINT: PrintTarget.A4,
  CONSULT_RECORD: PrintTarget.A4,
  INVOICE: PrintTarget.A4,
  RECEIPT: PrintTarget.THERMAL_80,
  LABEL: PrintTarget.LABEL_50x30,
  QUEUE_TICKET: PrintTarget.THERMAL_80,
  OTHER: PrintTarget.A4,
};

/** Types that carry a number. A label does not; a certificate must. */
export const NUMBERED: ReadonlySet<DocumentType> = new Set([
  DocumentType.MC,
  DocumentType.REFERRAL,
  DocumentType.MEDICAL_LETTER,
  DocumentType.LAB_REQUEST,
  DocumentType.RX_PRINT,
]);

/** The letters in a document number: `KL01-MC-2026-000012`. */
export const TYPE_CODE: Record<DocumentType, string> = {
  MC: 'MC',
  REFERRAL: 'REF',
  RX_PRINT: 'RX',
  INVOICE: 'INV',
  RECEIPT: 'RCP',
  LABEL: 'LBL',
  QUEUE_TICKET: 'QT',
  MEDICAL_LETTER: 'LTR',
  LAB_REQUEST: 'LAB',
  CONSULT_RECORD: 'CR',
  OTHER: 'DOC',
};

export function render(
  payload: DocumentPayload,
  documentNo: string | null,
): string {
  switch (payload.kind) {
    case 'MC':
      return page(payload.letterhead, documentNo, mcBody(payload), 'A4');
    case 'REFERRAL':
      return page(payload.letterhead, documentNo, referralBody(payload), 'A4');
    case 'LETTER':
      return page(payload.letterhead, documentNo, letterBody(payload), 'A4');
    case 'RX_PRINT':
      return page(payload.letterhead, documentNo, rxBody(payload), 'A4');
    case 'INVOICE':
      return page(payload.letterhead, documentNo, invoiceBody(payload), 'A4');
    case 'RECEIPT':
      return receiptPage(payload);
    case 'LABEL':
      return labelPage(payload);
  }
}

// ---------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------

/**
 * One A4 shell for every letter.
 *
 * The overlay for a copy or a cancellation is deliberately **not** here:
 * DOC-T-03 requires that a reprint be byte-identical to the original, so
 * the watermark is added when the document is served rather than baked
 * into the stored file.
 */
function page(
  head: Letterhead,
  documentNo: string | null,
  body: string,
  target: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(head.clinicName)}</title>
<style>
@page { size: ${target}; margin: 18mm 16mm 20mm; }
:root { color-scheme: light; }
body { font-family: "Helvetica Neue", Arial, sans-serif; color: #111; font-size: 11pt; line-height: 1.45; margin: 0; }
.head { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 18px; }
.clinic { font-size: 15pt; font-weight: 700; }
.branch { font-size: 10pt; }
.small { font-size: 9pt; color: #444; }
h1 { font-size: 13pt; text-transform: uppercase; letter-spacing: .08em; margin: 18px 0 12px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 4px 0; vertical-align: top; }
.right { text-align: right; }
.field { margin: 6px 0; }
.label { display: inline-block; min-width: 42mm; color: #444; }
.sig { margin-top: 28mm; }
.sig img { height: 18mm; display: block; margin-bottom: 2mm; }
.sig .line { border-top: 1px solid #111; width: 70mm; padding-top: 4px; }
.foot { position: fixed; bottom: 0; left: 0; right: 0; border-top: 1px solid #999; padding-top: 6px; font-size: 8.5pt; color: #444; }
.docno { float: right; font-size: 9pt; color: #444; }
.logo { max-height: 18mm; max-width: 60mm; display: block; margin-bottom: 4px; }
.body { white-space: pre-wrap; }
</style>
</head>
<body>
<div class="head">
  <span class="docno" id="doc-no">${escape(documentNo ?? '')}</span>
  ${head.logoDataUri ? `<img class="logo" src="${head.logoDataUri}" alt="">` : ''}
  <div class="clinic">${escape(head.clinicName)}</div>
  <div class="branch">${escape(head.branchName)}</div>
  ${head.headerText ? `<div class="small">${escape(head.headerText)}</div>` : ''}
  ${address(head)}
</div>
${body}
${head.footerText ? `<div class="foot">${escape(head.footerText)}</div>` : ''}
</body>
</html>`;
}

function address(head: Letterhead): string {
  const parts = [head.addressLine1, head.addressLine2, head.phone].filter(
    Boolean,
  );
  return parts.length
    ? `<div class="small">${escape(parts.join(' · '))}</div>`
    : '';
}

// ---------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------

/**
 * DOC-F-17: a certificate is bilingual, because the person who reads it
 * is an employer rather than a clinician and may read either.
 */
function mcBody(p: McPayload): string {
  return `
<h1>Sijil Cuti Sakit · Medical Certificate</h1>
<div class="field"><span class="label">Nama · Name</span><strong>${escape(p.patientName)}</strong></div>
${p.patientIdNumber ? `<div class="field"><span class="label">No. KP · ID No.</span>${escape(p.patientIdNumber)}</div>` : ''}
<p>Ini adalah untuk mengesahkan bahawa pesakit di atas telah diperiksa dan
didapati <strong>tidak sihat untuk bertugas</strong> selama
<strong>${p.days}</strong> hari, dari <strong>${escape(p.fromDate)}</strong>
hingga <strong>${escape(p.toDate)}</strong>.</p>
<p>This is to certify that the patient named above has been examined and is
<strong>unfit for duty</strong> for <strong>${p.days}</strong> day${p.days === 1 ? '' : 's'},
from <strong>${escape(p.fromDate)}</strong> to <strong>${escape(p.toDate)}</strong>.</p>
${
  p.lightDuty
    ? `<p><strong>Sesuai untuk tugas ringan · Fit for light duty.</strong></p>`
    : ''
}
${p.diagnosis ? `<div class="field"><span class="label">Diagnosis</span>${escape(p.diagnosis)}</div>` : ''}
${signature(p.signature, p.issuedAt)}
<p class="small">Kod pengesahan · Verification code: <strong>${escape(p.verificationCode)}</strong></p>`;
}

function referralBody(p: ReferralPayload): string {
  return `
<h1>Referral Letter</h1>
<div class="field"><span class="label">To</span><strong>${escape(p.to)}</strong></div>
<div class="field"><span class="label">Urgency</span>${escape(p.urgency)}</div>
<div class="field"><span class="label">Patient</span><strong>${escape(p.patientName)}</strong>${
    p.patientAge ? ` · ${escape(p.patientAge)}` : ''
  }</div>
${p.patientIdMasked ? `<div class="field"><span class="label">ID No.</span>${escape(p.patientIdMasked)}</div>` : ''}
<h1>Reason for referral</h1>
<div class="body">${escape(p.reason)}</div>
<h1>Clinical summary</h1>
<div class="body">${escape(p.summary)}</div>
${signature(p.signature, p.issuedAt)}`;
}

function letterBody(p: LetterPayload): string {
  return `
<h1>${escape(p.title)}</h1>
<div class="field"><span class="label">Patient</span><strong>${escape(p.patientName)}</strong></div>
${p.patientIdMasked ? `<div class="field"><span class="label">ID No.</span>${escape(p.patientIdMasked)}</div>` : ''}
<div class="body">${escape(p.body)}</div>
${signature(p.signature, p.issuedAt)}`;
}

function rxBody(p: RxPrintPayload): string {
  return `
<h1>Prescription</h1>
<div class="field"><span class="label">Patient</span><strong>${escape(p.patientName)}</strong></div>
${p.patientIdNumber ? `<div class="field"><span class="label">ID No.</span>${escape(p.patientIdNumber)}</div>` : ''}
<table>
<thead><tr><th>Medicine</th><th>Quantity</th><th>Directions</th></tr></thead>
<tbody>
${p.items
  .map(
    (item) => `<tr>
  <td>${escape(item.displayName)}${item.controlled ? ' <strong>(controlled)</strong>' : ''}</td>
  <td>${escape(item.quantity)}</td>
  <td>${escape(item.labelText)}</td>
</tr>`,
  )
  .join('\n')}
</tbody>
</table>
${signature(p.signature, p.issuedAt)}`;
}

function invoiceBody(p: InvoicePayload): string {
  return `
<h1>Invoice ${escape(p.invoiceNo)}</h1>
<div class="field"><span class="label">Patient</span><strong>${escape(p.patientName)}</strong></div>
${p.patientIdMasked ? `<div class="field"><span class="label">ID No.</span>${escape(p.patientIdMasked)}</div>` : ''}
<table>
<thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Total</th></tr></thead>
<tbody>
${p.lines
  .map(
    (line) => `<tr>
  <td>${escape(line.description)}</td>
  <td class="right">${escape(line.quantity)}</td>
  <td class="right">${escape(line.unitPrice)}</td>
  <td class="right">${escape(line.lineTotal)}</td>
</tr>`,
  )
  .join('\n')}
</tbody>
</table>
<table style="margin-top:12px">
<tr><td class="right">Subtotal</td><td class="right" style="width:30mm">${escape(p.subtotal)}</td></tr>
${p.discountTotal !== '0.00' ? `<tr><td class="right">Discount</td><td class="right">−${escape(p.discountTotal)}</td></tr>` : ''}
${p.taxTotal !== '0.00' ? `<tr><td class="right">Tax</td><td class="right">${escape(p.taxTotal)}</td></tr>` : ''}
<tr><td class="right"><strong>Total</strong></td><td class="right"><strong>RM ${escape(p.grandTotal)}</strong></td></tr>
${p.amountPaid !== '0.00' ? `<tr><td class="right">Paid</td><td class="right">${escape(p.amountPaid)}</td></tr>` : ''}
${p.balance !== '0.00' ? `<tr><td class="right">Balance</td><td class="right">${escape(p.balance)}</td></tr>` : ''}
</table>
<p class="small">Issued ${escape(p.issuedAt)}</p>`;
}

/** DOC-F-09: 50×30 mm of thermal label, and nothing that will not fit. */
/**
 * The 80 mm till receipt.
 *
 * Its own page rather than the A4 shell: a thermal roll has no page
 * height, one column, and a font that has to be readable on paper the
 * width of a hand. Sharing the A4 stylesheet and overriding it would
 * mean every A4 change risked the receipt, which is the document
 * printed two hundred times a day.
 */
function receiptPage(p: ReceiptPayload): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(p.receiptNo)}</title>
<style>
@page { size: 80mm auto; margin: 4mm 3mm; }
body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 9pt; line-height: 1.35; margin: 0; color: #000; width: 74mm; }
.mid { text-align: center; }
.clinic { font-size: 11pt; font-weight: 700; }
.rule { border-top: 1px dashed #000; margin: 2mm 0; }
table { width: 100%; border-collapse: collapse; }
td { padding: 0.4mm 0; vertical-align: top; }
.right { text-align: right; }
.big { font-size: 12pt; font-weight: 700; }
.small { font-size: 7.5pt; }
.docno { }
</style>
</head>
<body>
<div class="mid">
  <div class="clinic">${escape(p.clinicName)}</div>
  <div>${escape(p.branchName)}</div>
  ${p.branchPhone ? `<div class="small">${escape(p.branchPhone)}</div>` : ''}
  ${p.headerText ? `<div class="small">${escape(p.headerText)}</div>` : ''}
</div>
<div class="rule"></div>
<table>
  <tr><td>Receipt</td><td class="right"><span class="docno" id="doc-no">${escape(p.receiptNo)}</span></td></tr>
  ${p.invoiceNo ? `<tr><td>Invoice</td><td class="right">${escape(p.invoiceNo)}</td></tr>` : ''}
  ${p.patientName ? `<tr><td>Patient</td><td class="right">${escape(p.patientName)}</td></tr>` : ''}
  <tr><td>Date</td><td class="right">${escape(p.paidAt)}</td></tr>
</table>
<div class="rule"></div>
<table>
${p.lines
  .map(
    (line) => `  <tr><td>${escape(line.description)}${
      line.quantity === '1' ? '' : ` &times;${escape(line.quantity)}`
    }</td><td class="right">${escape(line.lineTotal)}</td></tr>`,
  )
  .join('\n')}
</table>
<div class="rule"></div>
<table>
  <tr><td>Subtotal</td><td class="right">${escape(p.subtotal)}</td></tr>
  ${p.discountTotal !== '0.00' ? `<tr><td>Discount</td><td class="right">\u2212${escape(p.discountTotal)}</td></tr>` : ''}
  ${p.taxTotal !== '0.00' ? `<tr><td>Tax</td><td class="right">${escape(p.taxTotal)}</td></tr>` : ''}
  <tr><td class="big">Total</td><td class="right big">${escape(p.grandTotal)}</td></tr>
  ${p.rounding ? `<tr><td>Rounding</td><td class="right">${escape(p.rounding)}</td></tr>` : ''}
</table>
<div class="rule"></div>
<table>
  <tr><td>${escape(p.method)}</td><td class="right">${escape(p.paid)}</td></tr>
  ${p.tendered ? `<tr><td>Tendered</td><td class="right">${escape(p.tendered)}</td></tr>` : ''}
  ${p.change ? `<tr><td>Change</td><td class="right">${escape(p.change)}</td></tr>` : ''}
  ${p.outstanding ? `<tr><td class="big">Still to pay</td><td class="right big">${escape(p.balance)}</td></tr>` : ''}
</table>
<div class="rule"></div>
<div class="small">Served by ${escape(p.cashier)}</div>
${p.footerText ? `<div class="mid small" style="margin-top:2mm">${escape(p.footerText)}</div>` : ''}
<div class="mid small" style="margin-top:2mm">Thank you &middot; Terima kasih</div>
</body>
</html>`;
}

function labelPage(p: LabelPayload): string {
  return `<!doctype html>
<html lang="ms">
<head>
<meta charset="utf-8">
<title>${escape(p.product)}</title>
<style>
@page { size: 50mm 30mm; margin: 2mm; }
body { font-family: Arial, sans-serif; font-size: 7pt; line-height: 1.25; margin: 0; color: #000; }
.clinic { font-size: 6.5pt; font-weight: 700; }
.name { font-weight: 700; }
.product { font-size: 8pt; font-weight: 700; margin: 1mm 0 .5mm; }
.warn { font-size: 5.5pt; margin-top: 1mm; }
</style>
</head>
<body>
<div class="clinic">${escape(p.clinicName)}${p.branchPhone ? ` · ${escape(p.branchPhone)}` : ''}</div>
<div class="name">${escape(p.patientName)}</div>
<div class="product">${escape(p.product)} · ${escape(p.quantity)}</div>
<div>${escape(p.instructions)}</div>
<div class="warn">${escape(p.batches)}</div>
<div class="warn">${p.warnings.map((w) => escape(w)).join('<br>')}</div>
</body>
</html>`;
}

/** DOC-F-16: an image if the doctor uploaded one, a typed block if not. */
function signature(sig: SignatureBlock, issuedAt: string): string {
  return `
<div class="sig">
  ${sig.imageDataUri ? `<img src="${sig.imageDataUri}" alt="">` : ''}
  <div class="line">
    <strong>${escape(sig.name)}</strong><br>
    ${sig.registrationNo ? `${escape(sig.registrationNo)}<br>` : ''}
    <span class="small">${escape(issuedAt)}</span>
  </div>
</div>`;
}

/**
 * Everything interpolated goes through here.
 *
 * A patient's name is text somebody typed, and a clinic that treats it
 * as markup has handed the person who typed it a way into every printed
 * document.
 */
export function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * DOC-T-03: the watermark is applied when a document is served, not when
 * it is stored. A reprint of the stored file has to be the same bytes as
 * the original, so the overlay is the one thing that is added later.
 */
/**
 * The document number, written in when the document is served.
 *
 * Rendering happens before the number is allocated — that is the whole
 * point of DOC-R-07's ordering, so that a failed render never spends a
 * number. The slot is left empty in the stored file and filled on the
 * way out, which keeps the stored bytes equal to what was rendered and
 * still puts a serial number on the paper the patient carries away.
 */
export function stampNumber(html: string, documentNo: string | null): string {
  if (!documentNo) return html;
  return html.replace(
    '<span class="docno" id="doc-no"></span>',
    `<span class="docno" id="doc-no">${escape(documentNo)}</span>`,
  );
}

export function withOverlay(
  html: string,
  overlay: 'COPY' | 'CANCELLED' | null,
): string {
  if (!overlay) return html;
  const tint =
    overlay === 'CANCELLED' ? 'rgba(200,0,0,.18)' : 'rgba(0,0,0,.10)';
  const style = `<style>
.overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 72pt; font-weight: 700; letter-spacing: .1em; color: ${tint};
  transform: rotate(-28deg); pointer-events: none; z-index: 9999; }
</style>`;
  const mark = `<div class="overlay">${overlay}</div>`;
  return html
    .replace('</head>', `${style}</head>`)
    .replace('</body>', `${mark}</body>`);
}
