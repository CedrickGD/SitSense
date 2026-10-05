; Included by electron-builder (electron-builder.yml -> nsis.include).
; Launch-at-login is written by Electron's app.setLoginItemSettings under the
; value name below (AUTOSTART_NAME in src/main/autostart.ts). A real uninstall
; must remove it, or Windows keeps trying to start a deleted exe at every login.
; Skipped during an update (the old version is uninstalled silently first),
; so autostart survives upgrades.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.cedrickgd.sitsense"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.cedrickgd.sitsense"
  ${endIf}
!macroend
