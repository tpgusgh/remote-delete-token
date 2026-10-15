# Token Relay

여러 Claude 계정을 등록해두고, 사용량이 95% 가 되면 다음 계정으로 자동 전환하며 Claude Code 작업을 질문 없이 계속 실행하는 Mac 앱 + Android 앱.

- **Mac 앱**: 켜져 있는 동안 서버를 돌리고 잠자기를 막음. 종료하면 서버도 종료.
- **Android 앱**: Tailscale 로 Mac 에 바로 접속해 작업 추가, 진행 상황, 결과 확인.

## 기능

- 계정 여러 개 등록 (앱에서 로그인 → 코드 붙여넣기), 5시간/7일 사용량 표시
- 95% 도달 시 다음 계정으로 같은 세션 이어서 실행, 모두 한도면 리셋 시각에 자동 재개
- 자율 모드 (질문 금지), 중지할 때까지 반복, 주간 사용량 초기화 시 자동 중지
- 작업 폴더 탐색/생성, 모델·effort 선택, MCP 연결 상태 표시

## 빌드

필요: macOS, Xcode Command Line Tools, Android SDK (`~/Library/Android/sdk`), JDK, Node 18+, `claude` CLI, python3, Tailscale

```sh
./build.sh   # dist/TokenRelay.dmg, dist/TokenRelay.apk
```

APK 에는 빌드한 Mac 의 Tailscale 주소가 들어가므로 직접 빌드해서 쓰세요. 처음 빌드하면 서명 키(`android/relay.keystore`)가 생성됩니다 — 업데이트 설치에 필요하니 보관하고, 저장소에 올리지 마세요.

## 사용

1. `TokenRelay.dmg` 의 앱을 실행
2. 앱 메뉴 "Android 앱 설치…" QR 을 폰 카메라로 찍어 APK 설치 (폰 Tailscale 켜기)
3. 앱에서 Claude 계정 연결 → 작업 추가

## 보안

- 서버는 `localhost` 와 Mac 의 Tailscale IP 에만 열립니다. tailnet 에 연결된 기기는 이 Mac 에서 작업(=명령)을 실행할 수 있으니 tailnet 을 남과 공유하지 마세요.
- 작업은 `--dangerously-skip-permissions` 로 실행되어 확인 없이 파일 수정·명령 실행을 합니다. 작업 폴더를 정확히 지정하세요.
- 계정 토큰은 `~/Library/Application Support/TokenRelay/data.json` (권한 600) 에 저장됩니다.
- 여러 계정을 돌려 사용량 한도를 우회하는 것은 Anthropic 약관에 어긋날 수 있습니다. 본인 책임 하에 사용하세요.
