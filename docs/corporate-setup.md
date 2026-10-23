# pi-mcp 사내 환경 설치 가이드

이 안내는 사내 프록시, 인증서, npm 레지스트리를 사용하는 환경에서
pi-mcp를 설치하고 MCP 호스트에 등록하는 기본 절차입니다. 회사의 실제
주소와 인증 정보는 관리자에게 확인하고 승인된 값을 사용하세요. 이
예시는 회사 네트워크 연결을 검증한 결과가 아닙니다.

## 1. 사전 준비

- Node.js **22.19 이상**을 준비합니다.
- 현재 런타임은 Linux/macOS의 프로세스 그룹을 사용합니다. 실행 검증은
  Linux의 Node 24에서 수행했습니다.
- 오프라인 `grep`/`find` 도구에 필요한 `rg`와 `fd` 실행 파일을 준비합니다.
  배포판 패키지가 `fd-find`인 경우에도 자식 PATH에서 `fd` 명령이 보여야 합니다.
- 승인된 경로에 이 `pi-mcp` 프로젝트를 clone하거나 배포본을 복사합니다.
- Git 저장소 인증은 회사에서 승인한 Git helper 또는 SSH agent로
  준비합니다. pi-mcp는 저장소를 자동으로 clone하거나 원격에 push하지
  않습니다.
- 내부 npm 레지스트리, 프록시 주소, 회사 CA 인증서 경로와 LLM 게이트웨이
  주소/API 키 전달 방법을 관리자에게 확인합니다.

## 2. 의존성 설치

`PI_MCP_CONFIG`는 서버 실행 시 읽히므로 초기 `npm ci` 설정에 영향을 주지
않습니다. 설치 전에 현재 셸에 회사에서 안내한 네트워크 값을 설정합니다.
아래 값은 형식 예시이며 실제 값을 넣어야 합니다.

```sh
export HTTPS_PROXY='http://proxy.example.invalid:8080'
export HTTP_PROXY='http://proxy.example.invalid:8080'
export NO_PROXY='localhost,127.0.0.1'
export NODE_EXTRA_CA_CERTS='/path/to/company-root-ca.pem'
export GIT_SSL_CAINFO='/path/to/company-root-ca.pem'
export npm_config_cafile='/path/to/company-root-ca.pem'
export npm_config_registry='https://npm.example.invalid/'
git clone 'https://git.example.invalid/approved/pi-mcp.git' /opt/pi-mcp
cd /opt/pi-mcp
npm ci --ignore-scripts
```

프록시와 게이트웨이 `baseUrl`은 서로 다른 설정입니다. `HTTP_PROXY`와
`HTTPS_PROXY`는 Pi의 HTTP 전송 경로에 사용됩니다. `ALL_PROXY`는 환경을
통해 Git 및 도구에 전달될 수 있지만, 이것만으로 Pi 요청이 프록시를
통한다고 가정하지 마세요. `NO_PROXY`의 문법과 적용 방식은 도구마다
다를 수 있으므로 회사에서 안내한 값을 사용하세요.

## 3. 설정 파일 준비

`examples/config.example.json`을 복사해 승인된 위치에 두고 경로와 값을
수정합니다. `examples/models.example.json`은 Pi 1.4.0의 `models.json`
형식 예시입니다. `provider`, `model`, 게이트웨이 `baseUrl` 및 모델 ID를
실제 환경에 맞춥니다.

`piPath`는 Pi 프로세스를 시작할 실행 파일이고, `piArgs`는 그 실행 파일에
전달할 인자입니다. 예시처럼 `piPath`를 `/usr/local/bin/node`로
두고 `piArgs`에 설치된 Pi CLI 번들 경로를 지정할 수 있습니다. 또는
`piPath`를 Pi CLI의 실행 가능한 경로로 직접 지정하고 `piArgs`를 비워둘
수 있습니다. 설치 위치에 맞게 경로를 바꾸세요.

`allowedCommands`에는 `npm test`, `git status --short`처럼 허용할 명령의
정확한 문자열을 적습니다. `git`이나 `npm`만 적으면 그 문자열만 허용되며,
인자가 붙은 명령은 허용되지 않습니다. `envAllowlist`에는 전달할 비밀
변수의 이름만 적습니다. 예시의 `CORP_LLM_API_KEY` 값은 설정 파일이나
MCP 등록 파일에 쓰지 말고, MCP 호스트가 상속하는 보안 환경 또는 회사의
비밀 주입 기능으로 공급하세요. 변수의 존재 여부는 인증 성공을 보장하지
않습니다.

`network.*ProxyEnv`에는 실제 프록시 값이 아니라 환경변수 이름을
지정합니다. MCP 호스트 실행 환경에 해당 변수를 제공해야 합니다.
`network.caFile`과 `network.npmRegistry`는 각 회사가 승인한 CA 파일
경로와 레지스트리 주소로 바꿉니다. 레지스트리 URL에 사용자명이나
비밀번호를 포함하지 마세요.

## 4. MCP 호스트에 등록하고 실행

`examples/mcp.example.json`의 서버 항목을 MCP 호스트 설정에 복사하고,
`PI_MCP_CONFIG`를 실제 설정 파일의 절대경로로 바꿉니다. `command`는
`node`, `args`는 설치 경로의 `/opt/pi-mcp/src/server.mjs`를 가리키는
예시입니다. 호스트가 `CORP_LLM_API_KEY`와 프록시 변수를 보안 방식으로
상속하도록 설정하세요. 프록시가 필요 없다면 프록시 변수와 설정 항목을
제거할 수 있습니다.

MCP 호스트가 서버를 stdio 방식으로 시작하도록 설정한 뒤 연결 상태를
확인하세요. 프로젝트의 7개 MCP 도구와 각 도구의 동작은 README를
참고하세요.

회사 저장소의 실제 작업은 승인된 경로와 Git 인증 방식으로 수행하세요.
설정의 `allowedRoots`는 작업을 허용할 경로를 지정합니다. 이 설정이나
pi-mcp가 운영체제 수준의 샌드박스를 제공한다고 간주하지 마세요. 승인된
스크립트는 파일 정책이 제한하는 범위보다 더 많은 작업을 수행할 수
있으므로 신뢰하는 저장소와 명령만 허용하세요. 상태, 작업 공간,
세션 파일은 비공개로 유지하고 다른 사용자와 공유하지 마세요.

## OAuth 자격증명 주의

일반 Pi와 pi-mcp가 같은 OAuth 세션의 refresh token을 동시에 사용하면,
한쪽의 갱신이 다른 쪽 세션을 원격에서 무효화할 수 있습니다. OAuth를
사용할 때는 pi-mcp 전용으로 독점 소유하는 자격증명이나 별도 로그인
세션을 사용하세요. 가능한 경우 게이트웨이 API 키를 보안 환경으로
전달하는 방법을 사용하면 이 토큰 경쟁을 피할 수 있습니다.

작업 실행, 재시도, 결과 검토 및 운영상 주의사항은 [운영 안내](operations.md)를
참고하세요.
