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

; Where the previous version lives, read before anything touches the
; registry. The old uninstaller deletes its keys when it succeeds, and when
; it fails halfway the keys may or may not still be there - so remember the
; path up front, for the fallback below. Installer build only: the uninstaller
; has no previous version to look after.
!ifndef BUILD_UNINSTALLER
  Var rfOldInstallDir
!endif

!macro customInit
  !insertmacro _killRollfilmProcesses

  ; initMultiUser has run by now, so SHELL_CONTEXT points at the hive of the
  ; installation electron-builder is about to replace.
  ClearErrors
  ReadRegStr $rfOldInstallDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} ${Errors}
    StrCpy $rfOldInstallDir ""
  ${EndIf}
  ClearErrors
!macroend

!macro customUnInit
  !insertmacro _killRollfilmProcesses
!macroend

; electron-builder's own "is the app running?" check, in the installer and
; the uninstaller alike, looks for Rollfilm.exe with `tasklist | find`, asks,
; sends a close request, polls twice and then puts up "Rollfilm cannot be
; closed. Please close it manually and click Retry". Since electron-builder
; 24.13.2 that dialog comes back on every Retry for some users even with
; nothing left running (electron-builder #8131, #9593); Cancel ends in "Failed
; to uninstall old application files", and the only way forward was
; uninstalling by hand. We already know how to close Rollfilm for certain -
; the sweep above - so the check *is* the sweep: no question, no loop.
; Defining this macro makes electron-builder leave its own version out of
; both the installer and the uninstaller this build produces.
!macro customCheckAppRunning
  !insertmacro _killRollfilmProcesses
!macroend

; Reached right after electron-builder ran the previous version's uninstaller
; (silently, with --updated). Its default reaction to a failure is a message
; box - "Failed to uninstall old application files. Please try running the
; installer again" - and Quit; running it again fails the same way, and the
; user ends up in Settings > Apps uninstalling by hand before the setup gets
; anywhere. Nothing in the old directory is worth that: the new version
; brings a complete copy of everything. So on an error we remove the old
; files ourselves and carry on installing.
;
; $R0 is the old uninstaller's exit code (0 = fine; 2 is its Abort when a
; file could not be moved), the error flag means it could not even be
; started. The directory is only wiped when it actually holds a Rollfilm -
; a registry value pointing somewhere else is not a reason to delete that.
!macro _rfRecoverFailedUninstall
  ${If} ${Errors}
    ClearErrors
    StrCpy $R0 -1
  ${EndIf}
  ${If} $R0 != 0
    DetailPrint "The previous version's uninstaller failed ($R0) - removing its files directly."
    !insertmacro _killRollfilmProcesses
    ${If} $rfOldInstallDir != ""
    ${AndIf} ${FileExists} "$rfOldInstallDir\Rollfilm.exe"
      RMDir /r "$rfOldInstallDir"
    ${EndIf}
    ; Whatever is left (a locked file or two) gets overwritten by the
    ; install; a directory that survives only because it is our own working
    ; directory is fine too.
    ClearErrors
    StrCpy $R0 0
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro _rfRecoverFailedUninstall
!macroend

; Same again for the second pass electron-builder makes on a per-machine
; install (it also looks for a per-user copy to remove).
!macro customUnInstallCheckCurrentUser
  !insertmacro _rfRecoverFailedUninstall
!macroend
