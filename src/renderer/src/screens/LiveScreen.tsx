// Live (docs/specs/ui-v3.md §3): "How am I sitting right now?" The camera is the hero and
// the score explains it. A 12-column grid, 16 px gaps:
//   banners (at most one, full width)
//   row 1: camera hero · Posture card (equal height; the camera is ≥ 16:9 and the card
//          may stretch the row — the video is object-cover, overlays stay aligned)
//   row 2: Today · Sitting · Coach (equal heights, min 176) — it takes whatever height the
//          window has left, so a tall window grows the cards instead of leaving a gap
// Three tiers by window width:
//   ≥ 1180       8/4 · then 6/3/3
//   1000–1179    7/5 · then 5/3/4 (the Coach card stays above the fold at 1000×700)
//   < 1000       7/5 · then Today full width, Sitting / Coach side by side
// Nothing scrolls sideways at 780×580.

import type { JSX } from 'react'
import { useAppStore } from '@renderer/state/store'
import { useWindowHeight, useWindowWidth } from '@renderer/lib/hooks'
import { TopBarContent } from '@renderer/components/AppShell'
import { Button } from '@renderer/components/primitives'
import CameraHero from './live/CameraHero'
import PostureCard from './live/PostureCard'
import TodayCard from './live/TodayCard'
import SittingCard from './live/SittingCard'
import CoachCard from './live/CoachCard'
import LiveBanners from './live/LiveBanners'
import { useFillHeight } from './live/useFillHeight'

/** Below this window width the posture card is too narrow for 8/4 with full gauges. */
const FULL_LAYOUT_MIN_WIDTH = 1180
/** Below this width row 2 can't hold three cards side by side and stacks. */
const MID_LAYOUT_MIN_WIDTH = 1000

/** Row 2 taller than this (the cards are, too) spends the room: 28 px timeline, longer thread. */
const ROOMY_ROW = 220

const ROW2_SPANS = {
  full: { today: 'col-span-6', sitting: 'col-span-3', coach: 'col-span-3' },
  mid: { today: 'col-span-5', sitting: 'col-span-3', coach: 'col-span-4' },
  stacked: { today: 'col-span-12', sitting: 'col-span-6', coach: 'col-span-6' }
} as const

export default function LiveScreen(): JSX.Element {
  const calibrated = useAppStore((s) => !!s.settings?.calibration)
  const openSetup = useAppStore((s) => s.openSetup)
  const width = useWindowWidth()
  const height = useWindowHeight()
  const full = width >= FULL_LAYOUT_MIN_WIDTH
  const spans = ROW2_SPANS[full ? 'full' : width >= MID_LAYOUT_MIN_WIDTH ? 'mid' : 'stacked']
  const short = height < 700
  // fill the viewport so spare height goes to row 2 (flex-1) rather than a gap below it;
  // the cards spend it (a taller timeline, a longer coach thread)
  const { rootRef, lastRowRef, fill, lastRowRoom } = useFillHeight<HTMLDivElement, HTMLDivElement>()
  // the height one card row gets (stacked, row 2 holds two card rows 16 px apart)
  const cardRoom = spans === ROW2_SPANS.stacked ? (lastRowRoom - 16) / 2 : lastRowRoom
  const roomy = cardRoom > ROOMY_ROW

  return (
    <div ref={rootRef} className="flex min-h-full flex-col gap-4" style={{ minHeight: fill }}>
      <TopBarContent>
        {calibrated ? (
          <Button size="sm" variant="ghost" icon="setup" onClick={() => openSetup()}>
            Redo posture setup
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon="setup" onClick={() => openSetup()}>
            Set up posture
          </Button>
        )}
      </TopBarContent>

      <LiveBanners />

      <div className="grid grid-cols-12 gap-4">
        {/* the spacer gives the cell its 16:9 minimum; the hero fills whatever the row is */}
        <div className={`relative min-w-0 ${full ? 'col-span-8' : 'col-span-7'}`}>
          <div aria-hidden className="aspect-video w-full" />
          <div className="absolute inset-0">
            <CameraHero />
          </div>
        </div>
        <div className={`min-w-0 ${full ? 'col-span-4' : 'col-span-5'}`}>
          <PostureCard ringSize={full && !short ? 112 : 88} showTracks={full && !short} />
        </div>
      </div>

      {/* flex-1: spare window height goes to row 2 (the cards are h-full) */}
      <div ref={lastRowRef} className="grid flex-1 grid-cols-12 gap-4 [&>*]:min-h-44">
        <div className={`min-w-0 ${spans.today}`}>
          <TodayCard timelineHeight={roomy ? 28 : short ? 16 : 20} room={spans === ROW2_SPANS.stacked ? 0 : cardRoom} />
        </div>
        <div className={`min-w-0 ${spans.sitting}`}>
          <SittingCard />
        </div>
        <div className={`min-w-0 ${spans.coach}`}>
          <CoachCard room={cardRoom} />
        </div>
      </div>
    </div>
  )
}
