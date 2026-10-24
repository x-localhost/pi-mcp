## 현재 상태

- 날짜: 2026-10-24 (Asia/Seoul). 이전 하네스 기능 보완에 이어 평가 러너 구현·오프라인 평가·검토·검증을 완료했음. 평가 관련 구현 차단 사항 없음.
- 반영 대상: `/Users/leebw/workspace/claude/pi-mcp`, `main`. 작업 브랜치/worktree: `codex/evaluation/integration`, `/Users/leebw/workspace/claude/pi-mcp-worktrees/evaluation`. 시작 main: `edff46ff3ca260a73cf8e6a6166d6080ca484b80`.
- 기록 시점 HEAD/작업 커밋: `ca1feb2f73363bac49bdb9643adc9b05f484b23b` (이 별도 handoff 커밋 직전). 최종 검증 소스: `27c5eb22bcb18b6f0f2d88c891ff52ffdde8faa1`; 평가 구현: `acd9d63a680283eed8006a2e4afd313851126b1e`. 이후 변경은 문서뿐임.
- 평가 기능: 버전 과제 10개, 독립 증거 판정, 코드/계약/과제/설정 식별자, 재생·비교 CLI, 제한 시간과 정확한 실행 재시도, 실제 Manager/fake-Pi 결과를 오프라인 기록으로 내보내는 경로.
- 판정 보완: 원자료와 보고서 성공·집계의 일관성 검사, 누락 결과의 분모 유지, 필수 파일 존재와 삭제 구분, 실행 성공과 파일 보존 분리, 비공개 입력을 노출하지 않는 오류, 변경된 실행 소스의 live 시작 거부.
- 재시도 상태는 Manager의 `stateDir/evaluation-runs`에 고정됨. 호환용 `--state-dir`을 바꿔도 기존 run ID의 설정·과제·코드 바인딩을 우회하지 못함.
- gram의 커밋 소스 전체 회귀 **384/384**, 15 suites, 실패·취소·스킵0, exit0, 257310.363567ms. 평가 전용 **62/62**와 실제 fake-Pi CLI live→bundle→replay 통과.
- 독립 Astra가 `73c42f7`의 평가 구현을 승인했으며 이후 평가 구현은 동일함. 전체 회귀에서 드러난 기존 준비 파일 JSON 읽기 경쟁은 테스트 네 줄로 수정, 영향 검사 6개를 5회 모두 통과한 뒤 전체 회귀를 다시 실행했음. 최초 383/384 실패도 보존.
- 합성 baseline은 정상3/10, 의도한 부정·미확인7/10. regressed와 incomplete는 각각2/10이며 변경 과제와 누락·불완전 실행을 정확히 구분함. 반복 결과 byte-identical. 이 수치는 실제 모델 해결률이 아님.
- 제한: 제공 증거의 일관성을 검사하며 출처를 암호학적으로 인증하지 않음. 파일 보존은 전체 API/지시 의미 보존을 뜻하지 않고, 재개 지표는 요청→job 멱등성임. Manager가 충분히 관찰하지 못한 재개 증거는 unknown 유지.
- 실제 유료·사내 모델 성능은 측정하지 않음. 별도 live 평가에는 일치하는 과제 저장소·verifier·허용된 provider와 명시적 실행 승인이 필요함. 외부 model/auth/agent 파일 내용은 설정 fingerprint가 직접 고정하지 않으므로 필요하면 별도 고정해야 함.
- 원격 작업 컨테이너·이미지 태그·소스/빌드 폴더5개 정리 확인. gram `/tmp/pi-harness-evaluation-evidence-20261024`에 로그/보고서/명령/메타데이터/정리 기록69개(체크섬 포함), 디렉터리0700·파일0600 보존. 이전 하네스 증거18개는 해시 동일.
- 로컬 임시 조정 파일과 전용 bridge 설정은 제거. 기존·검토 worktree는 보존. live bridge 설정 SHA256·0644 권한은 시작과 동일하며 live MCP/global 설정·push·게시·배포 변경 없음.
- 기존 하네스 런타임은 main 기준과 동일함: 인수 계약, 독립 리뷰, 세션 교체, 문맥·관측, 순차 워크플로와 격리 Pi 수용 검증은 [이전 기록](docs/harness-regression.md) 참조. Linux `/proc`·`flock` 등 운영 조건은 유지.
- 정확한 명령·모델 역할·RED/GREEN·실패 이력·증거: [평가 검증](docs/evaluation-verification.md), [계획](docs/evaluation-plan.md), [독립 검토](docs/evaluation-review.md), [사용법/제약](docs/harness-evals.md).
- 통합 절차: 이 handoff를 별도 커밋한 뒤 원래 main checkout의 브랜치·HEAD·tracked/untracked clean을 다시 확인하고 `--ff-only`로 반영. 필수 추가 구현·검증은 없으며 실제 모델 벤치마크는 별도 범위임.

## 작업 기록

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
