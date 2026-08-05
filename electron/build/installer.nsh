; electron-builder NSIS hooks (wired up via build.nsis.include in package.json).
;
; CRITICAL: never pass taskkill's /T (kill process tree) for Rollfilm.exe here.
;
; electron-updater starts the downloaded installer with spawn() from inside the
; running app and only *then* calls app.quit() - so while these macros run, this
; installer process is a child of the still-alive Rollfilm.exe. (customInit runs
; from .onInit, and electron-builder's own "app is running" check only happens
; later, in the install section - it can't have cleared the app for us yet.)
; "/T /IM Rollfilm.exe" therefore took down the installer along with the app:
; the update looked like a crash, left a half-replaced install dir behind, and
; the only way out was uninstalling by hand and downloading the setup again.
; Matching by image name alone is enough anyway - every Electron process (main,
; renderer, GPU, utility) is called Rollfilm.exe.
;
; The backend is the opposite case. photo-manager-backend.exe (the PyInstaller
; bundle) spawns exiftool -stay_open workers that survive a plain kill, keep
; files in the install dir locked and produce the "error uninstalling old
; version / Retry" loop. The installer is never a descendant of the backend, so
; /T is safe there and takes the exiftool workers down with it.

!macro _killRollfilmProcesses
  Push $0 ; nsExec::Exec pushes its exit code; leave the caller's $0 untouched

  ; No /T - see above.
  nsExec::Exec 'taskkill /F /IM "Rollfilm.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "photo-manager-backend.exe"'
  Pop $0

  ; Windows releases the file handles a moment after the processes die, and the
  ; app may still have been mid-quit (spawning its own backend teardown) when
  ; the first pass ran. Wait, then sweep again before NSIS starts deleting.
  Sleep 1500
  nsExec::Exec 'taskkill /F /IM "Rollfilm.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "photo-manager-backend.exe"'
  Pop $0
  Sleep 500

  Pop $0
!macroend

!macro customInit
  !insertmacro _killRollfilmProcesses
!macroend

!macro customUnInit
  !insertmacro _killRollfilmProcesses
!macroend
