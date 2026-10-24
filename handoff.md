## 현재 상태

- 날짜: 2026-10-24 (Asia/Seoul). 하네스 검토의 안전성·실행·관측·순차 워크플로 보완을 구현·검증했음. **평가 러너는 권한 확인 대기라 미구현**이며 전체 요청을 모두 완료했다고 주장하지 않음.
- 최종 대상: `/Users/leebw/workspace/claude/pi-mcp`, `main`. 작업 브랜치/worktree: `codex/harness/integration`, `/Users/leebw/workspace/claude/pi-mcp-worktrees/harness`. 시작 main: `52a13358c175950b12dec31f1eb5f0f421129cc2`.
- 기록 시점 HEAD: `11a479b3508832cffd0f635cd198c628265e79cf` (별도 handoff 커밋 직전). 최종 실행 소스: `661a898e715ac16eb80224b880a3be8c7371cd93`; 이후 변경은 문서뿐임. clean main fast-forward용 검증 완료.
- 경로/저장소: file URI를 경로 승인 전에 거부하고, 저장소 용량 계산은 심볼릭 링크 대상을 따라가지 않음.
- 승인 MCP: 해당 모드에서 쓰는 서버를 병렬 초기화하고 공통 시작 한도·정상 호출 한도·실패 연결 정리를 분리.
- 완료 판정: 버전 있는 인수 계약과 verifier 선택을 후속 작업에 상속. 실행·검증·인수를 분리하고 최종 코드/계약 digest와 판정 증거를 연결. 선언된 이미지 내 grader 파일의 전후 해시·소유권 검사 추가.
- 독립 리뷰: 불변 코드에서 별도 읽기 전용 worktree와 새 대화를 시작. 승인·거절·재요청은 digest에 묶이며 오래된 승인 재요청이 철회를 취소하지 않음. caller 판정이지 인증된 사람/신뢰 grader 인증은 아님.
- 긴 작업: 필수 사용자 지시와 혼합 tool-result/user 블록 보존, 도구 호출/결과 묶음 단위 문맥 정리. 새 세션으로 코드·제약·정확한 제한 크기 지시를 넘기고 이전 세션을 봉인. 원시 기록 초과가 완료 코드를 무효화하지 않음.
- 이미지가 필요하거나 과거 이미지 여부를 모르면 fresh rollover를 거부함. 이미지 이관은 구현하지 않았으며 조용히 누락하지 않음. 일반 지시 ledger 32개/1MB, fresh handoff 항목10KB/전체20KB 제한.
- 관측: capability API 포함 MCP 도구18개. 내용 없는 도구/모델 호출/압축/진행 이벤트, 생존 heartbeat와 실제 진행 구분, 선택적 idle/연속 실패 중단. 고정 relay/gateway까지 진단 UUID 연결.
- Pi 내부 SDK의 실제 HTTP 재시도 수는 알 수 없음. 확장 ID는 논리 호출, gateway ID는 관측한 유입 요청이며 반복 표시는 제한된 메모리 기준 진단임. 본문·인증값을 추적 데이터에 넣지 않음.
- 순차 워크플로: 최대16단계의 영속 계획, 정확한 요청 내용 대조, 잠금 내 인수 조건 확인과 제출, 취소 복구, 정리 참조 보호. 응답 하나라도 사용량이 없거나 잘못되면 해당 예산 차원의 후속 진행을 막음. 단계 간 관측 예산이며 진행 중 초과 가능.
- 독립 Astra 최종 검토 승인. 초기 검토의 세션/승인/복구/지시 보존 문제와 최종 혼합 메시지·relay 헤더 누락을 수정. 네이티브 thread 한도로 별도 Sol tester를 재활성화하지 못해 부모가 원격 회귀를 수행했음.
- 최종 `661a898` 새 이미지에서 **322/322**, 15 suites, 실패·취소·스킵0, 253080ms. 앞선 `c52b85a`의320/320과 구별하며 최종 코드 전체를 다시 실행했음.
- 실제 격리 프로필: Pi 읽기/도구·재연결·followup·취소, 새 리뷰와 동일 코드 digest, 승인/철회/재요청, rollover/봉인 통과. source/review/rollover의 논리 호출6개를 gateway 기록과 연결.
- 보안 수용 검사: UID1000, network none, read-only root, capability0, no-new-privileges, seccomp/LSM, TCP/UDP/DNS/AF_VSOCK 차단, 소켓 변조·proxy override·gateway 누락 시 시작 거부; 금지 서비스 요청0.
- 미완료 평가 단위: Sonnet5 bridge job `task-834e646b-d1c9-4531-949f-437df7ae20a8`이 첫 Git 신원 확인 명령의 승인 거부로 파일 변경 전에 종료. 정확한 모델 확인됨. 터미널 completed는 과제 완료가 아니며, 동일 작업을 다른 모델/명령으로 우회하지 않음.
- 필요한 사용자 결정: 이미 보낸 작업 폴더 한정 읽기 전용 Git 허용 목록 추가 질문의 답변. 제공 AGENTS의 승인 거부 우회 금지 규칙 때문에 필요. 승인 시 전역 설정 보호 절차와 브리지 캐시/재시작 여부를 명시해 진행해야 함. 아직 설정 변경·브리지 재시작 없음.
- 평가 다음 단계: 허용 범위를 승인받은 뒤 기존 Sonnet 작업을 정해진 역할로 재개 → 버전 과제 집합/오프라인 replay grader/비교 CLI → gram RED/GREEN → 독립 검토·통합. 실제 유료/사내 모델 평가는 별도 명시 승인 필요. 현재 테스트로 과제 해결 성능을 주장하지 않음.
- 원격 작업 컨테이너·네트워크·볼륨·이미지 태그·소스/설정·임시 인증서 키 정리 확인. 공유 Docker build cache는 유지. gram `/tmp/pi-harness-regression-evidence-20261024`에 로그/검증 스크립트/메타데이터18개 보존. 로컬 기존·검토 worktree 유지.
- 근거: [검증 기록/정확한 명령](docs/harness-regression.md), [계획/설계 결정](docs/harness-plan.md), [기능·제약 안내](docs/harness-runtime.md), [워크플로 운영](docs/harness-workflow.md). 개별 RED/GREEN 보고서는 검증 기록에서 연결.
- 기존 운영 조건 유지: Linux `/proc`·`flock` runtime, Docker/Compose>=2.30 격리 프로필. 실제 사내 API/인증/CA 수용과 사용자별 OS 격리는 별도. live MCP/global 설정, push, 배포, 게시, 실제 사내 모델 호출 없음.

## 작업 기록

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
