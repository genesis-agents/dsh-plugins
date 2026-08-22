/** Custom occupants for the shipped browser-brand slots. */

/** Geometry supplied by the sidebar and Hero mark hosts. */
interface BrandMarkProps {
  /** Requested square edge in pixels. */
  size?: number
  /** Host-supplied class name. */
  className?: string
}

/**
 * Render the custom mark at the size its host surface requests.
 * @param props - Host-supplied mark presentation.
 * @returns the custom monogram mark.
 */
export function MyBrandMark({ size = 24, className }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="29" height="29" rx="8.5" stroke="currentColor" strokeWidth="2.2" />
      <path
        d="M9 22.5V10.5L16 18l7-7.5v12"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Render the custom name artwork without its independently slotted mark.
 * @returns the custom wordmark.
 */
export function MyBrandName() {
  return <span style={{ fontWeight: 650, letterSpacing: '-0.01em' }}>My Harness</span>
}
