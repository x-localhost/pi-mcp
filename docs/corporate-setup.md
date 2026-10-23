# pi-mcp 사내망(corporate) 설정 가이드

이 문서는 `src/config.mjs`가 읽는 `pi-mcp` 설정 파일(`PI_MCP_CONFIG`)을
사내 프록시/CA/내부 npm 레지스트리 환경에서 구성하는 방법을 설명합니다.
실제 회사 엔드포인트/자격증명으로의 연결은 아직 검증되지 않았으며, 이
문서는 연결이 실제로 동작함을 주장하지 않습니다.

## 설정 파일 구조

예시: `examples/config.example.json`. 주요 필드:

- `piPath` (절대경로, 필수): 실행할 Pi CLI 엔트리포인트. 공식
  `@earendil-works/pi-coding-agent`(1.4.0, Node ≥ 22.19 요구) npm 패키지를
  설치했다면 보통 해당 패키지의 `dist/bundle/cli.js`를 가리킵니다.
  `piArgs`는 `node <piPath> <piArgs...>` 형태로 실행할 때 추가 인자가
  필요한 경우에만 사용합니다.
- `stateDir`, `allowedRoots` (절대경로, 필수): 런타임(core)이 작업 상태와
  허용된 저장소 루트를 관리하는 경로입니다. 이 설정 유닛은 경로 유효성만
  검증하며, 실제 격리/락 처리는 core가 담당합니다.
- `provider`/`model`: Pi에게 사용할 공급자/모델을 지정합니다. `provider`를
  설정하면 `model`도 반드시 함께 설정해야 합니다.
- `agentDir`, `modelsFile`, `authFile`: 설정 파일 기준 상대경로 또는
  절대경로. `modelsFile`은 Pi 자체의 `models.json` 형식(예:
  `examples/models.example.json`)을 가리키며, 이 유닛은 그 내용을 해석하지
  않습니다.
- `allowedCommands`, `envAllowlist`: 런타임이 추가 허용할 셸 명령과, 자식
  프로세스로 전달할 환경변수 **이름**의 화이트리스트입니다. 값 자체는
  설정 파일에 넣지 않고, 실행 시점의 프로세스 환경에서만 읽습니다.
- `network`: 아래에서 설명합니다.

## 프록시(network.*ProxyEnv)

`HTTP_PROXY`/`http_proxy`, `HTTPS_PROXY`/`https_proxy`, `ALL_PROXY`/
`all_proxy`, `NO_PROXY`/`no_proxy`는 (대소문자 구분 없이) 설정 없이도
현재 프로세스 환경에 있으면 자동으로 자식 프로세스에 전달됩니다.

사내 프록시 값이 표준 이름이 아닌 별도 변수(예: `CORP_HTTP_PROXY`)에
있다면 `network.httpProxyEnv`처럼 **변수 이름**을 지정하세요. 이렇게
지정한 변수는 반드시 실행 시점 환경에 존재해야 하며(없으면 오류), 그
값이 표준 `HTTP_PROXY`/`http_proxy` 양쪽에 매핑되어 기존 표준값을
덮어씁니다.

이 HTTP 프록시 전송 경로는 LLM API의 `baseUrl`(예:
`models.json`의 `providers.<p>.models.<m>.baseUrl`)과는 별개입니다.
프록시는 네트워크 전송 계층을 바꾸고, `baseUrl`은 어떤 엔드포인트로
요청을 보낼지를 바꿉니다. 두 개념을 혼동하지 마세요.

## 사내 CA / 내부 npm 레지스트리

`network.caFile`을 설정하면 Git, npm, Node(Pi 포함)가 모두 같은 사내
루트 CA를 신뢰하도록 `GIT_SSL_CAINFO`, `npm_config_cafile`,
`NODE_EXTRA_CA_CERTS`에 동시에 전달됩니다. `network.npmRegistry`는
`npm_config_registry`로 전달되어 내부 레지스트리를 가리킵니다.

- `network.npmRegistry`에는 자격증명(userinfo, 예:
  `https://user:pass@registry...`)을 **넣을 수 없습니다**. npm 인증은
  기존에 사용 중인 사용자 `.npmrc`/자격증명 설정을 그대로 사용하도록
  문서화되어 있으며, 이 설정 파일은 레지스트리 URL만 지정합니다.
- 어떤 설정으로도 TLS 검증을 비활성화할 수 없습니다. `NODE_TLS_REJECT_UNAUTHORIZED`
  같은 값은 자식 프로세스 환경에 절대 전달되지 않습니다.

## envAllowlist로 전달하는 공급자/게이트웨이 자격증명

`envAllowlist`에 이름을 올린 환경변수만, 그리고 그 이름이 실행 시점
환경에 실제로 존재할 때만 자식 프로세스에 전달됩니다(예:
`CORP_LLM_API_KEY`). 다음과 같은 이름은 보안상 이유로 허용되지
않습니다(화이트리스트에 올려도 설정 검증에서 거부됨):

- `PATH`, `HOME`, `SSH_AUTH_SOCK`, `ENV`, `BASH_ENV`
- `NODE_*`, `LD_*`, `DYLD_*` (동적 로더/Node 런타임 주입 벡터)
- `PI_*` (Pi 내부 동작을 재정의할 수 있는 변수, 예: 에이전트 디렉터리)
- `GIT_CONFIG_*` (git config 주입 벡터)
- 표준 프록시/CA/npm 제어 변수(`HTTP_PROXY` 등, `GIT_SSL_CAINFO`,
  `npm_config_cafile`, `npm_config_registry`, `npm_config_strict_ssl`) —
  이 값들은 `network.*` 필드를 통해서만 제어합니다.

## Git 자격증명 / SSH

자식 프로세스 환경에는 일반적인 Git 자격증명 helper와 SSH agent가
동작하도록 `HOME`, `SSH_AUTH_SOCK`, `PATH`(없으면 보수적인 기본값
`/usr/bin:/bin`), `LANG`, `LC_ALL`이 항상 전달됩니다. 그 외의 호스트
환경변수는 명시적으로 선택(`envAllowlist`, `network.*`)하지 않는 한
전달되지 않습니다.

## OAuth 자격증명 가져오기에 대한 중요한 주의사항

Pi는 OAuth 로그인을 지원하지만, **기존에 로그인된 OAuth 토큰을 복사해서
pi-mcp 전용 상태 디렉터리에서 재사용하는 것은 위험합니다.** 같은 OAuth
세션(리프레시 토큰)을 pi-mcp와 일반 Pi CLI가 동시에 사용하면, 한쪽이
토큰을 갱신할 때 다른 쪽의 토큰을 원격으로 무효화시킬 수 있습니다. 즉,
평소 터미널에서 쓰던 Pi 로그인이 예고 없이 로그아웃될 수 있습니다.

따라서:

- pi-mcp가 OAuth 자격증명을 가져오려면, 그 자격증명을 **pi-mcp 전용으로
  독점 소유**하거나(다른 곳에서 동시에 쓰지 않음), **별도로 인증한
  pi-mcp 전용 세션**을 사용해야 합니다.
- 가능하다면 OAuth 가져오기보다 **회사 LLM 게이트웨이의 API 키를
  `envAllowlist`로 전달하는 방식**(이 문서의 "envAllowlist" 절)을
  권장합니다. API 키 방식은 토큰 갱신 경쟁 문제가 없습니다.

## 런타임이 보장하는 것 / 보장하지 않는 것

이 설정 유닛(`src/config.mjs`)은 설정 값의 검증, 자식 프로세스 환경
구성, 비밀값 마스킹, 진단(health) 정보 제공만 담당합니다. 실제 작업
디렉터리/에이전트 디렉터리 격리, 공유 상태 디렉터리 락, 1회 시딩되는
auth/models 파일 관리, 프로젝트 신뢰/확장(ambient extensions, MCP,
skills) 제외, 세션 재개 검증 등은 core(runtime) 레이어의 책임이며, 이
문서는 그 내부 동작을 보장하지 않습니다. 정확한 동작은 core의 문서를
참고하세요.

## 7개 MCP 도구와의 관계

`pi_health`는 이 유닛의 `healthConfig()` 결과(실행파일/설정/자격증명
"존재 여부"만, 값은 없음)를 사용할 수 있지만, 자격증명이 존재한다는
것이 실제 인증에 성공한다는 증거는 아닙니다. `pi_delegate`/`pi_followup`
등 나머지 도구는 `buildChildEnv()`가 구성한 환경으로 Pi 프로세스를
실행하는 core 레이어에서 소비합니다. 이 문서는 사내망 설정 측면만
다루며, 각 도구의 입력/출력 스키마는 core 문서를 참고하세요.
