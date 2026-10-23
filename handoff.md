## 현재 상태

- 날짜: 2026-10-23 (Asia/Seoul). 사내 LLM 커스텀 헤더 구현·독립 검토·전체 회귀 검증 완료.
- 최종 대상 체크아웃: `/Users/leebw/workspace/claude/pi-mcp`, 브랜치 `main`. 통합: `/Users/leebw/workspace/claude/pi-mcp-worktrees/corporate-headers`, `codex/corporate-headers/integration`.
- 작업 HEAD: `b295bdb96ed0f00e5007ae30ba627b0e01e25c7c` (이 handoff 커밋 직전). 최종 코드 및 독립 검증 SHA: `52104b205e8c26fe0e9ca99c57da886209713bec`.
- 호환 기준은 설치된 `claude_delegator`의 7개 도구이며, Claude Code 전체 제품 또는 `claude mcp serve` 전체 도구를 뜻하지 않음.
- 구현: `pi_health`, `pi_delegate`, `pi_status`, `pi_result`, `pi_list`, `pi_cancel`, `pi_followup`; 전용 Git worktree, 비동기 실행, 중복 요청 방지, 동시성 제한, 세션 후속 작업, 취소와 결과 보존.
- 사내 환경: 프록시, 회사 CA, 내부 npm 레지스트리, 모델 게이트웨이, 명시적 비밀 환경변수 전달. Pi 1.4.0과 의존성을 lockfile로 고정.
- 추가 기능: provider/model/modelOverrides의 임의 HTTP 헤더 및 환경변수 치환, 커스텀 Authorization, 작업 생성 전과 Pi 실행 전 검증. 누락된 값·잘못된 문자·명령형 자격증명은 차단.
- 보호: 짧은 값·복합 값·JSON 이스케이프·HTTP 공백 정규화·Bearer/URL 중첩 인증값 마스킹. 공개 자유 텍스트는 보호하고 작업 조회/취소용 제어 필드는 유지. 전용 auth.json 갱신값과 OAuth 환경 범위를 보존.
- 검증: gram의 Node 24.22.0 컨테이너에서 최종 코드 전체 독립 회귀 **174/174 통과**, 실패·스킵 0. 네트워크를 비활성화한 컨테이너 내부 모의 API로 실제 Pi 헤더 전송·도구 호출·인증 우선순위와 프록시/CA·MCP 회귀를 확인.
- 독립 Astra 최종 승인: 짧은 비밀값과 일반 인증 마스킹의 충돌, HTTP 공백 제거 후 값 노출 등 마지막 P2 두 건 해결. 최종 검증 이후 변경은 문서뿐임. 예제 JSON 3개 구문 및 diff 공백 검사 통과.
- 근거: [헤더 계획 및 완료 기록](docs/corporate-headers-plan.md), [구현/TDD 기록](docs/corporate-headers-report.md), [최종 독립 회귀](docs/corporate-headers-regression.md). 초기 구현 검증은 [기존 회귀 기록](docs/regression-report.md) 참고.
- 원격 테스트 컨테이너, 전용 이미지 및 gram의 `/tmp/pi-mcp-headers-20261023` 정리 완료. 보고서의 로그 경로는 당시 실행 기록이며, 결과 요약은 Git에 보존. 검토용 로컬 브랜치/worktree는 유지.
- 미검증: 실제 사내 API 형식·필수 헤더·프록시 인증·CA 체인·저장소 인증. 회사 주소·자격증명이 없어 실제 사내망 연결은 하지 않음. OpenAI 호환 Chat Completions 및 모의 인증을 기준으로 구현.
- 보안 한계: 파일/명령 정책은 OS 샌드박스가 아니며 프록시만으로 외부 통신이 차단되지 않음. 기존 Git hook/textconv 실행 및 허용 명령의 호스트 접근 문제는 이번 헤더 기능에서 해결하지 않음. 비공개 Pi 세션·작업 공간도 보호 필요.
- 운영 한계: 종료 확인이 불가능한 작업은 격리되어 동시성 슬롯을 유지하며, 이 버전에 MCP 격리 해제 도구는 없음. OAuth는 pi-mcp 전용 자격증명을 사용.
- 다음 단계: [설치 안내](docs/corporate-setup.md)의 헤더 설정에 실제 사내 헤더 이름을 적용하고 해당 환경변수를 `envAllowlist`에 등록. 승인된 CA·프록시·API URL·모델을 설정한 뒤 `pi_health`와 작은 review 작업으로 사내 인증·스트리밍·도구 호출을 검증. 비밀값은 파일/대화 대신 실행 환경으로 주입.
- 실제 MCP/global 설정 변경, 원격 push, 배포, 게시 및 유료 모델 호출은 수행하지 않음.
- 설계와 범위: [계획](docs/plan.md), [호환 범위](docs/parity.md), [운영 안내](docs/operations.md).

## 작업 기록

### 2026-10-23 — 사내 LLM 커스텀 헤더
- 임의 provider/model 헤더, 환경변수 참조, 커스텀 Authorization과 사전 검증 추가.
- 실제 Pi 모의 요청과 비밀값 마스킹 보완을 RED/GREEN으로 검증, 독립 Astra 승인.
- 작업 `b295bdb`, 최종 코드 `52104b2`; 독립 전체 회귀 174/174 통과, 문서·예제 제공.
- 원격 테스트 자원 정리 완료. 실제 회사 인증과 기존 OS 격리/외부 통신 제약은 후속 운영 검증 항목.

### 2026-10-23 — Pi MCP 사내 프록시 지원
- 빈 저장소에서 Pi 1.4.0 기반 7개 MCP 위임 도구와 사내 네트워크 설정 구현.
- 독립 검토에서 발견한 경로 우회, 인증값 마스킹, 종료 처리, 세션 복구 문제 수정 및 회귀 검증.
- 작업 `db4bb76`, 최종 코드 `a9dfdec`; 전체 회귀 132/132와 최종 영향 테스트 2/2 통과.
- 설치·운영·호환 문서 제공, 로컬 main 반영 및 원격 테스트 자원 정리.
