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

!macro _killRollfilmProcesses DIR
  Push $0 ; nsExec::Exec pushes its exit code; leave the caller's $0 untouched
  Push $1

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

  ; /T only reaches the exiftool workers while their backend is alive. After a
  ; backend crash they live on as orphans (exiftool.exe and its perl.exe, both
  ; under resources\exiftool) and keep the install dir locked. So end whatever
  ; still runs from DIR - matched by path, so an exiftool the user runs for
  ; other things is left alone - except this process itself, which is the old
  ; uninstaller when electron-builder falls back to running it in place.
  StrCpy $1 "${DIR}"
  ${If} $1 != ""
    System::Call 'kernel32::GetCurrentProcessId() i .r0'
    nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process | Where-Object { $$_.Id -ne $0 -and $$_.Path -and $$_.Path.StartsWith('$1\', [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force"`
    Pop $0
  ${EndIf}
  Sleep 500

  Pop $1
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
  ; initMultiUser has run by now, so SHELL_CONTEXT points at the hive of the
  ; installation electron-builder is about to replace. Read first, so the
  ; sweep knows which directory to clear.
  ClearErrors
  ReadRegStr $rfOldInstallDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} ${Errors}
    StrCpy $rfOldInstallDir ""
  ${EndIf}
  ClearErrors

  !insertmacro _killRollfilmProcesses "$rfOldInstallDir"
!macroend

!macro customUnInit
  !insertmacro _killRollfilmProcesses "$INSTDIR"
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
  !ifdef BUILD_UNINSTALLER
    !insertmacro _killRollfilmProcesses "$INSTDIR"
  !else
    !insertmacro _killRollfilmProcesses "$rfOldInstallDir"
  !endif
!macroend

; What electron-builder does next in the install section is run the previous
; version's uninstaller (silently, with --updated) - up to five times, then
; "Rollfilm cannot be closed ... Retry / Cancel". With --updated that
; uninstaller moves every file into %TEMP% one by one, and when a single one
; will not move (locked, a path too long for the temp folder, another drive)
; it moves them all back and fails. Five rounds of that over thousands of
; files is the long hang; Retry runs it a sixth time with the same result and
; the same dialog; only Cancel got through, into _rfRemoveOldFiles below.
; That uninstaller belongs to the old version, so nothing in this build can
; fix it - but it can be skipped: clear its UninstallString and
; electron-builder finds no previous version to uninstall. Registry entries
; and shortcuts are written afresh by the install section anyway, and the
; old files go in _rfRemoveOldFiles, where the progress list is showing.
;
; Where this happens matters. On a per-machine install the installer starts
; a second, elevated copy of itself that does the actual work, and in that
; copy electron-builder skips customCheckAppRunning - v0.2.0 cleared the
; value there and so never reached Program Files installs. A hidden page
; between the directory page and the install page runs in every instance
; that gets as far as installing, after the last click (Install) and before
; the install section: a per-user install, the elevated copy of a
; per-machine install, with or without --updated. The install mode is final
; by then, so SHELL_CONTEXT is the hive of the installation being replaced;
; the path is read again because customInit read it before the mode page.
!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Function rfSkipOldUninstaller
    ClearErrors
    ReadRegStr $rfOldInstallDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} ${Errors}
      StrCpy $rfOldInstallDir ""
    ${EndIf}
    ClearErrors
    ${If} $rfOldInstallDir != ""
    ${AndIf} ${FileExists} "$rfOldInstallDir\Rollfilm.exe"
      DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
      !ifdef UNINSTALL_REGISTRY_KEY_2
        DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      !endif
      ClearErrors
    ${EndIf}
    Abort ; nothing to show - on to the install page
  FunctionEnd
  PageEx custom
    PageCallbacks rfSkipOldUninstaller
  PageExEnd
!macroend
!endif

; The uninstaller this build ships: the same plain removal, never the
; move-to-temp-and-back of electron-builder's --updated path, so it cannot
; run into the loop above wherever a later installer still runs it. The
; processes were ended in customUnInit; a manual uninstall did RMDir /r
; before and still does.
!macro customRemoveFiles
  RMDir /r $INSTDIR
!macroend

; Reached right after electron-builder looked for the previous version's
; uninstaller - skipped above, so the old files are still in place - or ran
; it after all (a per-user copy beside a per-machine install), with $R0 its
; exit code (0 = fine; 2 is its Abort when a file could not be moved) and the
; error flag meaning it could not even be started. electron-builder's own
; reaction to a failure is a message box - "Failed to uninstall old
; application files. Please try running the installer again" - and Quit;
; running it again fails the same way, and the user ends up in Settings >
; Apps uninstalling by hand. Nothing in the old directory is worth that: the
; new version brings a complete copy of everything. So whatever happened
; before, a Rollfilm still in the old directory is removed here and the
; install carries on. A registry value pointing somewhere without a
; Rollfilm.exe is not a reason to delete that directory.
!macro _rfRemoveOldFiles
  !insertmacro _rfShowProgress
  ${If} ${Errors}
    ClearErrors
    StrCpy $R0 -1
  ${EndIf}
  ${If} $R0 != 0
    DetailPrint "The previous version's uninstaller failed ($R0) - removing its files directly."
  ${EndIf}
  ${If} $rfOldInstallDir != ""
  ${AndIf} ${FileExists} "$rfOldInstallDir\Rollfilm.exe"
    DetailPrint "Removing the previous version from $rfOldInstallDir (this can take a minute)..."
    RMDir /r "$rfOldInstallDir"
    ; Whatever is left (a locked file or two) gets overwritten by the
    ; install; a directory that survives only because it is our own working
    ; directory is fine too.
    DetailPrint "Previous version removed."
  ${EndIf}
  ClearErrors
  StrCpy $R0 0
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
  !insertmacro _rfRemoveOldFiles
  ${If} $installMode != "all"
    !insertmacro _rfAnnounceUnpack
  ${EndIf}
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro _rfRemoveOldFiles
  !insertmacro _rfAnnounceUnpack
!macroend

; Everything is in place (files, registry, shortcuts) when this runs.
!macro customInstall
  !insertmacro _rfShowProgress
  DetailPrint "Rollfilm ${VERSION} is installed."
!macroend
