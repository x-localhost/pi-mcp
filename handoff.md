## 현재 상태

- 날짜: 2026-10-24 (Asia/Seoul). 사용자가 지정한 부족 항목 **3–8 보완 완료**, 독립 검토·회귀·실제 격리 프로필 수용 검사 통과.
- 최종 대상: `/Users/leebw/workspace/claude/pi-mcp`, `main`. 작업 브랜치/worktree: `codex/completion/integration`, `/Users/leebw/workspace/claude/pi-mcp-worktrees/completion`. 기존 main 기준: `edf7285bd8ae559d5a3250b4c07075ce681c20e2`.
- 기록 시점 작업 HEAD: `de73fd829694c28d935eb52f06edd53da59b61a3` (별도 handoff 커밋 직전). 최종 실행 소스: `fca6495c89c61c1d359615766eb754baab84685e`; 이후 변경은 검증 기록·계획·handoff 문서뿐임.
- 3 산출물: 변경·신규·바이너리 파일의 불변 스냅샷, 삭제/모드 메타데이터, 페이지 조회와 SHA-256 검증 내보내기. 비밀값 제거·생략·한도 초과를 명시하며 비공개 원본 체크포인트와 공개 결과를 분리.
- 4 작업 운영: 지속 FIFO 대기열, MCP 연결 종료 후 dispatcher 유지, Linux 프로세스 신원 기반 복구/격리, 대기·실행 작업 취소, 참조·세션·중복 요청 기록을 보존하는 정리. 애매한 소유권은 자동 복구하지 않음.
- 5 검증: 실행 성공과 실제 관리자 승인 검증 명령 결과를 분리. 검증 전후 소스 변경을 확인하고 최종 산출물 digest와 보고서를 연결; 미실행·실패·변경·검증 불가를 구분.
- 6 에이전트 제어: 이벤트 커서, 실행 중 steer/ACK, 제한된 inline 이미지, 불변 코드·세션 fork, 관리자 allowlist 기반 stdio/고정 사내 HTTPS MCP 도구. 총 Pi-MCP 도구 14개; 전체 Claude Code/MCP 프로토콜 호환은 아님.
- 7 오프라인 준비: 커밋·해시가 고정된 의존성/LFS/submodule 자료 반입, 충돌·경로 검증, 프로젝트별 이미지 예제. 외부 설치 없이 준비된 자료로 실제 검증 명령 실행 확인.
- 8 진단·예산: 본문/인증값 없는 제한된 gateway 감사 정보, 공유 요청률·출력·동시성 제한, 관측 토큰/비용 예산, 저장소 사용량에 따른 admission 및 보존 정리. 비용·디스크의 강제 할당량 보장은 아님.
- 기존 격리 경계 유지: agent network none, UID1000, 읽기 전용 root, capability0, no-new-privileges, 호스트 소스/상태/Docker 소켓 마운트 없음. 고정 사내 LLM/승인 MCP만 relay 경유; 인증 헤더 원본은 gateway에만 보관.
- 독립 전체 회귀: `d6f38345c0186ea4c0e9bf20572e381025b5f9f0`에서 **254/254**, 15 suites, 실패·취소·스킵0. 실제 프로필이 발견한 예제 model8192/gateway4096 불일치를 수정하고 preflight 검사를 추가.
- 최종 `fca6495` 영향 테스트 **10/10**, 새 이미지/볼륨에서 Pi read/write·재연결·follow-up·취소, 고정 자료 반입, 실제 verifier passed, 최종 소스 digest 일치, 페이지별/전체 해시 및 mode0600 export 통과. 전체254개를 최종 SHA에서 재실행했다고 주장하지 않음.
- 보안 수용 검사: TCP/UDP/DNS/AF_VSOCK/프록시 우회·소켓 변경 거부, gateway 누락 시작 거부, 금지 서비스 요청0. 정상 CA200, CA 누락/호스트명 오류/redirect 각각502. 반입 소스의 시험 fixture를 제외한 agent/process/config/state108개 검사에서 시험용 gateway 인증값 부재 확인.
- 독립 Astra 최종 검토의 6개 지적 수정 승인. 부모가 diff·보고서·문서 링크·공백 검사와 원격 전체 테스트 로그 및 자원 정리를 재확인. 잔여 구현 차단 사항 없음.
- 근거: [계획·검토 결정](docs/completion-plan.md), [독립 회귀·정확한 명령](docs/completion-regression.md), [runtime TDD](docs/completion-runtime-report.md), [gateway TDD](docs/completion-gateway-report.md), [산출물 TDD](docs/completion-artifacts-report.md), [cap 수정 TDD](docs/completion-model-cap-report.md).
- 지원 조건: 일반 runtime도 Linux `/proc`·`flock` 필요. Mac 클라이언트는 Linux/Docker runtime에 연결. 기존 worker를 중지한 뒤 업그레이드하며 구/신 lock 구현을 혼용하지 않음. 격리 프로필은 Docker/Compose>=2.30 및 사내 LLM 직접 HTTPS 경로 필요.
- 미검증/범위 밖: 실제 사내 API·인증/CA·네트워크 수용 검사(항목1), 사용자별 OS 격리(항목2), 상위 클라이언트와 승인 LLM/MCP 백엔드의 자체 외부 통신. 관리자 backendAttested 설정은 백엔드 네트워크 차단을 기술적으로 보장하지 않음.
- 원격 작업 전용 컨테이너·네트워크·볼륨·이미지·소스/설정·임시 키 정리 완료. gram의 `/tmp/pi-completion-regression-evidence-20261024`에 로그/시험 스크립트/검증 export, `/tmp/pi-mcp-completion-20261024-logs/runtime`에 이전 단위 로그3개 보존. 로컬 검토 worktree는 유지.
- 다음 운영 단계: [격리 실행 안내](docs/internal-agent.md)에 따라 실제 사내 설정 준비 → preflight → admission → 커밋/승인 자료 반입 → 작은 작업으로 사내 수용 검사. 선택 기능은 [runtime](docs/completion-runtime.md), [오프라인/산출물](docs/offline-artifacts.md), [승인 MCP](docs/approved-mcp.md) 참고.
- 실제 MCP/global 설정 변경, 원격 push, 배포, 게시, 유료 모델 호출은 수행하지 않음.

## 작업 기록

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
