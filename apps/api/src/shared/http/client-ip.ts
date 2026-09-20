import type { Request } from 'express';

/**
 * Express hands back IPv4 addresses in IPv4-mapped IPv6 form (`::ffff:1.2.3.4`)
 * whenever the listener is dual-stack. Audit rows and the sessions list are
 * read by people, so store the plain form.
 */
export function clientIp(req: Request): string | null {
  const raw = req.ip;
  if (!raw) return null;
  const unmapped = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
  return unmapped.slice(0, 45);
}
