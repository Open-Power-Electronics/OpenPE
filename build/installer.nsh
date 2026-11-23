!ifndef BUILD_UNINSTALLER
  ManifestDPIAware true
  SetFont "Segoe UI" 9
  !define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight
  !define MUI_TEXTCOLOR "202020"
  !define MUI_CUSTOMFUNCTION_GUIINIT OpenPELoadIcons
  !define MUI_FINISHPAGE_TITLE "OpenPE is installed"
  !define MUI_FINISHPAGE_TEXT "Select Launch OpenPE to open it now,$\r$\nor find OpenPE in the Start menu."
  !define MUI_FINISHPAGE_RUN_TEXT "Launch OpenPE"
  !define MUI_FINISHPAGE_RUN_NOTCHECKED
  !define MUI_DIRECTORYPAGE_TEXT_TOP "Use the default folder or select Browse."
  !define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Installation folder"
  !define OPENPE_INSTALLER_UI "${__FILEDIR__}\installer-ui.dll"
  !define OPENPE_INSTALLER_MARK "${__FILEDIR__}\installer-mark.ico"
  SpaceTexts none
  Var OpenPEHeaderIcon
  Var OpenPESidebarIcon

  !macro customInstallMode
    ${If} $hasPerMachineInstallation == "0"
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  !macroend
!endif

!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW OpenPEWelcomeLayout
  !define MUI_WELCOMEPAGE_TITLE "Install OpenPE"
  !define MUI_WELCOMEPAGE_TEXT "Choose where to install OpenPE.$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
  !define MUI_PAGE_HEADER_SUBTEXT " "
  !ifndef INSTALL_MODE_PER_ALL_USERS
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW OpenPEScopeLayout
  !endif
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_HEADER_SUBTEXT "Setup is copying files. Keep this window open."
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function OpenPEStartApp
      StrCpy $1 ""
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION OpenPEStartApp
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW OpenPEFinishLayout
  !insertmacro MUI_PAGE_FINISH
!macroend

; MUI creates these controls in its original tall page. Move them in dialog
; units so the compact frame preserves the native font and DPI scaling.
!macro moveSetupControl CONTROL X Y WIDTH HEIGHT
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  System::Call '*(i ${X}, i ${Y}, i ${WIDTH}, i ${HEIGHT}) p.r0'
  System::Call 'user32::MapDialogRect(p $HWNDPARENT, p r0)'
  System::Call '*$0(i.r1, i.r2, i.r3, i.r4)'
  System::Free $0
  System::Call 'user32::MoveWindow(p ${CONTROL}, i r1, i r2, i r3, i r4, i 1)'
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro addSetupSidebarIcon
  Push $0
  ; Match the clear area in the circuit texture around the native icon.
  nsDialogs::CreateControl "Static" 0x50000203 0 35u 26u 41u 33u ""
  Pop $0
  SetCtlColors $0 "" "FAFAFA"
  SendMessage $0 ${STM_SETIMAGE} ${IMAGE_ICON} $OpenPESidebarIcon
  Pop $0
!macroend

!macro customHeader
  BrandingText " "
  !ifndef BUILD_UNINSTALLER
    ChangeUI IDD_INST "${OPENPE_INSTALLER_UI}"
    ChangeUI IDD_DIR "${OPENPE_INSTALLER_UI}"
    ChangeUI IDD_INSTFILES "${OPENPE_INSTALLER_UI}"

    Function OpenPELoadIcons
      InitPluginsDir
      File "/oname=$PLUGINSDIR\openpe-setup.ico" "${OPENPE_INSTALLER_MARK}"
      System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i.r0'
      System::Call 'kernel32::MulDiv(i r0, i 32, i 96) i.r1'
      System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\openpe-setup.ico", i ${IMAGE_ICON}, i r1, i r1, i ${LR_LOADFROMFILE}) p.s'
      Pop $OpenPEHeaderIcon
      System::Call 'kernel32::MulDiv(i r0, i 64, i 96) i.r1'
      System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\openpe-setup.ico", i ${IMAGE_ICON}, i r1, i r1, i ${LR_LOADFROMFILE}) p.s'
      Pop $OpenPESidebarIcon
      SendMessage $mui.Header.Image ${STM_SETIMAGE} ${IMAGE_ICON} $OpenPEHeaderIcon
    FunctionEnd

    Function .onGUIEnd
      ${NSD_FreeIcon} $OpenPEHeaderIcon
      ${NSD_FreeIcon} $OpenPESidebarIcon
    FunctionEnd

    Function OpenPEWelcomeLayout
      !insertmacro moveSetupControl $mui.WelcomePage.Text 120 32 120 22
      !insertmacro addSetupSidebarIcon
    FunctionEnd

    !ifndef INSTALL_MODE_PER_ALL_USERS
      Function OpenPEScopeLayout
        !insertmacro moveSetupControl $MultiUser.InstallModePage.Text 0 0 228 12
        !insertmacro moveSetupControl $MultiUser.InstallModePage.AllUsers 8 12 214 11
        !insertmacro moveSetupControl $MultiUser.InstallModePage.CurrentUser 8 24 214 11
        !insertmacro moveSetupControl $RadioButtonLabel1 0 36 228 14
      FunctionEnd
    !endif

    Function OpenPEFinishLayout
      !insertmacro moveSetupControl $mui.FinishPage.Text 120 31 120 24
      !insertmacro addSetupSidebarIcon
      ${If} ${RebootFlag}
        !insertmacro moveSetupControl $mui.FinishPage.RebootNow 120 55 120 11
        !insertmacro moveSetupControl $mui.FinishPage.RebootLater 120 67 120 11
      ${Else}
        !ifndef HIDE_RUN_AFTER_FINISH
          !insertmacro moveSetupControl $mui.FinishPage.Run 120 59 120 11
        !endif
      ${EndIf}
    FunctionEnd
  !endif
!macroend
