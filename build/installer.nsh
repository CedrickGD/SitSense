; Included by electron-builder (electron-builder.yml -> nsis.include).
; A real uninstall removes what SitSense leaves outside its install folder:
; - launch-at-login, written by Electron's app.setLoginItemSettings under the
;   value name below (AUTOSTART_NAME in src/main/autostart.ts), or Windows keeps
;   trying to start a deleted exe at every login;
; - the updater cache %LOCALAPPDATA%\sitsense-updater: electron-builder copies the
;   installer there (installer.exe, ~110 MB) on every install for differential
;   updates, and electron-updater downloads into ...\pending. Nothing else removes it.
; Skipped during an update (the old version is uninstalled silently first), so
; autostart survives upgrades and the running installer (possibly
; pending\SitSense-Setup-*.exe) is not deleted under itself.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.cedrickgd.sitsense"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.cedrickgd.sitsense"
    ; electron always uses per-user app data (same guard as electron-builder's own
    ; template; a no-op while perMachine is false)
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endIf}
    RMDir /r "$LOCALAPPDATA\sitsense-updater"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endIf}
  ${endIf}
!macroend
