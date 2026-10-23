## 현재 상태

- 날짜: 2026-10-23 (Asia/Seoul). 사내 전용 격리 Pi 에이전트 추가, 독립 보안 검토 및 전체 회귀 검증 완료.
- 최종 대상 체크아웃: `/Users/leebw/workspace/claude/pi-mcp`, 브랜치 `main`. 통합 worktree: `/Users/leebw/workspace/claude/pi-mcp-worktrees/internal-agent`, `codex/internal-agent/integration`.
- 기록 시점 작업 HEAD: `a464aed9ef396c548b703e1016300ea8a8fd2fdd` (이 handoff 커밋 직전). 독립 검증한 최종 소스 SHA: `69a30f66c4577d31827127a97aedb5cb512df1b3`; 이후 변경은 문서뿐임.
- 새 `internal-agent` Docker 프로필: 전체 Pi/MCP/허용 명령을 network none, UID/GID1000, 읽기 전용 root, capability0, no-new-privileges, 기본 seccomp/LSM, 자원 제한 안에서 실행. 기본 호스트 실행 모드와 별도로 선택해야 함.
- 통신: agent 루프백 → 읽기 전용 Unix 소켓 → 별도 gateway → 관리자가 승인한 고정 사설 IPv4/HTTPS 호스트/경로/모델 한 곳만 허용. DNS 우회·일반 프록시·외부 MCP·서버 검색 도구·원격 이미지 URL·리다이렉트는 차단. TLS 검증 유지.
- 사내 LLM 커스텀 인증 헤더는 gateway 전용 환경 파일에서만 주입. agent에는 더미 키만 전달. Compose raw env 파일로 리터럴 `$` 보존, 실행 전 환경변수 이름·파일 권한 검사.
- 호스트 저장소/상태/Home/SSH/Docker 소켓 마운트 없음. 별도 전용 볼륨에 선택한 커밋의 Git bundle(최대64MiB)을 표준입력으로 반입. 호스트 Git 설정·훅·미추적 파일·소켓은 반입하지 않음. 결과는 MCP 텍스트·diff로 검토.
- 기존 7개 MCP 도구, Pi1.4.0 고정, 사내 LLM 임의 헤더·인증값 마스킹 및 일반 모드 프록시/CA 지원 유지. Claude Code 전체 기능 호환을 주장하지 않음.
- 검증: gram 새 이미지/격리 환경에서 독립 전체 **190/190 통과**, 15 suites, 실패·취소·스킵0. 실제 Pi read 도구 호출, MCP 재연결·후속 작업·취소·gateway 누락 시작 거부 통과.
- 보안 실행 검증: TCP/UDP/DNS/AF_VSOCK/프록시 우회 거부, Unix 소켓 삭제·이름 변경 거부, 금지 사설 서비스 요청0. 유효 CA200, CA 누락·TLS 호스트명 오류·302 redirect 각각502.
- 독립 Astra 최종 소스 검토 승인, 차단할 결함 없음. 독립 agent 환경 검사와 부모의 환경/PID1 및 설정·작업·세션57파일 추가 검사에서 gateway 시험용 인증값 부재 확인.
- 실행 안내: [사내 격리 프로필](docs/internal-agent.md). 근거: [설계·최종 검토](docs/internal-agent-plan.md), [gateway TDD](docs/internal-gateway-report.md), [runtime TDD/재현](docs/internal-runtime-report.md), [독립 회귀](docs/internal-agent-regression.md).
- gram의 이 작업 전용 컨테이너·네트워크·볼륨·이미지·소스/설정 디렉터리 정리 완료. `/tmp/piinternal-regression-20261023-full-test.log`만 보존. 로컬 검토용 브랜치/worktree는 유지.
- 미검증: 실제 회사 LLM API·인증 헤더·CA·네트워크 및 서버 측 검색/외부 라우팅 정책. 회사 주소·자격증명이 없어 실제 회사망 연결은 하지 않음.
- 지원 조건: Linux Docker, Compose>=2.30, 승인된 사내 LLM까지 직접 HTTPS 경로. 포워드 프록시만으로 LLM에 도달하는 구성, 다른 API 형식은 추가 지원 필요. 현재 OpenAI 호환 Chat Completions만 지원.
- 경계: 상위 Claude Code/MCP 클라이언트의 클라우드 통신, 승인 LLM 서버의 자체 외부 통신, Docker 관리자/호스트 root/커널 침해는 별도 통제 대상. 전용 볼륨 디스크 할당량 제한과 컨테이너 중지 후 작업 자동 재개는 제공하지 않음.
- 다음 단계: 사내 관리자가 승인한 고정 IP·TLS 호스트·CA·모델·헤더 변수로 개별 설정 파일 준비 → preflight → 전용 Docker 프로필 실행 및 admission 검사 → 검토한 커밋 반입 → 별도 `pi-internal` MCP 등록 및 작은 review 작업으로 사내 수용 검사.
- 실제 MCP/global 설정 변경, 원격 push, 배포, 게시, 유료 모델 호출은 수행하지 않음.

## 작업 기록

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
