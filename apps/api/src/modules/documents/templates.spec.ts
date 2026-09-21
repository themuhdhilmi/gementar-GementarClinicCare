import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DocumentType } from '../../generated/prisma/enums.js';
import {
  NUMBERED,
  TARGET_FOR,
  TYPE_CODE,
  escape,
  render,
  stampNumber,
  type McPayload,
  withOverlay,
} from './templates.js';

const letterhead = {
  clinicName: 'Klinik Gementar',
  branchName: 'Cawangan Cheras',
  logoDataUri: null,
  headerText: 'Pendaftaran 12345-A',
  footerText: 'Terima kasih.',
  addressLine1: '1 Jalan Cheras',
  addressLine2: 'Kuala Lumpur',
  phone: '03-1234 5678',
};

const mc: McPayload = {
  kind: 'MC',
  letterhead,
  patientName: 'Ahmad bin Zulkifli',
  patientIdNumber: '880114-14-5533',
  fromDate: '2026-09-21',
  toDate: '2026-09-22',
  days: 2,
  lightDuty: false,
  diagnosis: null,
  signature: {
    name: 'Dr Farid',
    registrationNo: 'MMC 55512',
    imageDataUri: null,
  },
  issuedAt: '2026-09-21 09:30',
  verificationCode: 'K3M9QX2FA1',
};

describe('DOC-N-04 — templates render identically every time', () => {
  it('is a pure function of its payload', () => {
    const once = render(mc, 'CH-MC-2026-000001');
    const twice = render(mc, 'CH-MC-2026-000001');
    expect(once).toBe(twice);
    expect(createHash('sha256').update(once).digest('hex')).toBe(
      createHash('sha256').update(twice).digest('hex'),
    );
  });

  it('changes when the payload changes, and not otherwise', () => {
    const base = render(mc, 'CH-MC-2026-000001');
    expect(
      render({ ...mc, days: 3, toDate: '2026-09-23' }, 'CH-MC-2026-000001'),
    ).not.toBe(base);
    expect(render(mc, 'CH-MC-2026-000002')).not.toBe(base);
  });
});

describe('DOC-F-05 — the certificate', () => {
  it('says the same thing in both languages', () => {
    const html = render(mc, 'CH-MC-2026-000001');
    expect(html).toContain('tidak sihat untuk bertugas');
    expect(html).toContain('unfit for duty');
    expect(html).toContain('Ahmad bin Zulkifli');
  });

  it('carries the full identity number, because it is an identity document', () => {
    expect(render(mc, null)).toContain('880114-14-5533');
  });

  it('leaves the diagnosis off unless the patient asked for it', () => {
    expect(render(mc, null)).not.toContain('Diagnosis');
    expect(render({ ...mc, diagnosis: 'Viral fever' }, null)).toContain(
      'Viral fever',
    );
  });

  it('names the doctor and their registration', () => {
    const html = render(mc, null);
    expect(html).toContain('Dr Farid');
    expect(html).toContain('MMC 55512');
  });

  it('says so when the patient may do light duty', () => {
    expect(render(mc, null)).not.toContain('light duty');
    expect(render({ ...mc, lightDuty: true }, null)).toContain(
      'Fit for light duty',
    );
  });
});

describe('A patient name is text, not markup', () => {
  it('escapes everything it interpolates', () => {
    const nasty = render(
      { ...mc, patientName: '<script>alert("x")</script>' },
      'CH-MC-2026-000001',
    );
    expect(nasty).not.toContain('<script>');
    expect(nasty).toContain('&lt;script&gt;');
  });

  it('escapes the characters that matter', () => {
    expect(escape(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('escapes the letterhead too, which an administrator typed', () => {
    const html = render(
      {
        ...mc,
        letterhead: { ...letterhead, footerText: '</style><script>x</script>' },
      },
      null,
    );
    expect(html).not.toContain('<script>');
  });
});

describe('DOC-T-03 — the overlay is applied at print time', () => {
  it('leaves the stored html alone', () => {
    const stored = render(mc, 'CH-MC-2026-000001');
    expect(stored).not.toContain('overlay');
    expect(withOverlay(stored, null)).toBe(stored);
  });

  it('adds a watermark without touching what the document says', () => {
    const stored = render(mc, 'CH-MC-2026-000001');
    const copy = withOverlay(stored, 'COPY');
    expect(copy).toContain('>COPY<');
    expect(copy).toContain('Ahmad bin Zulkifli');
    // The original is unchanged, which is what makes a reprint
    // byte-identical to what was handed over.
    expect(stored).not.toContain('>COPY<');
  });

  it('marks a cancelled document differently from a copy', () => {
    const stored = render(mc, null);
    expect(withOverlay(stored, 'CANCELLED')).toContain('>CANCELLED<');
    expect(withOverlay(stored, 'CANCELLED')).not.toContain('>COPY<');
  });
});

describe('Every document type is accounted for', () => {
  const types = Object.values(DocumentType);

  it('has a print target', () => {
    const missing = types.filter((type) => !TARGET_FOR[type]);
    expect(missing, `no print target for: ${missing.join(', ')}`).toEqual([]);
  });

  it('has a code for its number', () => {
    const missing = types.filter((type) => !TYPE_CODE[type]);
    expect(missing, `no number code for: ${missing.join(', ')}`).toEqual([]);
  });

  it('numbers the ones that are legal documents and not the ones that are not', () => {
    expect(NUMBERED.has(DocumentType.MC)).toBe(true);
    expect(NUMBERED.has(DocumentType.REFERRAL)).toBe(true);
    // A label and a queue ticket are printed by the hundred and nobody
    // ever refers to one by number.
    expect(NUMBERED.has(DocumentType.LABEL)).toBe(false);
    expect(NUMBERED.has(DocumentType.QUEUE_TICKET)).toBe(false);
  });
});

describe('DOC-F-09 — the medication label', () => {
  it('fits what a patient needs onto 50 by 30 millimetres', () => {
    const html = render(
      {
        kind: 'LABEL',
        clinicName: 'Klinik Gementar',
        branchPhone: '03-1234 5678',
        patientName: 'Ahmad bin Zulkifli',
        product: 'Amoxicillin 500 mg',
        quantity: '15 cap',
        instructions: 'Ambil 1 biji, 3 kali sehari. Selama 5 hari.',
        batches: 'Lot A-100 exp 2027-03',
        warnings: ['Simpan jauh dari jangkauan kanak-kanak.'],
        dispensedAt: '2026-09-21',
      },
      null,
    );
    expect(html).toContain('size: 50mm 30mm');
    expect(html).toContain('Ambil 1 biji');
    expect(html).toContain('kanak-kanak');
  });
});

describe('stampNumber', () => {
  const head = {
    clinicName: 'Klinik Ujian',
    branchName: 'Cawangan Utama',
    logoDataUri: null,
    headerText: '',
    footerText: '',
    addressLine1: null,
    addressLine2: null,
    phone: null,
  };
  const payload = {
    kind: 'MC' as const,
    letterhead: head,
    patientName: 'Siti binti Ahmad',
    patientIdNumber: '850101-10-1234',
    fromDate: '2026-09-21',
    toDate: '2026-09-22',
    days: 2,
    lightDuty: false,
    diagnosis: null,
    signature: { name: 'Dr Lee', registrationNo: null, imageDataUri: null },
    issuedAt: '2026-09-21 09:00',
    verificationCode: 'ABCD-1234',
  };

  it('fills the slot the renderer left empty', () => {
    const stored = render(payload, null);
    expect(stored).toContain('<span class="docno" id="doc-no"></span>');

    const served = stampNumber(stored, 'KL01-MC-2026-000012');
    expect(served).toContain('KL01-MC-2026-000012');
    // Nothing else moved: the difference is the number and only the number.
    expect(served.replace('KL01-MC-2026-000012', '')).toBe(stored);
  });

  it('leaves an unnumbered document alone', () => {
    const stored = render(payload, null);
    expect(stampNumber(stored, null)).toBe(stored);
  });

  it('escapes a number, because everything printed is escaped', () => {
    const served = stampNumber(render(payload, null), '<script>x</script>');
    expect(served).not.toContain('<script>x</script>');
    expect(served).toContain('&lt;script&gt;');
  });
});
