// The one icon set (docs/specs/ui-v3.md §8.7). Inline SVG on a 20×20 viewBox,
// stroke = currentColor, 1.6 wide (1.4 at ≤ 16 px), round caps and joins. Fills only
// where the spec says so (spine, spark, dots). The same icon always means the same thing.

import type { JSX, ReactNode } from 'react'

export const ICON_NAMES = [
  'live',
  'coach',
  'history',
  'settings',
  'setup',
  'spine',
  'camera',
  'lines',
  'mesh',
  'eye',
  'eye-off',
  'pause',
  'play',
  'stop',
  'bell',
  'coffee',
  'spark',
  'send',
  'shield',
  'lock',
  'info',
  'check',
  'close',
  'plus',
  'minus',
  'alert',
  'chevron-left',
  'chevron-right',
  'chevron-down',
  'chevron-up',
  'arrow-down',
  'arrow-right',
  'trash',
  'copy',
  'refresh',
  'calendar',
  'more',
  'cpu',
  'keyboard'
] as const

export type IconName = (typeof ICON_NAMES)[number]

/** 6-tooth gear, built once. */
const GEAR_PATH = ((): string => {
  const teeth = 6
  const outer = 8.2
  const inner = 6.4
  const pts: string[] = []
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2 - Math.PI / 2
    const step = (Math.PI * 2) / teeth
    // tooth: inner → outer → outer → inner (narrow flat top)
    const seq: [number, number][] = [
      [a - step * 0.36, inner],
      [a - step * 0.17, outer],
      [a + step * 0.17, outer],
      [a + step * 0.36, inner]
    ]
    for (const [ang, r] of seq) pts.push(`${(10 + Math.cos(ang) * r).toFixed(2)} ${(10 + Math.sin(ang) * r).toFixed(2)}`)
  }
  return `M${pts.join(' L')} Z`
})()

const FILL = { fill: 'currentColor', stroke: 'none' } as const

const GLYPHS: Record<IconName, ReactNode> = {
  live: (
    <>
      <circle cx="10" cy="10" r="7.6" />
      <path d="M2.6 10.4H6.4L8 7l2.6 6.6 1.7-4.2 1 1h4.1" />
    </>
  ),
  coach: (
    <>
      <path d="M4.5 3.5h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9.2l-3.7 3v-3h-1a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" />
      <path {...FILL} d="M10 5.6c.35 1.75 1.1 2.5 2.85 2.85-1.75.35-2.5 1.1-2.85 2.85-.35-1.75-1.1-2.5-2.85-2.85C8.9 8.1 9.65 7.35 10 5.6z" />
    </>
  ),
  history: (
    <>
      <path d="M2.5 16.8h15" />
      <rect x="4" y="10.5" width="3" height="6.3" rx="1" />
      <rect x="8.5" y="4" width="3" height="12.8" rx="1" />
      <rect x="13" y="7.5" width="3" height="9.3" rx="1" />
    </>
  ),
  settings: (
    <>
      <path d={GEAR_PATH} />
      <circle cx="10" cy="10" r="2.6" />
    </>
  ),
  setup: (
    <>
      <circle cx="10" cy="3.8" r="2" />
      <path d="M9.6 7.4c-.9 2.2-.9 4.3.2 6.3h5l.7 3.8" />
      <path d="M5.6 6.5v11" />
      <path d="M5.6 13.7h3.6" />
    </>
  ),
  spine: (
    <>
      {/* four vertebrae on a gentle S-curve (horizontal capsules — never a "dots" menu) */}
      <rect {...FILL} x="7.4" y="2" width="6.2" height="3.2" rx="1.6" />
      <rect {...FILL} x="6" y="6.4" width="7" height="3.2" rx="1.6" />
      <rect {...FILL} x="6.4" y="10.8" width="7" height="3.2" rx="1.6" />
      <rect {...FILL} x="7.8" y="15.2" width="6.2" height="3.2" rx="1.6" />
    </>
  ),
  camera: (
    <>
      <path d="M3 6.5h2.6L7.2 4.4h5.6l1.6 2.1H17a1.5 1.5 0 0 1 1.5 1.5v7.5A1.5 1.5 0 0 1 17 17H3a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 3 6.5z" />
      <circle cx="10" cy="11.6" r="3" />
    </>
  ),
  lines: (
    <>
      <path d="M13.8 2.8v14.4" strokeDasharray="1.4 2.2" />
      <path d="M6.8 3.8L9 9.6 7.8 16.2" />
      <circle {...FILL} cx="6.8" cy="3.8" r="1.7" />
      <circle {...FILL} cx="9" cy="9.6" r="1.7" />
      <circle {...FILL} cx="7.8" cy="16.2" r="1.7" />
    </>
  ),
  mesh: (
    <>
      <circle cx="10" cy="4.6" r="2.3" />
      <path d="M4.5 17.5v-4.6a5.5 5.5 0 0 1 11 0v4.6z" />
      <path d="M4.5 13.6l3 3.9 2.5-3.9 2.5 3.9 3-3.9M4.9 12.9h10.2M7.5 8.4l2.5 4.5 2.5-4.5" />
    </>
  ),
  eye: (
    <>
      <path d="M1.8 10S4.8 4.5 10 4.5 18.2 10 18.2 10 15.2 15.5 10 15.5 1.8 10 1.8 10z" />
      <circle cx="10" cy="10" r="2.6" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M8.2 4.7c.6-.1 1.2-.2 1.8-.2 5.2 0 8.2 5.5 8.2 5.5a14 14 0 0 1-2.1 2.8M12.1 12.2A2.6 2.6 0 0 1 7.8 8.4" />
      <path d="M5.2 6.1A13.5 13.5 0 0 0 1.8 10s3 5.5 8.2 5.5c1.5 0 2.8-.4 3.9-1" />
      <path d="M3 3l14 14" />
    </>
  ),
  pause: <path d="M7.5 4.8v10.4M12.5 4.8v10.4" strokeWidth="2" />,
  play: <path d="M6.5 4.4v11.2l9-5.6z" />,
  stop: <rect x="5" y="5" width="10" height="10" rx="2.5" />,
  bell: (
    <>
      <path d="M5 13.6V9.2a5 5 0 0 1 10 0v4.4l1.5 2H3.5z" />
      <path d="M8.2 17.6a2 2 0 0 0 3.6 0" />
    </>
  ),
  coffee: (
    <>
      <path d="M3.8 8.2h10.4v4.3a4 4 0 0 1-4 4H7.8a4 4 0 0 1-4-4z" />
      <path d="M14.2 9.4h1.1a2 2 0 0 1 0 4h-1.4" />
      <path d="M7.2 2.8c-.7.8.6 1.6 0 2.7M10.8 2.8c-.7.8.6 1.6 0 2.7" />
    </>
  ),
  spark: (
    <>
      <path {...FILL} d="M9 2c.7 4.2 2.3 5.8 6.5 6.5-4.2.7-5.8 2.3-6.5 6.5-.7-4.2-2.3-5.8-6.5-6.5C6.7 7.8 8.3 6.2 9 2z" />
      <path {...FILL} d="M15.2 12.6c.25 1.4.8 1.95 2.2 2.2-1.4.25-1.95.8-2.2 2.2-.25-1.4-.8-1.95-2.2-2.2 1.4-.25 1.95-.8 2.2-2.2z" />
    </>
  ),
  send: (
    <>
      <path d="M17.6 2.4L2.4 8.9l6.1 2.6 2.6 6.1z" />
      <path d="M17.6 2.4L8.5 11.5" />
    </>
  ),
  shield: <path d="M10 2l6.5 2.6v4.6c0 4-2.7 7-6.5 8.8-3.8-1.8-6.5-4.8-6.5-8.8V4.6z" />,
  lock: (
    <>
      <rect x="4.5" y="8.8" width="11" height="8.7" rx="2" />
      <path d="M7 8.8V6.5a3 3 0 0 1 6 0v2.3M10 12.2v2.2" />
    </>
  ),
  info: (
    <>
      <circle cx="10" cy="10" r="7.6" />
      <path d="M10 9.2v4.8" />
      <circle {...FILL} cx="10" cy="6.4" r="1" />
    </>
  ),
  check: <path d="M4.5 10.5L8 14l7.5-8" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  plus: <path d="M10 4v12M4 10h12" />,
  minus: <path d="M4 10h12" />,
  alert: (
    <>
      <path d="M10 2.8l7.8 13.7H2.2z" />
      <path d="M10 8.2v3.8" />
      <circle {...FILL} cx="10" cy="14.2" r="1" />
    </>
  ),
  'chevron-left': <path d="M12.5 4.5L7 10l5.5 5.5" />,
  'chevron-right': <path d="M7.5 4.5L13 10l-5.5 5.5" />,
  'chevron-down': <path d="M4.5 7.5L10 13l5.5-5.5" />,
  'chevron-up': <path d="M4.5 12.5L10 7l5.5 5.5" />,
  'arrow-down': <path d="M10 3.5v13M4.5 11l5.5 5.5 5.5-5.5" />,
  'arrow-right': <path d="M3.5 10h13M11 4.5l5.5 5.5-5.5 5.5" />,
  trash: (
    <>
      <path d="M3.5 5.5h13M8 5.5V3.8h4v1.7" />
      <path d="M5 5.5l.8 11a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4l.8-11M8.5 9v5.5M11.5 9v5.5" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7" />
    </>
  ),
  refresh: (
    <>
      <path d="M16.2 10a6.2 6.2 0 1 1-1.9-4.5" />
      <path d="M16.4 3.4v3.4H13" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4.5" width="14" height="13" rx="2" />
      <path d="M3 8.5h14M7 2.5v4M13 2.5v4" />
    </>
  ),
  more: (
    <>
      <circle {...FILL} cx="4.6" cy="10" r="1.5" />
      <circle {...FILL} cx="10" cy="10" r="1.5" />
      <circle {...FILL} cx="15.4" cy="10" r="1.5" />
    </>
  ),
  cpu: (
    <>
      <rect x="5" y="5" width="10" height="10" rx="1.6" />
      <rect x="8" y="8" width="4" height="4" rx="0.6" />
      <path d="M8 2.6V5M12 2.6V5M8 15v2.4M12 15v2.4M2.6 8H5M2.6 12H5M15 8h2.4M15 12h2.4" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2" y="5" width="16" height="10.5" rx="2" />
      <path d="M5.5 8.6h.01M8.5 8.6h.01M11.5 8.6h.01M14.5 8.6h.01M6.5 12.2h7" strokeWidth="1.8" />
    </>
  )
}

export interface IconProps {
  name: IconName
  /** px; 20 by default (the viewBox), 16 for dense rows */
  size?: number
  className?: string
  /** override the stroke width (defaults: 1.6, or 1.4 at ≤ 16 px) */
  strokeWidth?: number
  /** accessible name — only for icons that carry meaning on their own (most are aria-hidden) */
  label?: string
}

export function Icon({ name, size = 20, className, strokeWidth, label }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? (size <= 16 ? 1.4 : 1.6)}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className ?? ''}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  )
}

export default Icon
