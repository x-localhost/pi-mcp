# 사내 전용 Pi 에이전트

기존 호스트 실행 모드는 이 네트워크 격리를 제공하지 않습니다. 사내 전용 작업에는 아래 Docker 프로필을 선택하세요.

기존 Pi MCP와 별도로 선택해서 실행하는 격리 프로필입니다. Pi, MCP 서버, Git 훅, 허용된 셸 명령은 모두 `network_mode: none`인 **agent** 컨테이너 안에서 실행됩니다. 오직 컨테이너 루프백 릴레이 → 읽기 전용 Unix 소켓 → 별도 **gateway** 컨테이너 → 관리자가 지정한 사내 HTTPS LLM 한 곳으로 모델 요청을 보냅니다. 호스트의 저장소나 홈 디렉터리를 컨테이너에 마운트하지 않습니다.

## 준비

Linux Docker Engine과 [Docker Compose 2.30 이상](https://docs.docker.com/reference/compose-file/services/#format) (`env_file.format: raw` 지원)이 필요합니다. Docker의 기본 seccomp 및 LSM을 유지해야 합니다. 관리자에게 승인된 LLM의 HTTPS 호스트명, 고정된 사설 IPv4 주소, 모델 ID, CA 인증서 및 필요한 헤더 환경변수 이름을 받으세요. 사설 IP라는 사실만으로 회사 소유를 증명할 수 없습니다. 게이트웨이 컨테이너가 그 주소로 직접 연결할 수 있는 전용 Docker 네트워크를 별도로 준비하세요. 회사 프록시를 반드시 거쳐야 하는 환경은 현재 지원하지 않습니다. 승인된 LLM 서비스에서 서버 측 웹 검색·외부 라우팅도 비활성화되어 있어야 합니다.

이미지 빌드에는 Node 24.22.0 이미지, 잠긴 `npm ci --ignore-scripts`, Debian 패키지 미러가 필요합니다. 실행 중에는 패키지 설치를 하지 않습니다. 폐쇄망에서는 승인된 이미지·npm·OS 미러 또는 오프라인 빌드 산출물을 먼저 준비하세요. 이미지 태그와 Compose 프로젝트명은 작업별로 고유하게 지정하세요. 앱 코드는 이미지 내부의 root 소유 읽기 전용 파일입니다.

`internal-agent/config.example.json`, `models.example.json`, `gateway.example.json`을 각각 **개별 정규 파일**로 복사해 사내 값으로 수정하세요. 세 파일의 모델 ID는 같아야 합니다. agent 설정의 경로, 실행 파일, provider, 루프백 URL, 더미 API 키는 바꾸지 마세요. 실제 인증 헤더 값은 별도의 gateway 전용 환경 파일에만 넣습니다. 예시는 자리표시자이며 실제 서비스 주소나 비밀값을 포함하지 않습니다. CA 파일도 별도의 정규 파일로 준비합니다. 설정 디렉터리 자체를 마운트하지 않습니다.

Gateway 환경 파일은 헤더가 참조하는 변수만 `KEY=VALUE` 형식으로 넣고 `chmod 600 /private/absolute/gateway.env`로 소유자만 읽고 쓸 수 있게 설정하세요. `format: raw`이므로 값에 따옴표를 덧붙이거나 `$`를 이스케이프하지 않습니다. Node 로더·프록시 등 프로세스 제어용 변수는 허용하지 않습니다.

```sh
export PI_INTERNAL_IMAGE=pi-internal-agent:your-task-id
export PI_INTERNAL_CONFIG_FILE=/private/absolute/config.json
export PI_INTERNAL_MODELS_FILE=/private/absolute/models.json
export PI_INTERNAL_GATEWAY_CONFIG_FILE=/private/absolute/gateway.json
export PI_INTERNAL_CA_FILE=/private/absolute/ca.pem
export PI_INTERNAL_GATEWAY_ENV_FILE=/private/absolute/gateway.env
export PI_INTERNAL_UPSTREAM_NETWORK=your-dedicated-upstream-network
export PI_INTERNAL_PROJECT=pi-internal-your-task-id

docker build -f internal-agent/Dockerfile -t "$PI_INTERNAL_IMAGE" .
python3 scripts/check-internal-agent.py --project "$PI_INTERNAL_PROJECT" --preflight-only
docker compose -f internal-agent/compose.yaml -p "$PI_INTERNAL_PROJECT" up -d
python3 scripts/check-internal-agent.py --project "$PI_INTERNAL_PROJECT"
docker compose -f internal-agent/compose.yaml -p "$PI_INTERNAL_PROJECT" exec -T agent node /app/internal-agent/mcp.mjs
```

마지막 명령은 stdio MCP 서버이므로 일반 터미널에서 실행하면 입력을 기다립니다. Claude Code 등의 MCP 클라이언트에는 같은 `docker compose ... exec -T agent node /app/internal-agent/mcp.mjs`를 **별도 서버** 명령으로 등록하고, 위의 `PI_INTERNAL_*` 경로·프로젝트 변수를 클라이언트 실행 환경에 제공하세요. 예를 들어 Claude Code에서 설정 파일을 직접 관리한다면 `mcpServers.pi-internal.command`를 `docker`, `args`를 `["compose","-f","/absolute/path/to/internal-agent/compose.yaml","-p","pi-internal-your-task-id","exec","-T","agent","node","/app/internal-agent/mcp.mjs"]`로 둡니다. 호스트에 `PI_MCP_CONFIG`나 회사 인증값을 MCP 클라이언트 환경으로 전달하지 마세요. `check-internal-agent.py`가 성공한 다음 연결하세요. MCP 실행 시에도 컨테이너 내부 검사와 게이트웨이 `/healthz` 확인이 실패하면 시작하지 않습니다. `/healthz`는 모델 호출을 하지 않습니다.

## 소스 반입과 결과 확인

호스트 작업 디렉터리는 마운트하지 않습니다. 선택한 **커밋된 로컬 브랜치**만 Git bundle로 표준입력을 통해 새 `/workspace/<name>` 저장소에 반입합니다. Git bundle 작성 시 훅과 fsmonitor를 끕니다. 호스트 `.git/config`, 훅, 미추적 파일, 소켓은 복사되지 않습니다. 반입할 브랜치를 먼저 검토하고 커밋하세요.

```sh
python3 scripts/import-internal-agent.py \
  --repo /absolute/canonical/source-repository \
  --branch reviewed-branch \
  --name reviewed-task \
  --project "$PI_INTERNAL_PROJECT"
```

그 다음 MCP `pi_delegate`에 `repository: "/workspace/reviewed-task"`와 선택한 커밋 SHA를 `base_ref`로 넘기세요. Pi의 결과는 `pi_status`, `pi_result`, `pi_list`로 읽고, 변경된 코드가 필요하면 `pi_result`의 텍스트·diff를 검토해 별도 승인된 호스트 작업 흐름에 적용하세요. 호스트 파일 트리를 자동으로 임의 복사하지 않습니다. 후속 작업은 같은 격리된 저장소와 세션을 사용하며 MCP 클라이언트 연결이 끊어져도 agent 컨테이너 안의 작업은 계속됩니다. 명시적 종료 `docker compose -f internal-agent/compose.yaml -p "$PI_INTERNAL_PROJECT" down`은 컨테이너 안의 작업도 종료합니다. 보존할 결과를 확인하기 전 `down -v`를 사용하지 마세요.

## 경계와 제한

Git bundle 반입이 중간에 실패하면 일부만 생성된 새 `/workspace/<name>` 디렉터리가 남을 수 있습니다. 자동 덮어쓰기나 삭제를 하지 않습니다. 실패 내용을 검토하고 다른 새 이름으로 재시도하거나, 해당 격리 볼륨의 작업을 중단한 뒤 관리자가 정리하세요.

- Agent는 호스트 HTTP 포트를 열지 않습니다. 읽기 전용 소켓 볼륨을 통한 gateway 연결만 허용하고 TCP/UDP/DNS, 일반 프록시, 검색 도구와 원격 미디어 URL 입력은 거절합니다. 정확한 모델 요청 형식은 gateway가 제한합니다.
- LLM API는 OpenAI 호환 Chat Completions의 고정된 모델 하나를 지원합니다. 요청 본문은 최대 4 MiB, 메시지는 128개, 동시 요청은 8개이며, 연결 10초·유휴 30초·전체 응답 120초 제한이 있습니다. 장시간 응답이나 다른 API 형식은 별도 호환 검토가 필요합니다.
- 저장소와 상태는 Docker **이름 있는 전용 볼륨**입니다. 이 설정은 디스크 용량 상한을 보장하지 않습니다. 운영자가 호스트 볼륨 용량을 별도로 감시해야 합니다.
- Docker 관리자, 호스트 root, 커널 취약점, 악의적인 승인 LLM 백엔드까지 방어한다고 주장하지 않습니다. Compose 파일과 실제 `docker inspect` 검사 결과가 일치해야 합니다.
- MCP 클라이언트와 Claude Code 자체의 클라우드 모델 통신은 Pi 컨테이너 경계 **밖**입니다. MCP 결과를 클라우드 모델에 전달하면 데이터가 그쪽으로 전송될 수 있습니다. 회사 정책에 따라 클라이언트·모델을 별도로 통제하세요.
- 실제 회사 서비스에 대한 연결·인증·검색 차단은 회사 환경에서 별도로 수용 검사해야 합니다. 테스트는 가짜 사설 HTTPS 서비스만 사용합니다.
