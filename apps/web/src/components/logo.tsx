import Image from 'next/image';

type Surface = 'auto' | 'dark';

/**
 * The lockup from `documents/media/logos/logo.png`, prepared for the web by
 * `scripts/build-logo-assets.mjs`. The wordmark is black, so a dark surface
 * needs the white version of it.
 *
 * `surface="dark"` is for places that are dark in both themes, such as the
 * sign-in panel. Everything else follows the reader's colour scheme.
 *
 * `compact` drops the tagline, which stops being readable below about 40px.
 */
export function Logo({
  className = 'h-8 w-auto',
  surface = 'auto',
  compact = false,
  priority = false,
}: {
  className?: string;
  surface?: Surface;
  compact?: boolean;
  priority?: boolean;
}) {
  const name = compact ? 'logo-compact' : 'logo';
  const size = compact ? { width: 720, height: 186 } : { width: 900, height: 312 };

  if (surface === 'dark') {
    return (
      <Image
        src={`/brand/${name}-dark.png`}
        alt="Gementar ClinicCare"
        {...size}
        className={className}
        priority={priority}
      />
    );
  }

  return (
    <>
      <Image
        src={`/brand/${name}.png`}
        alt="Gementar ClinicCare"
        {...size}
        className={`${className} dark:hidden`}
        priority={priority}
      />
      <Image
        src={`/brand/${name}-dark.png`}
        alt=""
        aria-hidden
        {...size}
        className={`${className} hidden dark:block`}
        priority={priority}
      />
    </>
  );
}

/** The mark alone. It reads on any background. */
export function LogoMark({ className = 'size-8' }: { className?: string }) {
  return (
    <Image src="/brand/mark.png" alt="" aria-hidden width={512} height={512} className={className} />
  );
}
