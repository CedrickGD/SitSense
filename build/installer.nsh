; Included by electron-builder (nsis.include in electron-builder.yml).

!macro customUnInstall
  ; app.setLoginItemSettings names its Run value after the AppUserModelId.
  ; An uninstalled app must not leave a dead autostart entry behind; an update
  ; runs this uninstaller too, and must keep the user's choice.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.cedrickgd.sitsense"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.cedrickgd.sitsense"
  ${endIf}
!macroend
