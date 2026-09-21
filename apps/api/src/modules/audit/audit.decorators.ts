import { SetMetadata } from '@nestjs/common';
import type { AuditActionName } from './audit.actions.js';

export const AUDITED_KEY = 'aud:audited';
export const NOT_AUDITED_KEY = 'aud:not-audited';

/**
 * AUD-F-03, AUD-R-03: this route changes something, and the change is
 * recorded.
 *
 * The decorator is a **declaration**, not the mechanism. Nearly every
 * service in this system already writes its own entry inside the same
 * transaction as the change — which is richer than anything an
 * interceptor could reconstruct from a response body, and is the only
 * way AUD-R-02 can hold. What the decorator adds is two things the
 * explicit calls cannot give on their own:
 *
 *   - a **backstop**: if the handler succeeds and nothing was written,
 *     `AuditInterceptor` writes a plain entry rather than letting the
 *     change go unrecorded;
 *   - a **list**: `npm run lint:audited` walks every mutating route and
 *     fails when one carries neither this nor `@NotAudited`.
 *
 * So the audit trail is not "whatever the services remembered to do".
 * It is every mutating route, by construction, with the services adding
 * detail on top.
 */
export const Audited = (action: AuditActionName, entityType?: string) =>
  SetMetadata(AUDITED_KEY, { action, entityType });

/**
 * Declares, on the record, that a mutating route writes nothing worth
 * auditing — or audits somewhere else that the route cannot see.
 *
 * The reason is required and shows up in the lint output. "It is just a
 * search" is a reason; silence is not.
 */
export const NotAudited = (reason: string) =>
  SetMetadata(NOT_AUDITED_KEY, reason);
