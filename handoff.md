## 현재 상태

- 날짜: 2026-10-23 (Asia/Seoul). 구현·검토·검증 완료, 로컬 `main`에 반영.
- 최종 체크아웃: `/Users/leebw/workspace/claude/pi-mcp`, 브랜치 `main`. 통합 작업은 `codex/pi-mcp/integration`에서 수행.
- 작업 HEAD: `db4bb76f94e45de4abb1a4b57789bac00521c940` (이 handoff 커밋 직전). 최종 구현 커밋: `a9dfdec01116a64ef79e05bc9a7c81edb9ad9e28`.
- 호환 기준은 설치된 `claude_delegator`의 7개 도구이며, Claude Code 전체 제품 또는 `claude mcp serve` 전체 도구를 뜻하지 않음.
- 구현: `pi_health`, `pi_delegate`, `pi_status`, `pi_result`, `pi_list`, `pi_cancel`, `pi_followup`; 전용 Git worktree, 비동기 실행, 중복 요청 방지, 동시성 제한, 세션 후속 작업, 취소와 결과 보존.
- 사내 환경: 프록시 환경변수, 회사 CA, 내부 npm 레지스트리, 모델 게이트웨이, 명시적 비밀 환경변수 전달. Pi 1.4.0과 의존성을 lockfile로 고정.
- 검증: gram의 Linux/Node 24 컨테이너에서 전체 독립 회귀 **132/132 통과** (`4744d1f`). 마지막 인증값 보완은 최종 구현 커밋에서 영향 테스트 **2/2 통과**. 실제 Pi의 MCP·파일 도구·HTTP CONNECT·CA 검증은 로컬 mock 서비스로 실행.
- 독립 Astra 최종 검토 승인. 모든 코드 변경을 부모가 검토하고 커밋했으며, 최종 검증 이후 변경은 문서뿐임.
- 예제 설정 JSON 3개 및 운영 안내 도구 호출 JSON 7개 구문 확인. 관련 상세 근거는 [검증 기록](docs/regression-report.md), [구현 기록](docs/core-unit-report.md).
- 테스트 컨테이너, 전용 rg/fd 이미지와 gram의 `/tmp/pi-mcp-20261023` 임시 파일 정리 완료. 검토용 로컬 브랜치/worktree는 보존.
- 미검증: 실제 회사 프록시 인증, CA 체인, LLM 게이트웨이와 사내 저장소 인증. 회사 주소·자격증명이 제공되지 않아 실제 사내망 연결은 검증하지 않음.
- 운영 한계: 파일/명령 정책은 OS 샌드박스가 아님. 종료 확인이 불가능한 작업은 격리되어 동시성 슬롯을 유지하며, 이 버전에는 MCP 격리 해제 도구가 없음. OAuth는 pi-mcp 전용 자격증명을 사용.
- 다음 단계: [설치 안내](docs/corporate-setup.md)에 따라 회사 승인 경로·CA·프록시·provider/model을 설정하고, 비밀을 환경으로 주입한 후 MCP 호스트에 등록. `pi_health` 다음 작은 review 작업으로 사내 연결을 확인.
- 실제 MCP/global 설정 변경, 원격 push, 배포, 게시 및 유료 모델 호출은 수행하지 않음.
- 설계와 범위: [계획](docs/plan.md), [호환 범위](docs/parity.md), [운영 안내](docs/operations.md).

## 작업 기록

### 2026-10-23 — Pi MCP 사내 프록시 지원
- 빈 저장소에서 Pi 1.4.0 기반 7개 MCP 위임 도구와 사내 네트워크 설정 구현.
- 독립 검토에서 발견한 경로 우회, 인증값 마스킹, 종료 처리, 세션 복구 문제 수정 및 회귀 검증.
- 작업 `db4bb76`, 최종 코드 `a9dfdec`; 전체 회귀 132/132와 최종 영향 테스트 2/2 통과.
- 설치·운영·호환 문서 제공, 로컬 main 반영 및 원격 테스트 자원 정리.
