# Claude Code에서 Pi MCP 사용하기

Claude Code에서 `pi-mcp`를 MCP 서버로 연결하면, Claude Code가 사내 LLM을 사용하는 Pi 에이전트에 코딩·검토 작업을 위임하고 결과 패치를 확인할 수 있습니다. Pi 서버는 작업 결과를 적용하거나 커밋하지 않습니다.

## 준비와 연결

호스트 실행 모드는 Linux 런타임, `/proc` 프로세스 정보, `flock`이 필요합니다. macOS에서 실행하는 Claude Code라면 별도 Linux 호스트나 내부 Docker 프로필을 사용하세요. 사내 격리 실행은 [내부 Docker 프로필 안내](internal-agent.md)를 먼저 구성해야 합니다.

CLI로 호스트 모드를 등록합니다. 경로는 실제 절대 경로로 바꾸세요.

```sh
claude mcp add --scope project --transport stdio --env PI_MCP_CONFIG=/abs/config.json pi -- node /abs/pi-mcp/src/server.mjs
```

프로젝트 `.mcp.json`을 직접 사용할 경우 [호스트 예시](../examples/claude-code/mcp.json)를 복사하고 `PI_MCP_HOME`, `PI_MCP_CONFIG`를 Claude Code가 실행되는 환경에 설정하세요. 내부 Docker 프로필은 [내부 예시](../examples/claude-code/mcp.internal.json)를 사용하고 `PI_INTERNAL_COMPOSE`, `PI_INTERNAL_PROJECT`를 제공합니다. 내부 프로필 MCP 환경에 호스트 비밀값이나 `PI_MCP_CONFIG`를 전달하지 마세요.

프로젝트 범위 설치는 예시 파일을 `.claude/agents/`와 `.claude/skills/`로 복사합니다. 사용자 범위 설치는 `~/.claude/agents/`와 `~/.claude/skills/`에 복사하세요. subagent 파일은 `pi-worker.md`, skill은 `pi-delegation/SKILL.md`입니다.

## 권한과 대기

읽기 전용 도구는 `pi_health`, `pi_capabilities`, `pi_status`, `pi_wait`, `pi_result`, `pi_events`, `pi_list`, `pi_artifacts`, `pi_read_artifact`입니다. `pi_patch`는 서버의 자체 캐시에 패치 파일만 씁니다. 위임·후속 작업·취소·조향·분기·검토·정리·복구 도구는 변경을 일으킬 수 있으므로 승인 프롬프트를 유지하세요. `pi_health`는 인증값의 존재만 확인하며 실제 제공자 인증을 시험하지 않습니다.

stdio MCP 호출에는 개별 요청 타이머가 없습니다. `MCP_TOOL_TIMEOUT` 기본값은 약 28시간이며, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`은 stdio에서 기본 30분입니다. 진행 알림은 활동으로 계산됩니다. Claude Code 주 대화에서 2분 넘게 실행되는 호출은 자동으로 백그라운드로 이동합니다. `pi_wait` 한 번의 대기는 최대 300초입니다.

출력이 25,000 토큰 또는 50,000자를 넘으면 파일로 저장되어 Claude가 필요할 때 읽습니다. 패치가 큰 경우 먼저 `pi_patch`에 `include_text: false`를 지정해 메타데이터를 확인한 뒤 페이지별로 읽으세요.

## 일반적인 작업 흐름

기준 SHA는 커밋된 SHA여야 합니다. 응답의 `baseCommit`이 요청한 SHA와 같은지 확인하세요.

```json
{"name":"pi_delegate","arguments":{"repository":"/work/project","title":"로그인 오류 수정","base_ref":"<committed-sha>","mode":"implement","prompt":"로그인 오류를 수정하고 아래 검증을 실행하세요.","verification_ids":["test-login"],"request_id":"login-fix-01"}}
```

응답의 ID를 사용해 완료까지 기다립니다.

```json
{"name":"pi_wait","arguments":{"job_ids":["task-00000000-0000-4000-8000-000000000000"],"wait_seconds":300,"until":"any"}}
```

완료 후 결과와 패치 정보를 읽습니다.

```json
{"name":"pi_result","arguments":{"job_id":"task-00000000-0000-4000-8000-000000000000"}}
{"name":"pi_patch","arguments":{"job_id":"task-00000000-0000-4000-8000-000000000000","include_text":false}}
```

`pi_patch`의 메타데이터에서 `applicable`, 누락 경로, `sha256`, 전체 크기를 확인하고 패치 텍스트 페이지를 모두 검토합니다. `applicable`은 `baseCommit` 기준 지원되는 내보낸 소스 변경의 완전하고 마스킹되지 않은 패치라는 뜻입니다. 대상 브랜치와의 호환성, 검증, 승인 또는 검토가 보장된다는 뜻은 아닙니다. 검토한 뒤 같은 호스트 프로필에서는 해당 기준점의 깨끗한 worktree에서 적용합니다.

```sh
git apply --check job.patch
git apply job.patch
```

독립 작업은 각각 위임한 다음, 정착한 ID를 다음 대기 요청에서 제거하면서 `until: "any"`로 기다릴 수 있습니다.

```json
{"name":"pi_wait","arguments":{"job_ids":["task-...-a","task-...-b"],"wait_seconds":300,"until":"any"}}
```

내부 프로필은 컨테이너의 패치 경로를 호스트에서 직접 읽을 수 없습니다. 패치를 표준 출력으로 내보내고 SHA-256을 확인하세요.

```sh
docker compose -f "$PI_INTERNAL_COMPOSE" -p "$PI_INTERNAL_PROJECT" exec -T agent node /app/internal-agent/export-patch.mjs <job-id> > job.patch
sha256sum job.patch
```

내보내기 명령이 표준 오류에 출력하는 `sha256`과 파일의 SHA-256이 같아야 합니다. 서버는 Pi 변경 사항을 커밋하지 않으며 자동 적용도 하지 않습니다. plugin 패키지는 제공하지 않습니다. plugin에서는 MCP 도구 이름이 달라지므로 이 agent 설정을 그대로 쓸 수 없습니다.
