; MidLauncher - NSIS customization
; Minimal version to avoid build errors

!macro preInit
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\MidLauncher"
!macroend

!macro customInstall
  ; Associate .mrpack files with MidLauncher
  WriteRegStr HKCU "Software\Classes\.mrpack" "" "MidLauncher.mrpack"
  WriteRegStr HKCU "Software\Classes\MidLauncher.mrpack" "" "MidLauncher Modpack"
  WriteRegStr HKCU "Software\Classes\MidLauncher.mrpack\DefaultIcon" "" "$INSTDIR\MidLauncher.exe,0"
  WriteRegStr HKCU "Software\Classes\MidLauncher.mrpack\shell\open\command" "" '"$INSTDIR\MidLauncher.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\.mrpack"
  DeleteRegKey HKCU "Software\Classes\MidLauncher.mrpack"
!macroend
