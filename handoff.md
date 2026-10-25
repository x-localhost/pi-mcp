## 현재 상태

- 날짜: 2026-10-25 (Asia/Seoul). 사내 LLM의 빈 응답·비정상 응답 대응과 전체 소스 리뷰 결함 수정을 완료했음. 차단 사항 없음.
- 반영 대상: `/Users/leebw/workspace/claude/pi-mcp`, `main`. 통합 브랜치/worktree: `claude/llm-resilience/integration`, `/Users/leebw/workspace/claude/pi-mcp-worktrees/llm-resilience`. 시작 main `0fd464f`, 작업 최종 커밋 `3dee19a`(코드 최종 트리 `58e5f6a`).
- worker 복구: Pi가 끝난 뒤 마지막 응답을 판정해 빈 응답·잘린 빈 응답·파싱 오류·재시도 소진 장애면 같은 세션에서 이어가기 프롬프트를 보냄. 기본 2회, 5초부터 지수 백오프, 설정 `providerRecovery`. 완료는 마지막 응답이 정상일 때만 인정. Pi 자체 자동 재시도도 명시적으로 켬. [사용법](docs/provider-resilience.md).
- 사내 gateway: Pi에 한 바이트도 보내기 전이면 429/5xx·네트워크 오류·빈 스트림·깨진 JSON·내용 없는 응답을 최대 3회 재시도(지터 백오프, Retry-After 상한). 전송 시작 후 깨진 데이터는 연결을 끊어 Pi 재시도를 유도, 소진 시 503. 기본 켜짐, `retry.maxAttempts: 1`로 끔. [안내](docs/internal-agent.md).
- 리뷰 결함 수정: dispatcher가 잠금 대기 오류로 조용히 죽던 문제, Pi stdin EPIPE 크래시, 신원 기록 전 종료 시 영구 격리, 아티팩트 export 종료 상태 누락, 보존 스캔 한도로 제출·health가 막히던 문제, 중지 시 Pi 즉시 강제 종료.
- 검증(gram, `pi-mcp-llmres:base-20261025`, network none): 기준 main 384/384 → 최종 트리 전체 **467/467**. 실제 Pi 1.4.0이 모의 게이트웨이의 빈 응답 뒤 정상 응답으로 완료되는 테스트 포함. RED/GREEN·리드 수정 내역은 [결과](docs/llm-resilience-plan.md#results--2026-10-25).
- 독립 리뷰: 네이티브 Fable reviewer 승인(차단 0), 비차단 6건 후속 반영. Codex bridge가 다른 세션 작업으로 계속 가득 차 Astra 설계 자문·검토는 실행하지 못했음.
- 제한: 실제 사내 LLM 부하 상황은 측정하지 않음(모의만). gateway 재시도는 사내 전용 Docker 프로필에만 해당하고, 호스트 모드는 worker 복구와 Pi 자체 재시도로 대응.
- 운영 메모: gram `/home`이 100% 차 있어 Docker 빌드 시 `DOCKER_CONFIG`를 /tmp로 지정해야 했음(정리하지 않음, 공유 자원). 원격 작업 디렉터리는 정리 완료.
- 다음 단계: 실제 사내 환경에서 `providerRecovery`와 gateway `retry` 값을 관찰 후 조정. 필수 미완료 항목 없음.

## 작업 기록

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
