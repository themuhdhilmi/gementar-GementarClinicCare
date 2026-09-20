import { Logo } from './logo';

/**
 * The right half of the sign-in screen: black, with the brand red used as
 * light rather than as paint. Deliberately not marketing — everything claimed
 * here is something the system actually does, because the audience is the
 * clinic's own staff and they will notice if it is not true.
 */
export function BrandPanel() {
  return (
    <aside
      className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between"
      style={{
        background:
          'linear-gradient(155deg, var(--brand-from) 0%, var(--brand-mid) 52%, var(--brand-to) 100%)',
      }}
    >
      <Pattern />

      <div className="relative px-12 pt-12">
        <Logo className="h-20 w-auto" surface="dark" />
      </div>

      <div className="relative max-w-xl px-12">
        <h2 className="text-4xl font-semibold leading-[1.15] tracking-tight text-brand-ink">
          One patient,
          <br />
          door to door.
        </h2>
        <div
          aria-hidden
          className="mt-5 h-1 w-16 rounded-full"
          style={{ background: 'var(--primary)' }}
        />
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-brand-ink-muted">
          Register, triage, consult, prescribe, dispense, bill and take payment in one place, with
          nothing kept on paper alongside it.
        </p>

        <ul className="mt-10 space-y-5 border-t border-brand-rule pt-8">
          <Point
            title="Every action is attributed"
            body="Clinical records carry the name of whoever made them, and keep it."
            icon={<SignatureIcon />}
          />
          <Point
            title="Access ends when employment does"
            body="Disabling a member of staff signs them out everywhere, in the same moment."
            icon={<KeyIcon />}
          />
          <Point
            title="Sensitive access is recorded"
            body="An administrator reading clinical notes is allowed, and always visible afterwards."
            icon={<EyeIcon />}
          />
        </ul>
      </div>

      <div className="relative px-12 pb-12">
        <p className="text-xs leading-relaxed text-brand-ink-muted">
          Patient data stays in your clinic&rsquo;s own database.
          <br />
          Built for Malaysian general practice.
        </p>
      </div>
    </aside>
  );
}

function Point({
  title,
  body,
  icon,
}: {
  title: string;
  body: string;
  icon: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span
        aria-hidden
        className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md border text-brand-ink"
        style={{ background: 'rgba(230,1,7,0.14)', borderColor: 'rgba(230,1,7,0.38)' }}
      >
        {icon}
      </span>
      <div>
        <p className="text-sm font-semibold text-brand-ink">{title}</p>
        <p className="mt-0.5 max-w-sm text-sm leading-relaxed text-brand-ink-muted">{body}</p>
      </div>
    </li>
  );
}

/** A quiet clinical motif: a cross on a grid, at the edge of visibility. */
function Pattern() {
  return (
    <>
      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full opacity-[0.07]">
        <defs>
          <pattern id="cc-grid" width="88" height="88" patternUnits="userSpaceOnUse">
            <path d="M44 36V52M36 44H52" fill="none" stroke="#ff4b45" strokeWidth="1.4" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#cc-grid)" />
      </svg>
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 -top-32 size-[28rem] rounded-full"
        style={{ background: 'radial-gradient(circle, var(--brand-glow), transparent 68%)' }}
      />
    </>
  );
}

function SignatureIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17c3 0 4-10 7-10s3 10 6 10c1.5 0 2.5-1 2.5-1" />
      <path d="M4 21h16" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M17 12v4M20 12v3" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}
