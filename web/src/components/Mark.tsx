/**
 * The VeriCall mark, inlined from `/public/favicon.svg` so the masthead carries
 * the same geometry as the browser tab. Nothing decorative: the payment line
 * enters the verification gate and leaves as two streams, with the breach
 * return arc back to the payer.
 */
export function Mark({ size = 34, decorative = false }: { size?: number; decorative?: boolean }) {
  return (
    <svg
      className="brand__mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "VeriCall"}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    >
      <rect width="64" height="64" rx="12" fill="#0D1117" />
      <path d="M6 32h13" stroke="#E6EDF3" strokeWidth="4" strokeLinecap="round" />
      <path
        d="M19 32l9-13 9 13-9 13z"
        fill="none"
        stroke="#0052FF"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path
        d="M24.5 32.5l3 3 5.5-6.5"
        fill="none"
        stroke="#0052FF"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M37 32h6l8-14" stroke="#059669" strokeWidth="4" strokeLinecap="round" />
      <path d="M37 32h6l8 14" stroke="#059669" strokeWidth="4" strokeLinecap="round" />
      <path
        d="M45 50c8 0 12-8 12-8"
        stroke="#D97706"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeDasharray="5 4"
      />
      <circle cx="51" cy="18" r="3.4" fill="#059669" />
      <circle cx="51" cy="46" r="3.4" fill="#059669" />
    </svg>
  );
}
