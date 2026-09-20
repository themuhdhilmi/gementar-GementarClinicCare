import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';

export type OutboundMail = {
  to: string;
  subject: string;
  text: string;
};

/**
 * A port, not an implementation. The transactional provider is IAM-Q-01's
 * sibling open question (IAM-Q-03); until it is answered the console transport
 * keeps V0 moving, and the invite link is also returned to the administrator in
 * the API response so staff can be onboarded without email at all.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Whether callers may surface the raw link in an API response. */
  get linksAreNotDelivered(): boolean {
    return this.config.mail.transport !== 'console' ? false : true;
  }

  async send(mail: OutboundMail): Promise<void> {
    if (this.config.mail.transport === 'noop') return;
    // Development only; configuration refuses this transport in production so a
    // link never reaches a production log (IAM-N-05).
    this.logger.log(
      `MAIL to=${mail.to} from=${this.config.mail.from} subject="${mail.subject}"\n${mail.text}`,
    );
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
