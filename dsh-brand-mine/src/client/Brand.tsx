/** Custom occupants for the shipped browser-brand slots. */

/** Geometry supplied by the sidebar and Hero mark hosts. */
interface BrandMarkProps {
  /** Requested square edge in pixels. */
  size?: number
  /** Host-supplied class name. */
  className?: string
}

/**
 * Badge styling mirrors the sidebar's own `.buildRevision` rule, including its
 * theme tokens, so the corner mark tracks light/dark with the rest of the
 * column. The occupant cannot reach the owner's CSS module, so the rule is
 * restated rather than imported.
 */
const BADGE_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  height: '16px',
  padding: '0 4px',
  borderRadius: '3px',
  color: 'var(--dsw-alias-label-primary-inverted)',
  background: 'var(--dsw-alias-label-primary)',
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: '8px',
  fontWeight: 500,
  lineHeight: '16px',
  letterSpacing: 0,
} as const

/** Matches the shell's `.fallbackBrandName` metrics so the row keeps its height. */
const NAME_STYLE = {
  fontSize: '17px',
  fontWeight: 600,
  letterSpacing: 0,
  whiteSpace: 'nowrap',
} as const

/**
 * Render the Genesis mark at the size its host surface requests.
 *
 * A honeycomb cell holding three nodes: the swarm reading ties the mark to the
 * Agents Swarm surface, and the hexagon stays legible at the 24px the sidebar
 * asks for and at the larger Hero size.
 * @param props - Host-supplied mark presentation.
 * @returns the Genesis cell mark.
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
      <path
        d="M16 3 L27.26 9.5 L27.26 22.5 L16 29 L4.74 22.5 L4.74 9.5 Z"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="11.6" r="2.5" fill="currentColor" />
      <circle cx="11.4" cy="19.6" r="2.5" fill="currentColor" />
      <circle cx="20.6" cy="19.6" r="2.5" fill="currentColor" />
    </svg>
  )
}

/**
 * Render the product name with its origin badge, without the independently
 * slotted mark.
 * @returns the Genesis Harness wordmark and the `deepseek` corner mark.
 */
export function MyBrandName() {
  return (
    <>
      <span style={NAME_STYLE}>Genesis Harness</span>
      <span style={BADGE_STYLE}>deepseek</span>
    </>
  )
}
