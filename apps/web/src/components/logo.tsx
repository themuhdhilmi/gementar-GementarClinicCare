import Image from 'next/image';

/**
 * The lockup from `documents/media/logos/logo.png`, prepared for the web by
 * `scripts/build-logo-assets.mjs`.
 *
 * The whole lockup is used, tagline included. It is small at header sizes, and
 * that is the trade the brand asks for; `compact` drops the tagline if a
 * particular place ever needs the name to be bigger.
 *
 * The app is light-themed, so the only reason for the white-ink file is a
 * surface that is dark whatever the theme — the sign-in panel.
 */
export function Logo({
  className = 'h-10 w-auto',
  surface = 'light',
  compact = false,
  priority = false,
}: {
  className?: string;
  surface?: 'light' | 'dark';
  compact?: boolean;
  priority?: boolean;
}) {
  const name = `${compact ? 'logo-compact' : 'logo'}${surface === 'dark' ? '-dark' : ''}`;
  const size = compact ? { width: 720, height: 250 } : { width: 900, height: 312 };

  return (
    <Image
      src={`/brand/${name}.png`}
      alt="Gementar ClinicCare"
      {...size}
      className={className}
      priority={priority}
      // These are hand-tuned PNGs on the critical path of the sign-in screen.
      // Serving the file as built avoids a second, re-encoded copy that can
      // lag behind when the logo is regenerated.
      unoptimized
    />
  );
}

/** The mark alone, for places too narrow for the lockup. */
export function LogoMark({ className = 'size-8' }: { className?: string }) {
  return (
    <Image
      src="/brand/mark.png"
      alt=""
      aria-hidden
      width={512}
      height={512}
      className={className}
      unoptimized
    />
  );
}
