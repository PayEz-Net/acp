; ACP installer customization — COL-6 M5.2 (installer-spec v2 §4/§5).
;
; electron-builder NSIS custom include, on top of the already-on
; directory chooser (build.nsis.allowToChangeInstallationDirectory):
;   1. customInit  — a HARD consent gate (blocking MessageBox). The user
;      MUST agree; declining QUITS the installer (consent-first, spec
;      §2.3 / §8 AC7 — never silent).
;   2. customInstall — writes the installer→app handoff JSON that
;      src/main/installerHandoff.ts reads on first authenticated launch:
;      { workspaceRoot, colonizationConsented, installerVersion }.
;      workspaceRoot uses forward slashes (Node fs accepts '/' on
;      Windows) so the JSON string needs no escaping.
;
; BUILD-DRIVEN FIX HISTORY (local `npm run dist:win` loop — the
; empirically-true path; QAPert closing-gate; BAPert msg 72/73):
;   - FIX-1 round A (a73871f): dropped MUI_HEADER_TEXT (needed MUI2).
;   - FIX-1 round B (msg 72): the original nsDialogs *custom page* was
;     wired via `!macro customPageAfterChangeDir` — but electron-builder
;     does NOT insert that hook, so the page's Functions were never
;     referenced → makensis `warning 6010` → fatal under -WX. The page
;     approach cannot compile here regardless of includes. Superseded:
;     the consent is now a blocking MessageBox in `customInit` (a hook
;     electron-builder DOES insert → referenced → compiles). Same HARD
;     gate (decline aborts, never silent); nsDialogs/LogicLib no longer
;     needed (no page); only WordFunc (for ${WordReplace}) remains.
;
; The handoff path MUST resolve to the same dir as Electron's
; app.getPath('userData') == %APPDATA%\${PRODUCT_NAME} (build.productName
; ACP; FIX-2 build.extraMetadata.name=ACP makes app.getName()=ACP) —
; validated by the QAPert clean-install E2E (BAPert task #9).
;
; COL-6 P1 (BAPert WO, offline): a self-heal preamble PREPENDED to
; customInit so the installer installs over ANY prior wrecked/partial/
; running state without making the user an archaeologist. Root: with
; zero build.nsis resilience config, electron-builder's DEFAULT install
; Section runs uninstallOldVersion, which ExecWaits the prior install's
; recorded "Uninstall ${PRODUCT_NAME}.exe"; a crashed/force-killed prior
; install left that file missing -> Win err 2 -> 5x retry -> a hard
; "cannot be closed" dead-end MessageBox (and CHECK_APP_RUNNING dead-ends
; the same way on a wedged process). Verified against app-builder-lib
; 24.13.3 templates: customInit is inserted in .onInit, which runs BEFORE
; that install Section; uninstallOldVersion clean-skips when it reads an
; empty UninstallString (installUtil.nsh: $uninstallString=="" ->
; ClearErrors/Return). So the preamble force-closes a wedged prior app
; and reverses ONLY the prior install's OWN recorded footprint + its
; stale Add/Remove keys -> uninstallOldVersion then sees "" and cleanly
; returns; the broken old uninstaller is never invoked. Idempotent,
; never aborts, no Uninstall*.exe dependency. This is install hygiene,
; NOT colonization — the AC7 consent gate + FIX-2 handoff are unchanged
; and still gate ALL colonization.

!include WordFunc.nsh

; User-DECLARED ACP working folder: set in customInit (prompted picker),
; written to the handoff in customInstall. Global so it persists across
; .onInit -> install Section. Guarded to the INSTALLER compile only:
; customInit/customInstall (its ONLY references) are not inserted in the
; BUILD_UNINSTALLER pass, so an unguarded Var there => NSIS warning 6001
; (unreferenced) => fatal under electron-builder's -WX.
!ifndef BUILD_UNINSTALLER
  Var ACP_WORKDIR
!endif

; === INSTALL/WORK FOLDER UX CLARITY v2 (BAPert WO) — directory-page note ===
; Verified vs app-builder-lib 24.13.3: electron-builder !include's this file
; in the PREPENDED header (NsisTarget.js scriptGenerator.include(customInclude)
; -> build() + installer.nsi), i.e. BEFORE installer.nsi:9 MUI2.nsh and BEFORE
; MUI_PAGE_DIRECTORY (assistedInstaller.nsh:26, via installer.nsi:33). So this
; top-level MUI define is in scope before the directory page and MUI2 renders
; it as the page's top text. The template does NOT define MUI_DIRECTORYPAGE_
; TEXT_TOP (no conflict). This is a standard MUI text define — NOT a page/
; function hook, so NOT the un-insertable customPageAfterChangeDir class that
; bit this saga. HONEST: after consent the user CHOOSES the working folder
; via a modal folder dialog (shown default, changeable) — a real choice.
!define MUI_DIRECTORYPAGE_TEXT_TOP "This is only where the ACP program is installed. Next you'll CHOOSE your separate working folder — where your repos and the .kimi / .claude agent files are created."

!macro customInit
  ; === AC7 CONSENT GATE — FIRST, before anything destructive ============
  ; Moved ABOVE the COL-6 self-heal: the self-heal RMDir's the prior
  ; install, so if it ran before consent a declined/cancelled wizard left
  ; the user with an EMPTY install dir (bad-feeling dead-end for a fresh
  ; dev). Now: decline/cancel → Quit with the prior install fully intact,
  ; nothing touched. Self-heal runs ONLY after the user agrees.
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "ACP needs your consent to set up a WORKING folder — where your \
repos and the .kimi / .claude agent files are created and updated \
(atomic and idempotent). This is SEPARATE from the program install \
location you chose on the previous screen.$\r$\n$\r$\n\
After you agree, you'll CHOOSE that working folder (a default is \
shown: $PROFILE\ACP-Workspace; changeable in-app later). Nothing \
happens without your explicit agreement.$\r$\n$\r$\n\
Agree and choose your working folder?" \
    /SD IDNO IDYES acpConsentGranted
  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "Colonization consent is required. Installation cancelled." /SD IDOK
  Quit
  acpConsentGranted:

  ; === COL-6 P1 self-heal — runs in .onInit (before the install Section's
  ; CHECK_APP_RUNNING + uninstallOldVersion) but ONLY after consent above.
  ; Reverses ONLY the prior install's OWN recorded footprint; never
  ; touches user appData/handoff. Idempotent; never aborts.
  ClearErrors
  ; force-terminate a wedged prior app for THIS user (electron-builder's own
  ; per-user taskkill construct; no "close manually" dead-end)
  nsExec::Exec '%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"'
  Pop $0
  ; read the prior install's OWN recorded InstallLocation (HKCU, then HKLM)
  StrCpy $1 ""
  ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCmp $1 "" 0 acpHaveLoc
  ReadRegStr $1 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  acpHaveLoc:
  StrCmp $1 "" acpRegOnly
  IfFileExists "$1\*.*" 0 acpRegOnly
  RMDir /r "$1"
  acpRegOnly:
  ; delete stale keys -> Section uninstallOldVersion reads "" -> clean Return
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${INSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  ClearErrors
  ; === end self-heal ====================================================

  ; --- INSTALLER WORK-FOLDER DECLARATION (BAPert WO, ship-today) ---
  ; Modal native folder picker — same modal class as the consent MessageBox
  ; above (proven-insertable), NOT the un-insertable custom-MUI-page class.
  ; Shown default the user can change = explicit PROMPT, not a fallback.
  ; Only reached after consent (silent /S declined + Quit above, so this
  ; never runs unprompted).
  StrCpy $ACP_WORKDIR "$PROFILE\ACP-Workspace"
  nsDialogs::SelectFolderDialog "Choose your ACP WORKING folder — where your repos and the .kimi/.claude agent files are created. This is NOT the program install folder." "$ACP_WORKDIR"
  Pop $0
  ; cancel/close => nsDialogs pushes "error" => keep the shown default
  ; (accepted-by-not-changing prompted default; explicit if/else, no ||).
  StrCmp $0 "error" acpWorkdirDone 0
  StrCpy $ACP_WORKDIR $0
  acpWorkdirDone:
!macroend

!macro customInstall
  ; install != workspace (Jon's catch): the handoff records the WORKSPACE
  ; root, NOT $INSTDIR. App binaries still install to $INSTDIR normally; we
  ; do NOT colonize Program Files / the install dir. $ACP_WORKDIR is the
  ; user-DECLARED working folder from the customInit picker (shown default
  ; %USERPROFILE%\ACP-Workspace; changeable in-app later); forward-slashed
  ; so the JSON needs no escaping and Node fs accepts it.
  ${WordReplace} "$ACP_WORKDIR" "\" "/" "+" $R0
  ; Electron userData == %APPDATA%\<productName> (== %APPDATA%\ACP).
  CreateDirectory "$APPDATA\${PRODUCT_NAME}"
  FileOpen $R1 "$APPDATA\${PRODUCT_NAME}\installer-handoff.json" w
  FileWrite $R1 '{"workspaceRoot":"$R0","colonizationConsented":true,"installerVersion":"${VERSION}"}'
  FileClose $R1

  ; NO install-time colonize exec / readout here. It was cosmetic and
  ; bricked the installer (GUI-exe-headless ExecToLog + a fragile
  ; FileRead/${WordReplace} replay loop inside an elevated NSIS install).
  ; Colonize was never the auto-start blocker (that was the lifecycle-hub
  ; dev-93 default — fixed in cloud-endpoints.ts). The handoff JSON above
  ; is the real, proven mechanism: src/main/installerHandoff.ts reads it
  ; on first launch and the runtime spawn-orchestrator self-heals the
  ; workspace idempotently. Keep customInstall rock-solid handoff-only.
!macroend
