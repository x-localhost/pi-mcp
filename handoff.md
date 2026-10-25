## 현재 상태

- 날짜: 2026-10-26 (Asia/Seoul). Claude Code에서 Pi MCP를 서브에이전트로 쓰기 위한 기능을 추가했음. 차단 사항 없음.
- 반영 대상: `/Users/leebw/workspace/claude/pi-mcp`, `main` `5136593`(시작 `3da6b20`). 통합 브랜치 `claude/claude-code-kit/integration`(병합 후 삭제). 최종 소스 `4eb3974`.
- `pi_wait`: 작업 1–8개를 한 번에 기다림(`until` any/all, 최대 300초, 기본 45초). 취소·진행 알림 지원, 작업별 요약과 다음 단계 힌트 반환.
- `pi_patch`: 종료된 작업의 공개 산출물로 `git apply` 가능한 전체 패치(신규·삭제·바이너리·실행권한 포함)를 만들고 페이지로 반환. `include_text:false`로 메타데이터만 먼저 확인. 양쪽 내용·경로를 현재 비밀값 정책으로 다시 검사하고, 걸리면 해당 파일을 빼고 `applicable:false`. 사내 Docker 프로필은 `internal-agent/export-patch.mjs`로 반출.
- 모든 MCP 응답을 압축 JSON으로 바꿔 토큰 절약. `pi_capabilities`에 `claudeCode` 한도 추가.
- Claude Code 묶음: `examples/claude-code/`(`.mcp.json` 예시 2종, `pi-worker` 서브에이전트, `pi-delegation` 스킬), [한국어 안내](docs/claude-code.md). 사용자 `~/.claude`에는 설치하지 않았음(전역 설정 변경 금지).
- 검증(gram, `pi-mcp-cck:base-20261026`, network none): 기준 467/467 → 최종 **517/517**. 단위별 RED/GREEN·3회 반복 안정성 확인. [결과](docs/claude-code-plan.md#results--2026-10-26).
- 독립 리뷰: Astra 4회차 승인(차단 0). 1–3회차에서 비밀값 노출 경로(바이너리·8진 인용 파일명·auth/models 자격증명)와 크기 한도·취소·누락 집계를 지적받아 모두 수정.
- 남은 한계: 실제 Claude Code 세션 구동, 실제 사내 LLM, 실제 compose 스택에서의 `export-patch.mjs`는 미검증. 활성 빌드 중 정리 경합 테스트는 스케줄링 의존(구조상 안전 근거는 결과 문서에 기록).
- 운영 메모: gram `/home` 100% → Docker 빌드 시 `DOCKER_CONFIG=/tmp/...` 사용. `run-suite.sh`의 tar는 `--no-same-owner --no-overwrite-dir`가 필요(없으면 approved-mcp 테스트 2건 실패).
- 다음 단계: 원하면 `examples/claude-code`의 에이전트·스킬을 사용 프로젝트의 `.claude/`(또는 `~/.claude/`)에 복사하고 `claude mcp add`로 서버 등록 후 실제 작업 1건으로 확인.

## 작업 기록

### 2026-10-26 — Claude Code 서브에이전트 지원
- `pi_wait`(다중 대기)·`pi_patch`(적용 가능한 전체 패치, 사내 반출 스크립트)·압축 JSON·Claude Code 에이전트/스킬/안내 추가.
- Astra 리뷰 4회(3회 반려 후 승인)로 패치 비밀값 노출 경로 등 수정; 작업 `5136593`(소스 `4eb3974`).
- 전체 517/517(gram), 단위 RED/GREEN·안정성 3회. 실제 Claude Code·사내 환경 구동은 미검증.
- 원격 작업 자원 정리, live/global 설정·push·배포 변경 없음.

### 2026-10-25 — 사내 LLM 빈·비정상 응답 대응과 전체 소스 리뷰 수정
- worker 이어가기 복구(`providerRecovery`)와 gateway 사전 검증·재시도 추가, 마지막 응답이 비어도 성공 처리되던 구멍 차단.
- 리뷰 결함 6건(dispatcher·RPC·격리·export·스캔 한도·중지) 수정, 최종 리뷰 비차단 6건 후속 반영.
- 작업 `3dee19a`(코드 `58e5f6a`); 전체 467/467, Fable reviewer 승인, Astra는 bridge 포화로 미실행.
- 원격 작업 자원 정리, live/global 설정·push·배포 변경 없음.

### 2026-10-24 — 하네스 평가 구현 및 오프라인 평가 완료
- 버전 과제·증거 grader·재생/비교·live 기록 경로와 정확한 재시도 상태 구현, 독립 검토 지적과 기존 테스트 읽기 경쟁 수정.
- 최종 소스 `27c5eb2`: 전체384/384, 평가62/62, 독립 Astra 승인, 합성 재현/회귀 감지와 fake-Pi 왕복 통과. 실제 모델 성능 수치가 아님.
- 작업 `ca1feb2`; [평가 검증](docs/evaluation-verification.md)에 실패 이력·제약·원격 증거69개 기록. 작업 자원 정리, live/global 설정 보존.
- 별도 handoff 커밋 후 clean local main fast-forward. 이전 평가 권한 대기 상태는 해소되었으며 필수 미완료 항목 없음.

### 2026-10-24 — 하네스 기능 보완과 최종 회귀
- 경로/저장소·MCP 시작·인수 계약·독립 리뷰·세션 교체·관측/추적·순차 워크플로 구현 및 검토 지적 수정.
- 최종 실행 소스 `661a898`, 전체322/322와 새 격리 Pi 수용 통과, 독립 Astra 승인. 작업 기록 `11a479b`; [상세 증거](docs/harness-regression.md).
- 평가 러너는 Sonnet bridge Git 승인 거부로 미구현, 사용자 허용 범위 결정 대기. 우회·전역 설정 변경 없음.
- 작업 원격 자원 정리 및 증거 보존, 별도 handoff 커밋 후 clean local main 반영 대상.

### 2026-10-24 — Pi/Pi-MCP 부족 항목 3–8 보완
- 불변 산출물·큐/안전 복구·실제 검증·steer/image/fork/승인 MCP·오프라인 자료·진단/예산/정리 구현, MCP 도구14개.
- 독립 전체254/254, 최종 수정 영향10/10 및 새 격리 이미지 실제 Pi/검증/export/취소/차단 수용 검사 통과; 독립 Astra 지적 해결.
- 작업 `de73fd8`, 최종 실행 소스 `fca6495`; [검증 기록](docs/completion-regression.md)과 [계획](docs/completion-plan.md). Linux runtime 필요, 실제 사내 수용 검사는 별도.
- 원격 작업 자원 정리 및 증거 보존, clean main fast-forward용 최종 인계. 외부 push/배포/실제 설정 변경 없음.

### 2026-10-23 — 외부 접촉 차단 사내 Pi 에이전트
- network none 전용 Docker 프로필, 고정 사내 LLM gateway, 인증 헤더 분리, 개인 볼륨 Git bundle 반입 추가.
- 실제 Pi와 Docker 차단·TLS 검증, 독립 Astra 승인 및 전체 회귀190/190 통과.
- 작업 `a464aed`, 최종 소스 `69a30f6`; 실행 안내와 재현·검증 기록 제공.
- 시험용 원격 자원 정리, 로컬 main 반영 대상. 실제 사내 설정·수용 검사는 운영 환경에서 필요.

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
