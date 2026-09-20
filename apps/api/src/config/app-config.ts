import 'dotenv/config';
import { z } from 'zod';

/**
 * Typed, validated configuration. The process refuses to start if anything here
 * is missing or malformed — a half-configured auth service is worse than a
 * stopped one.
 */
const boolish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const base64Key = z
  .string()
  .min(1)
  .transform((v, ctx) => {
    const buf = Buffer.from(v, 'base64');
    if (buf.length !== 32) {
      ctx.addIssue({ code: 'custom', message: 'must be 32 bytes, base64-encoded' });
      return z.NEVER;
    }
    return buf;
  });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().max(100).default(10),
  /** `require` refuses to boot unless the DBA hardening script is installed. */
  DB_GUARD_MODE: z.enum(['auto', 'require', 'off']).default('auto'),

  APP_KEK_ACTIVE: z.string().regex(/^v\d+$/).default('v1'),
  APP_KEK_V1: base64Key,
  APP_KEK_V2: base64Key.optional(),
  APP_HASH_PEPPER: base64Key,

  COOKIE_SECURE: boolish.default(false),
  COOKIE_DOMAIN: z.string().optional(),
  // Shared clinic workstations (IAM-Q-02): an hour of inactivity closes the
  // session, and it cannot outlive the shift that started it.
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),
  REAUTH_MINUTES: z.coerce.number().int().positive().default(5),
  TRUSTED_DEVICE_DAYS: z.coerce.number().int().positive().default(30),

  LOGIN_MAX_FAILURES_PER_EMAIL: z.coerce.number().int().positive().default(5),
  LOGIN_MAX_FAILURES_PER_IP: z.coerce.number().int().positive().default(20),
  LOGIN_RATE_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  LOGIN_LOCKOUT_THRESHOLD: z.coerce.number().int().positive().default(10),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(30),

  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).default(65536),
  ARGON2_ITERATIONS: z.coerce.number().int().min(1).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),

  BREACH_CHECK_ENABLED: boolish.default(true),
  BREACH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(500),
  BREACH_API_URL: z.string().url().default('https://api.pwnedpasswords.com/range'),

  MAIL_TRANSPORT: z.enum(['console', 'noop', 'resend']).default('console'),
  MAIL_FROM: z.string().default('ClinicCare <no-reply@example.test>'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_API_URL: z.string().url().default('https://api.resend.com/emails'),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  webOrigins: string[];
  appBaseUrl: string;
  database: { url: string; poolSize: number; guardMode: 'auto' | 'require' | 'off' };
  crypto: { keks: Record<string, Buffer>; activeKekId: string; hashPepper: Buffer };
  cookie: {
    sessionName: string;
    deviceName: string;
    secure: boolean;
    domain?: string;
  };
  session: {
    idleMinutes: number;
    absoluteHours: number;
    reauthMinutes: number;
    trustedDeviceDays: number;
    /** Skip the `last_seen_at` write when the session was seen this recently. */
    touchIntervalSeconds: number;
  };
  login: {
    maxFailuresPerEmail: number;
    maxFailuresPerIp: number;
    rateWindowMinutes: number;
    lockoutThreshold: number;
    lockoutMinutes: number;
  };
  argon2: { memoryCost: number; timeCost: number; parallelism: number };
  breach: { enabled: boolean; timeoutMs: number; apiUrl: string };
  mail: {
    transport: 'console' | 'noop' | 'resend';
    from: string;
    resend: { apiKey?: string; apiUrl: string };
  };
  invite: { expiryHours: number };
  reset: { expiryMinutes: number };
};

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${detail}`);
  }
  const c = parsed.data;
  const keks: Record<string, Buffer> = { v1: c.APP_KEK_V1 };
  if (c.APP_KEK_V2) keks['v2'] = c.APP_KEK_V2;
  if (!keks[c.APP_KEK_ACTIVE]) {
    throw new Error(`Invalid configuration: APP_KEK_ACTIVE=${c.APP_KEK_ACTIVE} has no matching key`);
  }
  if (c.NODE_ENV === 'production' && !c.COOKIE_SECURE) {
    throw new Error('Invalid configuration: COOKIE_SECURE must be true in production');
  }
  if (c.MAIL_TRANSPORT === 'resend' && !c.RESEND_API_KEY) {
    throw new Error('Invalid configuration: MAIL_TRANSPORT=resend needs RESEND_API_KEY');
  }
  if (c.NODE_ENV === 'production' && c.MAIL_TRANSPORT === 'console') {
    // The console transport writes invite and reset links to the log. That is
    // fine on a laptop and a credential leak in production (IAM-N-05).
    throw new Error(
      'Invalid configuration: MAIL_TRANSPORT=console writes password links to the log; ' +
        'configure a real transport before running in production',
    );
  }

  return {
    nodeEnv: c.NODE_ENV,
    isProduction: c.NODE_ENV === 'production',
    port: c.PORT,
    webOrigins: c.WEB_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    appBaseUrl: c.APP_BASE_URL.replace(/\/$/, ''),
    database: { url: c.DATABASE_URL, poolSize: c.DATABASE_POOL_SIZE, guardMode: c.DB_GUARD_MODE },
    crypto: { keks, activeKekId: c.APP_KEK_ACTIVE, hashPepper: c.APP_HASH_PEPPER },
    cookie: {
      sessionName: 'cc_session',
      deviceName: 'cc_device',
      secure: c.COOKIE_SECURE,
      domain: c.COOKIE_DOMAIN || undefined,
    },
    session: {
      idleMinutes: c.SESSION_IDLE_MINUTES,
      absoluteHours: c.SESSION_ABSOLUTE_HOURS,
      reauthMinutes: c.REAUTH_MINUTES,
      trustedDeviceDays: c.TRUSTED_DEVICE_DAYS,
      touchIntervalSeconds: 60,
    },
    login: {
      maxFailuresPerEmail: c.LOGIN_MAX_FAILURES_PER_EMAIL,
      maxFailuresPerIp: c.LOGIN_MAX_FAILURES_PER_IP,
      rateWindowMinutes: c.LOGIN_RATE_WINDOW_MINUTES,
      lockoutThreshold: c.LOGIN_LOCKOUT_THRESHOLD,
      lockoutMinutes: c.LOGIN_LOCKOUT_MINUTES,
    },
    argon2: {
      memoryCost: c.ARGON2_MEMORY_KIB,
      timeCost: c.ARGON2_ITERATIONS,
      parallelism: c.ARGON2_PARALLELISM,
    },
    breach: {
      enabled: c.BREACH_CHECK_ENABLED,
      timeoutMs: c.BREACH_CHECK_TIMEOUT_MS,
      apiUrl: c.BREACH_API_URL.replace(/\/$/, ''),
    },
    mail: {
      transport: c.MAIL_TRANSPORT,
      from: c.MAIL_FROM,
      resend: { apiKey: c.RESEND_API_KEY, apiUrl: c.RESEND_API_URL },
    },
    invite: { expiryHours: 72 },
    reset: { expiryMinutes: 30 },
  };
}
