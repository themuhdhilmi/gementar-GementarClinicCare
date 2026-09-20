import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';

export type OutboundMail = {
  to: string;
  subject: string;
  text: string;
};

/**
 * A port with three transports (IAM-Q-03).
 *
 *   console  writes the link to the log and hands it back through the API, so
 *            staff can be onboarded before any provider exists. Refused in
 *            production, because a password link in a log is a credential leak.
 *   resend   the recommended provider: an HTTP call, no SDK, one API key.
 *   noop     for tests.
 *
 * Only two kinds of message exist, an invitation and a password reset, and
 * both are security-critical and short-lived. Sending never throws: it runs
 * after the transaction has committed, so a provider outage must not undo the
 * change that triggered it. A failure is logged loudly instead, and V1's `NTF`
 * module puts these on a durable queue with retries.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Whether callers may surface the raw link in an API response. */
  get linksAreNotDelivered(): boolean {
    return this.config.mail.transport === 'console';
  }

  async send(mail: OutboundMail): Promise<void> {
    const { transport } = this.config.mail;
    if (transport === 'noop') return;

    if (transport === 'console') {
      // Development only; configuration refuses this transport in production
      // so a link never reaches a production log (IAM-N-05).
      this.logger.log(
        `MAIL to=${mail.to} from=${this.config.mail.from} subject="${mail.subject}"\n${mail.text}`,
      );
      return;
    }

    await this.sendViaResend(mail);
  }

  private async sendViaResend(mail: OutboundMail): Promise<void> {
    const { resend, from } = this.config.mail;
    try {
      const response = await fetch(resend.apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resend.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        // The body can carry the provider's reason; it never carries our link.
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        this.logger.error(
          `Mail to ${mask(mail.to)} was rejected: ${response.status} ${detail}`,
        );
        return;
      }
      this.logger.log(`Mail sent to ${mask(mail.to)}: ${mail.subject}`);
    } catch (error) {
      this.logger.error(
        `Mail to ${mask(mail.to)} could not be sent: ${(error as Error).message}`,
      );
    }
  }

  async sendInvite(to: string, name: string, link: string, expiresAt: Date): Promise<void> {
    await this.send({
      to,
      subject: 'Set up your ClinicCare account',
      text:
        `Hi ${name},\n\n` +
        `An account has been created for you. Set your password here:\n${link}\n\n` +
        `The link expires at ${expiresAt.toISOString()} and can be used once.\n` +
        'Accounts are personal — never share them with a colleague.\n',
    });
  }

  async sendPasswordReset(to: string, name: string, link: string, expiresAt: Date): Promise<void> {
    await this.send({
      to,
      subject: 'Reset your ClinicCare password',
      text:
        `Hi ${name},\n\n` +
        `Use this link to choose a new password:\n${link}\n\n` +
        `It expires at ${expiresAt.toISOString()} and can be used once. ` +
        'Signing in again everywhere will be required afterwards.\n\n' +
        'If you did not ask for this, you can ignore it.\n',
    });
  }
}

/**
 * Logs carry enough of an address to match it to a support call, and not
 * enough to be a mailing list.
 */
function mask(address: string): string {
  const [name = '', domain = ''] = address.split('@');
  return `${name.slice(0, 2)}***@${domain}`;
}
