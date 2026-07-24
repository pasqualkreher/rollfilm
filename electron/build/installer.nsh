; electron-builder NSIS hooks (wired up via build.nsis.include in package.json).
;
; The updater first runs the previous version's uninstaller. If anything from
; the app is still alive - most likely an orphaned photo-manager-backend.exe
; (the PyInstaller backend), which the built-in "app is running" check does NOT
; know about - files in the install dir stay locked and the user gets the
; unfriendly "error uninstalling old version / Retry" loop. Kill our processes
; up front, before install and before uninstall.
;
; taskkill /T also takes down their children (exiftool -stay_open workers), so
; only our own uniquely-named executables need to be listed here.

!macro _killRollfilmProcesses
  nsExec::Exec 'taskkill /F /T /IM "Rollfilm.exe"'
  nsExec::Exec 'taskkill /F /T /IM "photo-manager-backend.exe"'
  ; Give Windows a moment to release the file locks before NSIS starts deleting.
  Sleep 500
!macroend

!macro customInit
  !insertmacro _killRollfilmProcesses
!macroend

!macro customUnInit
  !insertmacro _killRollfilmProcesses
!macroend
