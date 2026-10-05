// Settings › General (ui-v3 §6.2): startup, window and posture setup.

import { useId, type JSX } from 'react'
import type { Settings } from '@shared/settings'
import { Button, Toggle } from '@renderer/components/primitives'
import PostureSetupCard from './PostureSetupCard'
import { GroupDivider, SettingRow, SettingsCard, SettingsGrid, useCommit } from './parts'

export default function GeneralPage({ settings }: { settings: Settings }): JSX.Element {
  const { commit } = useCommit()
  const ids = { launch: useId(), hidden: useId(), preview: useId() }
  const g = settings.general

  return (
    <SettingsGrid>
      <SettingsCard span={6} eyebrow="Startup">
        <div className="flex flex-col gap-3">
          <SettingRow
            label="Start with Windows"
            description="Opens SitSense in the tray when you sign in."
            descriptionId={ids.launch}
            savedKey="launch"
            control={
              <Toggle
                label="Start with Windows"
                describedBy={ids.launch}
                checked={g.launchOnStartup}
                onChange={(v) => commit('launch', { general: { launchOnStartup: v } })}
              />
            }
          />
          <GroupDivider />
          <SettingRow
            label="Start minimized to tray"
            description="The window stays hidden when SitSense starts — open it from the tray."
            descriptionId={ids.hidden}
            savedKey="hidden"
            control={
              <Toggle
                label="Start minimized to tray"
                describedBy={ids.hidden}
                checked={g.startHidden}
                onChange={(v) => commit('hidden', { general: { startHidden: v } })}
              />
            }
          />
        </div>
      </SettingsCard>

      <SettingsCard span={6} eyebrow="Window">
        <div className="flex flex-col gap-3">
          <SettingRow
            label="Camera preview on Live"
            description="Hiding it only hides the picture — monitoring continues."
            descriptionId={ids.preview}
            savedKey="preview"
            control={
              <Toggle
                label="Camera preview on Live"
                describedBy={ids.preview}
                checked={!g.hidePreview}
                onChange={(v) => commit('preview', { general: { hidePreview: !v } })}
              />
            }
          />
          <GroupDivider />
          <SettingRow
            label="Quit SitSense"
            description="Closing the window keeps SitSense running in the tray. Quitting stops monitoring until you start it again."
            control={
              <Button variant="secondary" size="sm" ringOn="card" onClick={() => void window.sitsense.quitApp()}>
                Quit
              </Button>
            }
          />
        </div>
      </SettingsCard>

      <PostureSetupCard />
    </SettingsGrid>
  )
}
