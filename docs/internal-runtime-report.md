# 사내 격리 Pi 런타임 단위 보고 — 2026-10-23

## 범위와 상태

- 작업 worktree: `/Users/leebw/workspace/claude/pi-mcp-worktrees/internal-agent-runtime`, `codex/internal-agent/runtime`. 최초 베이스 `295c4af7ce8e525ecd32a5178fedfc788c05c734`; 부모가 gateway 의존 커밋을 반입한 뒤 검증한 HEAD는 `b48ba9d9b50b892f7f3d6078f0168a6bf5651214`입니다. 이 단위의 파일은 **미커밋**이며 부모가 검토·커밋합니다.
- agent 이미지에 Pi/MCP/Git·도구를 넣고 UID 1000, 네트워크 없음, 읽기 전용 root, 기본 seccomp/LSM, capability 0, no-new-privileges, 자원 제한을 적용했습니다. 저장소·상태는 서로 다른 Docker 이름 있는 전용 볼륨입니다. 호스트 저장소/상태/Home/Docker/SSH 소켓 디렉터리를 마운트하지 않습니다. gateway에는 별도 upstream 네트워크와 읽기/쓰기 소켓 볼륨, 개별 정규 파일 설정/CA, 전용 env 파일만 전달합니다.
- 설정 검사는 고정된 실행 경로·저장 경로·단일 provider/model·루프백 API·더미 키·빈 환경 허용 목록을 강제합니다. MCP 시작은 컨테이너 보안 상태, 실제 AF_VSOCK 거절, gateway 건강 확인 후에만 진행합니다. 호스트 preflight는 Compose 실행 **전** gateway env-file 이름을 검사합니다. [Compose 2.30 이상의 `env_file.format: raw`](https://docs.docker.com/reference/compose-file/services/#format)가 `$` 등이 들어간 헤더 비밀값을 변형하지 않습니다.
- 입력은 선택한 **커밋된 로컬 브랜치**의 Git bundle 표준입력만 수용하고 새 개인 볼륨 저장소에 가져옵니다. 훅과 fsmonitor를 끄고 선택 SHA를 재확인합니다. 중간 실패 시 새 목적지가 남을 수 있으므로 자동으로 덮어쓰지 않습니다.

## RED / GREEN 및 실제 검증

| 검사 | 명령/관찰 |
| --- | --- |
| RED | gram `docker run --rm --network none -v /tmp/pi-mcp-internal-20261023/runtime:/work:ro -w /work node:24.22.0-bookworm node --test test/internal-runtime.test.mjs` → `ERR_MODULE_NOT_FOUND` (`internal-agent/profile.mjs` 부재), exit 1. |
| GREEN | 같은 `node --test`를 구현 후 `/tmp/pi-mcp-internal-20261023/runtime/build` 소스에 실행 → **4/4 통과**, exit 0. |
| 이미지 | gram `BUILDX_CONFIG=/tmp/pi-mcp-internal-20261023/buildx docker build -f internal-agent/Dockerfile -t pi-internal-agent:runtime-20261023 .` → 성공. 최종 gateway 통합 이미지 manifest `sha256:1898c1585eca1e0be9669e3668bc618fd4c264b3d6f215e7ab8cd4d1e603b320`. |
| 개인 Git 반입 | 호스트 `git -C <worktree> -c core.hooksPath=/dev/null -c core.fsmonitor=false bundle create - refs/heads/codex/internal-agent/runtime`를 gram의 `docker compose exec -T agent node /app/internal-agent/import-bundle.mjs source-branch 667277847423abeb206b51801a569dac61f5ca07` 표준입력에 연결 → SHA 일치 새 `/workspace/source-branch` 반입 성공. 별도 one-shot named-volume 반입도 `295c4af7ce8e525ecd32a5178fedfc788c05c734`에서 성공. |
| 실제 Docker 경계 | `python3 scripts/check-internal-agent.py --project piinternalruntime20261023 --preflight-only`와 `python3 scripts/test-internal-agent.py --project piinternalruntime20261023 --compose internal-agent/compose.yaml --forbidden-ip 172.24.0.4 --forbidden-container piinternal-runtime-forbidden-20261023 --repository /workspace/source-branch --base-ref 667277847423abeb206b51801a569dac61f5ca07 --missing-gateway-test` → 모두 exit 0. 검사 결과: `sandbox=validated`, TCP/UDP/DNS 거절, 통제된 사설 금지 서비스 요청 수 **0**, AF_VSOCK 거절, Unix 소켓 연결 가능·unlink/rename 거절, 프록시 환경 override 거절. |
| 실제 Pi + MCP | 동일 harness: Pi 1.4.0 `read` tool → 가짜 사설 HTTPS 모델 2회 요청 → 완료; MCP 재연결 후 상태/결과 조회 완료, followup 완료, 즉시 취소 작업 `cancelled`, gateway 중지 시 새 MCP 시작 거절. 가짜 upstream 로그에는 `approved-model`, `read/grep/find/ls` 도구만 기록되고 헤더/본문/비밀값은 기록하지 않았습니다. 헤더의 리터럴 `$` 값은 `env_file.format: raw`를 통과한 뒤 mock의 정확한 값 검사에 합격했습니다. |
| TLS/리다이렉트 | 개인 Docker bridge의 테스트 전용 HTTPS gateway fixture: 유효한 CA **200**, CA 없음 **502**, 다른 TLS 호스트명 **502**, upstream 302 **502**; mock HTTP 요청 2회뿐이며 외부 redirect URL 요청 없음. fixture는 gateway별 새 Unix HTTP 연결(`agent:false`)을 사용합니다. |
| 재현 설정 생성기 | gram의 새 `piinternalrepro20261023` 작업 디렉터리·전용 Docker bridge/두 임시 컨테이너에서 `python3 scripts/setup-internal-agent-test.py --task piinternalrepro20261023` → exit 0. 동적 mock IP와 리터럴 `$` 값을 확인한 뒤 임시 컨테이너와 네트워크를 제거했습니다. |

이 결과는 gram Docker 29.6.2, Compose 5.3.1, Node 이미지 `24.22.0-bookworm`에서 관찰했습니다. 회사 LLM/자격 증명, 회사 네트워크, 서버 측 검색·외부 라우팅 정책은 아직 검증하지 않았습니다. 별도 회사 수용 검사가 필요합니다. 볼륨 디스크 사용량 상한은 이 Compose 파일이 보장하지 않습니다.

변경 파일: `README.md`, `.dockerignore`, `docs/internal-agent.md`, `docs/internal-runtime-report.md`, `internal-agent/{Dockerfile,agent-daemon.mjs,compose.yaml,config.example.json,gateway.example.json,import-bundle.mjs,mcp.mjs,models.example.json,probe-network.py,probe-socket.py,probe-vsock.py,profile.mjs,sandbox.mjs}`, `scripts/{check-internal-agent.py,import-internal-agent.py,setup-internal-agent-test.py,test-internal-agent.py}`, `test/internal-runtime.test.mjs`, `test/fixtures/{internal-capture-pi.mjs,internal-forbidden.mjs,internal-mock-https.mjs,internal-tls-negative.mjs}`. 재현 설정 생성기 자체는 위처럼 실행했고, 전체 재현 절차는 독립 검사자가 새 작업 이름으로 실행해야 합니다.

## 독립 재현 준비

아래 이름은 이 테스트가 소유한 예시입니다. 다른 검사자는 `TASK`, 이미지 태그, 네트워크/프로젝트/컨테이너 이름 및 원격 디렉터리를 새 고유값으로 바꾸세요. `WORKTREE`는 테스트할 **커밋된 통합 checkout**으로 지정하세요. 모든 빌드·서비스·테스트는 gram에서 실행합니다. source directory를 agent나 gateway에 마운트하지 않습니다.

```sh
WORKTREE=/absolute/path/to/reviewed-worktree
TASK=piinternal-runtime-repeat
ssh gram "mkdir -p /tmp/$TASK/build /tmp/$TASK/mock"
rsync -a --exclude=.git --exclude=node_modules "$WORKTREE/" "gram:/tmp/$TASK/build/"
ssh gram "docker network create --internal $TASK-net"
ssh gram "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout /tmp/$TASK/mock/key.pem -out /tmp/$TASK/mock/cert.pem -subj /CN=mock.corp.internal -addext subjectAltName=DNS:mock.corp.internal"
ssh gram "chmod 644 /tmp/$TASK/mock/key.pem"
scp "$WORKTREE/test/fixtures/internal-mock-https.mjs" "gram:/tmp/$TASK/mock/mock.mjs"
scp "$WORKTREE/test/fixtures/internal-forbidden.mjs" "gram:/tmp/$TASK/mock/forbidden.mjs"
scp "$WORKTREE/test/fixtures/internal-tls-negative.mjs" "gram:/tmp/$TASK/mock/internal-tls-negative.mjs"
ssh gram "docker run -d --rm --name $TASK-mock --network $TASK-net --mount type=bind,src=/tmp/$TASK/mock,dst=/fixture,readonly node:24.22.0-bookworm node /fixture/mock.mjs"
ssh gram "docker run -d --rm --name $TASK-forbidden --network $TASK-net --mount type=bind,src=/tmp/$TASK/mock/forbidden.mjs,dst=/fixture/forbidden.mjs,readonly node:24.22.0-bookworm node /fixture/forbidden.mjs"
ssh gram "docker inspect $TASK-mock --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'"
ssh gram "docker inspect $TASK-forbidden --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'"
ssh gram "cd /tmp/$TASK/build && BUILDX_CONFIG=/tmp/$TASK/buildx docker build -f internal-agent/Dockerfile -t pi-internal-agent:$TASK ."
ssh gram "python3 /tmp/$TASK/build/scripts/setup-internal-agent-test.py --task $TASK"
```

`setup-internal-agent-test.py`는 새 작업 디렉터리에만 example JSON, 동적 mock IP가 고정된 gateway JSON, 테스트 전용 `$` 포함 헤더 값, 0600 `gateway.env`와 `compose.env`를 생성하며 기존 파일을 덮어쓰지 않습니다. 실제 사내 값으로 재현하지 마세요. 파일을 확인한 후 아래 명령을 실행합니다.

```sh
ssh gram "cd /tmp/$TASK/build && set -a && . /tmp/$TASK/mock/compose.env && set +a && python3 scripts/check-internal-agent.py --project $TASK --preflight-only"
ssh gram "docker compose --env-file /tmp/$TASK/mock/compose.env -f /tmp/$TASK/build/internal-agent/compose.yaml -p $TASK up -d"
ssh gram "cd /tmp/$TASK/build && set -a && . /tmp/$TASK/mock/compose.env && set +a && python3 scripts/check-internal-agent.py --project $TASK"
```

호스트에서 선택한 커밋 브랜치를 bundle로 보내고, 반환된 SHA를 `--base-ref`로 넘깁니다. `scripts/import-internal-agent.py`는 Docker CLI가 설치된 **같은 호스트**에서 이 절차를 자동화합니다. 이 사례에서는 호스트 Mac에 Docker CLI를 사용하지 않아 표준입력 파이프를 SSH로 보냈습니다.

```sh
REF=codex/internal-agent/integration
COMMIT=$(git -C "$WORKTREE" rev-parse "refs/heads/$REF^{commit}")
set -o pipefail
git -C "$WORKTREE" -c core.hooksPath=/dev/null -c core.fsmonitor=false bundle create - "refs/heads/$REF" |
  ssh gram "docker compose --env-file /tmp/$TASK/mock/compose.env -f /tmp/$TASK/build/internal-agent/compose.yaml -p $TASK exec -T agent node /app/internal-agent/import-bundle.mjs private-source $COMMIT"
FORBIDDEN_IP=$(ssh gram "docker inspect $TASK-forbidden --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'")
ssh gram "cd /tmp/$TASK/build && set -a && . /tmp/$TASK/mock/compose.env && set +a && python3 scripts/test-internal-agent.py --project $TASK --compose /tmp/$TASK/build/internal-agent/compose.yaml --forbidden-ip $FORBIDDEN_IP --forbidden-container $TASK-forbidden --repository /workspace/private-source --base-ref $COMMIT --missing-gateway-test"
ssh gram "docker run --rm --network $TASK-net --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,nodev,size=32m,mode=1777 --mount type=bind,src=/tmp/$TASK/mock,dst=/fixture,readonly pi-internal-agent:$TASK node /fixture/internal-tls-negative.mjs"
```

검사가 끝나면 그 검사가 만든 Compose 프로젝트, 두 mock 컨테이너, 전용 Docker 네트워크와 이미지/볼륨만 확인한 뒤 정리하세요. `down -v`는 테스트 작업의 보존 결과를 확인한 뒤에만 실행합니다.
