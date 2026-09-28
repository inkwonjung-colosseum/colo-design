; Nova Design 설치의 include(RENAME-NOVA-PLAN §4.2 · D-4).
;
; appId 가 org.colo-design.desktop → org.nova-design.desktop 로 바뀌므로 NSIS 가
; 설치를 찾는 레지스트리 키(HKCU\Software\<UUIDv5(appId)>)도 달라진다 — 옛 설치를
; 지우지 않으면 새 설치 옆에 남아 병설이 된다. 설치 맨 앞(customInit — 파일이
; 놓이기 전)에서 옛 GUID 설치를 조용히 지운다.
;
; 옛 GUID 는 electron-builder(app-builder-lib NsisTarget)의 규칙
; UUIDv5(org.colo-design.desktop, 50e065bc-3134-11e6-9bab-38c9862bdaf3) 으로
; 미리 계산한 값이다 — desktop/src/identity.ts 의 LEGACY_NSIS_GUID 와 같은 값.
;
; 사용자별 설치이므로 SHCTX 는 HKCU 를 가리킨다. 옛 제거 프로그램을 _?= 와 함께
; 돌려 자기 삭제 대신 제자리에서 끝나게 한다(동기 ExecWait) — 레지스트리 정리는
; 옛 제거 프로그램이 스스로 하고, 남은 uninstall.exe 와 빈 폴더만 여기서 지운다.
; 지울 것이 없으면 아무 일도 하지 않는다(첫 설치 기계).

!macro removeLegacyInstall
  ; read-legacy — 옛 appId(org.colo-design.desktop)의 설치 표식
  ReadRegStr $R0 SHCTX "Software\8e8a724d-d884-5802-b7a6-73f52ed44cb4" "QuietUninstallString"
  StrCmp $R0 "" legacy_done
    ReadRegStr $R1 SHCTX "Software\8e8a724d-d884-5802-b7a6-73f52ed44cb4" "InstallLocation"
    ExecWait '$R0 _?=$R1'
    DeleteRegKey SHCTX "Software\8e8a724d-d884-5802-b7a6-73f52ed44cb4"
    StrCmp $R1 "" legacy_done
      ; read-legacy — 옛 제거 프로그램의 이름(Uninstall "Colo Design".exe)
      Delete "$R1\Uninstall Colo Design.exe" ; read-legacy
      RMDir "$R1"
  legacy_done:
!macroend

!macro customInit
  !insertmacro removeLegacyInstall
!macroend
