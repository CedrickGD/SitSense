// Settings (docs/specs/ui-v3.md §6): a category list on the left, one category on the
// right laid out as a grid of cards. Every control commits immediately ("Saved" fades in
// next to it). The list stays beside the cards only while they still get a 2-column grid;
// with less room it becomes a scrollable chip row above the content (measured, not guessed
// from the window width — the app shell's own panels take a varying share).

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import AiModelsSection from '@renderer/components/AiModelsSection'
import { Icon } from '@renderer/components/icons'
import { NavListItem, focusRing } from '@renderer/components/primitives'
import { SETTINGS_CATEGORIES, useAppStore, type SettingsCategoryId } from '@renderer/state/store'
import AboutPage from './settings/AboutPage'
import CameraPage from './settings/CameraPage'
import DetectionPage from './settings/DetectionPage'
import GeneralPage from './settings/GeneralPage'
import { CATEGORY_META, CATEGORY_NAV_WIDTH, categoryIntro, categoryNavMode, type CategoryNavMode } from './settings/meta'
import NotificationsPage from './settings/NotificationsPage'
import { CommitProvider } from './settings/parts'
import PrivacyPage from './settings/PrivacyPage'

const navId = (c: SettingsCategoryId): string => `settings-cat-${c}`

function CategoryList({
  current,
  onSelect,
  compact,
  width
}: {
  current: SettingsCategoryId
  onSelect: (c: SettingsCategoryId) => void
  compact: boolean
  width: number
}): JSX.Element {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number): void => {
    const n = SETTINGS_CATEGORIES.length
    let next: number | null = null
    if (e.key === 'ArrowDown') next = (i + 1) % n
    else if (e.key === 'ArrowUp') next = (i - 1 + n) % n
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    if (next === null) return
    e.preventDefault()
    document.getElementById(navId(SETTINGS_CATEGORIES[next]))?.focus()
  }
  return (
    <nav
      aria-label="Settings categories"
      className="sticky top-0 max-h-[calc(100vh-96px)] shrink-0 self-start overflow-y-auto p-1 -m-1"
      style={{ width: width + 8 }}
    >
      <ul className="flex flex-col gap-1">
        {SETTINGS_CATEGORIES.map((c, i) => {
          const meta = CATEGORY_META[c]
          return (
            <li key={c}>
              <NavListItem
                id={navId(c)}
                icon={meta.icon}
                title={meta.title}
                description={meta.description}
                compact={compact}
                selected={c === current}
                tabIndex={c === current ? 0 : -1}
                onKeyDown={(e) => onKeyDown(e, i)}
                onClick={() => onSelect(c)}
              />
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** Too little room for list + 2-column cards: the categories as a horizontal, scrollable chip row. */
function CategoryChips({
  current,
  onSelect
}: {
  current: SettingsCategoryId
  onSelect: (c: SettingsCategoryId) => void
}): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  // keep the selected chip in view (deep links, keyboard) without scrolling the page
  useEffect(() => {
    const row = rowRef.current
    const chip = row?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!row || !chip) return
    // the row is 'relative', so it is the chip's offsetParent: offsetLeft is already row-relative
    const left = chip.offsetLeft
    const right = left + chip.offsetWidth
    if (left < row.scrollLeft + 4) row.scrollTo({ left: Math.max(0, left - 16) })
    else if (right > row.scrollLeft + row.clientWidth - 40) row.scrollTo({ left: right - row.clientWidth + 48 })
  }, [current])
  return (
    <nav aria-label="Settings categories" className="-mx-1 mb-5">
      <div
        ref={rowRef}
        className="relative flex gap-1.5 overflow-x-auto py-1 pr-10 pl-1"
        style={{
          scrollbarWidth: 'none',
          maskImage: 'linear-gradient(to right, black calc(100% - 40px), transparent)'
        }}
      >
        {SETTINGS_CATEGORIES.map((c) => {
          const meta = CATEGORY_META[c]
          const selected = c === current
          return (
            <button
              key={c}
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => onSelect(c)}
              className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 type-body whitespace-nowrap transition-colors duration-150 ${focusRing('ink')} ${
                selected
                  ? 'bg-sage-soft font-medium text-sage ring-1 ring-sage/25'
                  : 'text-text-dim ring-1 ring-white/[0.08] hover:bg-white/[0.04] hover:text-text'
              }`}
            >
              <Icon name={meta.icon} size={16} />
              {meta.title}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

function CategoryContent({ category }: { category: SettingsCategoryId }): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  if (!settings) return <p className="type-body text-text-dim">Loading…</p>
  switch (category) {
    case 'general':
      return <GeneralPage settings={settings} />
    case 'camera':
      return <CameraPage settings={settings} />
    case 'detection':
      return <DetectionPage settings={settings} />
    case 'notifications':
      return <NotificationsPage settings={settings} />
    case 'ai':
      return <AiModelsSection />
    case 'privacy':
      return <PrivacyPage settings={settings} />
    case 'about':
      return <AboutPage settings={settings} />
  }
}

export default function SettingsScreen(): JSX.Element {
  const category = useAppStore((s) => s.settingsCategory)
  const setCategory = useAppStore((s) => s.setSettingsCategory)
  const version = useAppStore((s) => s.appVersion)
  const wrapRef = useRef<HTMLDivElement>(null)
  // the mode is kept as state so the next measurement can apply hysteresis against it
  // (categoryNavMode's `prev`): a width that only moves by a scrollbar can't flip it
  const [mode, setMode] = useState<CategoryNavMode>('chips')
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    setMode(categoryNavMode(el.getBoundingClientRect().width))
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined) setMode((prev) => categoryNavMode(w, prev))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const listWidth = CATEGORY_NAV_WIDTH[mode]
  const meta = CATEGORY_META[category]
  const headingId = 'settings-category-title'

  return (
    <CommitProvider>
      <div ref={wrapRef} className={mode === 'chips' ? 'flex flex-col' : 'flex items-start gap-6'}>
        {mode === 'chips' || listWidth === null ? (
          <CategoryChips current={category} onSelect={setCategory} />
        ) : (
          <CategoryList current={category} onSelect={setCategory} compact={mode === 'compact'} width={listWidth} />
        )}
        <section aria-labelledby={headingId} className="@container min-w-0 flex-1 pb-6">
          <header className="mb-5">
            <h2 id={headingId} className="type-h3 text-text">
              {meta.title}
            </h2>
            <p className="mt-1 max-w-[68ch] type-body-lg text-text-dim">{categoryIntro(category, version)}</p>
          </header>
          <div key={category} className="motion-safe:animate-[screenIn_180ms_ease-out]">
            <CategoryContent category={category} />
          </div>
        </section>
      </div>
    </CommitProvider>
  )
}
