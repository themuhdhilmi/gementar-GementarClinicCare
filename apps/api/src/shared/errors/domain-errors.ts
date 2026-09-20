/**
 * Domain errors carry everything the RFC 7807 response needs. Services throw
 * these; the exception filter renders them. Nothing here ever carries a
 * credential, a token or a hash — see IAM-N-05.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(detail ?? title);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(detail: string, code = 'bad_request', extra?: Record<string, unknown>) {
    super(400, code, 'Bad request', detail, extra);
  }
}

/** Deliberately uniform: callers must not learn why authentication failed (IAM-R-07). */
export class AuthenticationFailedError extends AppError {
  constructor(detail = 'Email or password is incorrect.') {
    super(401, 'authentication_failed', 'Authentication failed', detail);
  }
}

export class SessionInvalidError extends AppError {
  constructor(detail = 'Your session has ended. Please sign in again.') {
    super(401, 'session_invalid', 'Session invalid', detail);
  }
}

/**
 * TEN-F-03: a suspended clinic is refused with 403, not 401. The distinction
 * matters to whoever is holding the screen: 401 means "sign in again", which
 * they will try, and fail, and try again. 403 with this message tells them the
 * truth, which is that signing in is not the problem. The data is untouched.
 */
export class TenantSuspendedError extends AppError {
  constructor(
    detail = 'This clinic account is suspended. Nothing has been deleted. Please contact support to restore access.',
  ) {
    super(403, 'tenant_suspended', 'Clinic suspended', detail);
  }
}

export class MfaRequiredError extends AppError {
  constructor(detail = 'Multi-factor authentication is required before continuing.') {
    super(403, 'mfa_required', 'MFA required', detail);
  }
}

export class MfaEnrolmentRequiredError extends AppError {
  constructor(detail = 'Your role requires MFA. Enrol before continuing.') {
    super(403, 'mfa_enrolment_required', 'MFA enrolment required', detail);
  }
}

export class ReauthRequiredError extends AppError {
  constructor(detail = 'Confirm your identity to continue.') {
    super(403, 'reauth_required', 'Re-authentication required', detail);
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = 'You do not have permission to do that.', extra?: Record<string, unknown>) {
    super(403, 'forbidden', 'Forbidden', detail, extra);
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Resource', detail?: string) {
    super(404, 'not_found', `${what} not found`, detail ?? `${what} not found.`);
  }
}

export class ConflictError extends AppError {
  constructor(detail: string, code = 'conflict', extra?: Record<string, unknown>) {
    super(409, code, 'Conflict', detail, extra);
  }
}

export class RateLimitedError extends AppError {
  constructor(
    readonly retryAfterSeconds: number,
    detail = 'Too many attempts. Try again later.',
  ) {
    super(429, 'rate_limited', 'Too many requests', detail, {
      retryAfter: retryAfterSeconds,
    });
  }
}

export class InvariantViolationError extends AppError {
  constructor(code: string, detail: string) {
    super(422, code, 'Rule violation', detail);
  }
}

/** Raised by the tenant-scope layer. Never expected in normal operation. */
export class TenantScopeError extends AppError {
  constructor(detail: string) {
    super(500, 'tenant_scope_error', 'Tenant scope error', detail);
  }
}
