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

; electron-builder builds the setup with "ShowInstDetails nevershow" and
; switches DetailPrint off at the top of the install section, so the page
; shows a bar and "Installing, please wait..." for minutes - most of that
; time in a silent CopyFiles of the unpacked gigabyte - and nothing else. The
; list control and the status line still exist on the page, so turn them
; back on at run time: show the list (dialog item 1016 of the inner page)
; and route DetailPrint to both it and the status line. Idempotent - it runs
; from every hook, because on a per-machine install the first hook is skipped
; in the elevated instance that actually does the work. Outside the install
; page (silent runs, .onInit) FindWindow yields 0 and nothing happens.
!macro _rfShowProgress
  Push $0
  Push $1
  FindWindow $0 "#32770" "" $HWNDPARENT
  ${If} $0 != 0
    GetDlgItem $1 $0 1016
    ShowWindow $1 ${SW_SHOW}
    SetDetailsPrint both
  ${EndIf}
  Pop $1
  Pop $0
!macroend

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
  !insertmacro _rfShowProgress
  DetailPrint "Closing Rollfilm if it is still running..."
  !insertmacro _killRollfilmProcesses
  !ifndef BUILD_UNINSTALLER
    ; What electron-builder does next, and says nothing about: run the
    ; previous version's uninstaller and wait for it.
    ${If} $rfOldInstallDir != ""
      DetailPrint "Removing the previous version from $rfOldInstallDir (this can take a minute)..."
    ${EndIf}
  !endif
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
  !insertmacro _rfShowProgress
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
  ${ElseIf} $rfOldInstallDir != ""
    DetailPrint "Previous version removed."
  ${EndIf}
!macroend

; Next comes the part that takes longest and used to look like a hang: the
; 7z package is unpacked to a temporary folder and then copied into place, a
; gigabyte or so, with no progress of its own. Said once, after the last
; uninstall pass - electron-builder makes a second one on a per-machine
; install, looking for a per-user copy as well.
!macro _rfAnnounceUnpack
  DetailPrint "Unpacking Rollfilm ${VERSION} - a few hundred megabytes, this takes a while..."
!macroend

!macro customUnInstallCheck
  !insertmacro _rfRecoverFailedUninstall
  ${If} $installMode != "all"
    !insertmacro _rfAnnounceUnpack
  ${EndIf}
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro _rfRecoverFailedUninstall
  !insertmacro _rfAnnounceUnpack
!macroend

; Everything is in place (files, registry, shortcuts) when this runs.
!macro customInstall
  !insertmacro _rfShowProgress
  DetailPrint "Rollfilm ${VERSION} is installed."
!macroend
