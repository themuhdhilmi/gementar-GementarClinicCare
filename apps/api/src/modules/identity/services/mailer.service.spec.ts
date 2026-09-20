import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailerService } from './mailer.service.js';
import { loadAppConfig } from '../../../config/app-config.js';

function config(overrides: Record<string, string> = {}) {
  return loadAppConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    APP_KEK_V1: randomBytes(32).toString('base64'),
    APP_HASH_PEPPER: randomBytes(32).toString('base64'),
    ...overrides,
  } as NodeJS.ProcessEnv);
}

describe('MailerService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses to be configured for Resend without a key', () => {
    expect(() => config({ MAIL_TRANSPORT: 'resend' })).toThrow(/RESEND_API_KEY/);
  });

  it('sends an invitation through the provider', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"id":"abc"}', { status: 200 }));

    const mailer = new MailerService(
      config({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'test-key', MAIL_FROM: 'ClinicCare <no-reply@clinic.test>' }),
    );
    await mailer.sendInvite('siti@klinik.my', 'Dr Siti', 'https://app/set?token=x', new Date());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init).toBeDefined();
    expect((init!.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
    const body = JSON.parse(init!.body as string);
    expect(body.to).toEqual(['siti@klinik.my']);
    expect(body.from).toBe('ClinicCare <no-reply@clinic.test>');
    expect(body.text).toContain('https://app/set?token=x');
  });

  it('does not throw when the provider is down, because the work already committed', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const mailer = new MailerService(config({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k' }));
    await expect(
      mailer.sendPasswordReset('a@b.test', 'A', 'https://app/reset?token=y', new Date()),
    ).resolves.toBeUndefined();
  });

  it('does not throw when the provider rejects the message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"message":"domain not verified"}', { status: 403 }));
    const mailer = new MailerService(config({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k' }));
    await expect(mailer.send({ to: 'a@b.test', subject: 's', text: 't' })).resolves.toBeUndefined();
  });

  it('only offers to show the link back when nothing is actually delivering it', () => {
    expect(new MailerService(config()).linksAreNotDelivered).toBe(true);
    expect(
      new MailerService(config({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k' })).linksAreNotDelivered,
    ).toBe(false);
    expect(new MailerService(config({ MAIL_TRANSPORT: 'noop' })).linksAreNotDelivered).toBe(false);
  });

  it('sends nothing at all on the noop transport', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await new MailerService(config({ MAIL_TRANSPORT: 'noop' })).send({ to: 'a@b.test', subject: 's', text: 't' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
