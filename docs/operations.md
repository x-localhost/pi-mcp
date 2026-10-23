# pi-mcp 운영 안내

이 문서는 연결된 MCP 호스트에서 작업을 시작하고 결과를 검토하는 운영자용
참고입니다. `pi_delegate`는 비동기 작업이며, 커밋된 기준점에서 전용 Git
worktree를 만듭니다. 작업은 대기열에 들어갈 수 있고 실행·검증·최종화 상태를
각각 거칩니다. 설정된 Pi provider를 사용하므로 호출 전 `pi_health`로
상태와 인증 정보의 **존재 여부**를 확인하세요. 인증 성공까지 확인하는 도구는
아닙니다.

## 도구 호출 예시

아래 JSON은 MCP 클라이언트의 `tools/call`에 넣는 `name`과 `arguments` 예시입니다.
경로와 ID는 실제 승인된 저장소 또는 앞선 응답의 값을 사용하세요.

```json
{"name":"pi_health","arguments":{}}
```

작업을 시작합니다. `provider`와 `model`은 설정에 없을 때 둘 다 전달합니다.
`base_ref`는 생략하면 `HEAD`이며, 기준은 커밋이어야 합니다. 각 병렬 작업은
별도 호출로 시작해 서로 독립된 worktree를 받습니다.

```json
{"name":"pi_delegate","arguments":{"repository":"/work/project","title":"로그인 오류 분석","prompt":"원인을 조사하고 수정이 필요하면 변경하되 테스트 근거를 기록하세요.","base_ref":"main","mode":"implement","provider":"corp","model":"code-model","thinking_level":"medium","timeout_seconds":1800,"max_turns":30,"request_id":"login-investigation-2026-10-23"}}
```

`request_id`는 호출자가 정하는 1–100자 키입니다. 같은 키와 같은 입력으로
재시도하면 기존 작업을 돌려줍니다. 같은 키에 입력을 바꾸면 오류가 납니다.
응답을 받지 못해 재시도할 때는 **동일한 입력과 request_id**를 재사용하세요.

응답의 `id`를 `job_id`로 사용해 상태를 확인합니다. 대기는 최대 45초입니다.

```json
{"name":"pi_status","arguments":{"job_id":"task-00000000-0000-4000-8000-000000000000","wait_seconds":20}}
```

결과에는 요약, 오류 및 제한된 diff 미리보기가 있습니다. 변경·신규 파일의
적격 내용은 별도 아티팩트 API에서 페이지와 해시로 확인할 수 있습니다.
누락·마스킹·크기 제한 표시를 확인하고, 필요하면 보존된 worktree도 검토하세요.

```json
{"name":"pi_result","arguments":{"job_id":"task-00000000-0000-4000-8000-000000000000"}}
```

최근 작업 목록은 모든 MCP 연결의 작업을 포함합니다.

```json
{"name":"pi_list","arguments":{"limit":10}}
```

취소는 요청이며 진행 중인 작업의 worktree와 산출물을 보존합니다. 완료 여부는
다시 `pi_status`로 확인하세요.

```json
{"name":"pi_cancel","arguments":{"job_id":"task-00000000-0000-4000-8000-000000000000"}}
```

종료된 작업에 후속 지시를 보낼 수 있습니다. 후속 작업은 같은 worktree와 Pi
세션을 이어 씁니다. 원래 작업의 제목, 기준 커밋, 모드, provider/model 및
thinking 설정을 유지합니다. 최초 시도가 Pi 세션 파일을 기록하기 전에
실패했다면 유효한 동일 worktree에서 새 세션으로 시작할 수 있습니다. 세션이
기록된 뒤 파일이 사라졌거나 세션 경로 검증에 실패하면 후속 작업은 거부됩니다.

```json
{"name":"pi_followup","arguments":{"job_id":"task-00000000-0000-4000-8000-000000000000","prompt":"이 오류를 반영해 수정하고 관련 동작을 확인하세요.","request_id":"login-followup-1","timeout_seconds":900,"max_turns":12}}
```

`pi_delegate`의 `mode`는 `implement` 또는 `review`입니다. followup은 부모의
모드를 상속하므로 review 작업을 구현 작업으로 바꾸는 용도로 쓰지 마세요.
별도 delegate 작업은 자체 작업 디렉터리와 세션을 가집니다. 여러 작업을 별도 delegate
호출로 시작할 수 있지만, 동일 worktree를 동시에 수정하는 방식으로 작업을
공유하지 마세요. 완료 결과를 검토한 뒤에만 저장소에 통합하세요.

이 문서의 JSON은 기본 위임 흐름 예시입니다. 이벤트·steer·fork·검증·아티팩트·
복구·정리 API의 최종 입력 형식은 [런타임 가이드](completion-runtime.md)를
참고하세요. 승인된 외부 자료와 산출물의 범위는 [오프라인 자료·아티팩트 가이드](offline-artifacts.md),
명시적으로 허용한 MCP 도구의 설정과 한계는 [승인 MCP 가이드](approved-mcp.md)에 있습니다.

## 인증과 비공개 데이터

OAuth를 쓴다면 pi-mcp 전용 로그인 세션을 독점 사용하세요. 일반 Pi와 refresh
token을 공유하면 한쪽의 갱신이 다른 세션을 무효화할 수 있습니다. 게이트웨이
API 키는 승인된 비밀 주입 또는 환경변수 방식으로 전달하고 설정 파일이나 MCP
등록 파일에 값 자체를 기록하지 마세요.

세션, 작업 로그와 결과에는 비공개 프롬프트 및 코드가 포함될 수 있습니다.
상태 디렉터리의 접근을 운영자에게만 제한하고, 원시 세션 파일이나 로그를
일반 채널에 복사하지 마세요. 결과 도구는 제한된 내용을 반환하며 비밀을
마스킹하지만, 비공개 업무 데이터를 공개해도 된다는 뜻은 아닙니다.

## 모델 설정 갱신과 격리된 작업

pi-mcp는 시작 시 설정된 `modelsFile`을 비공개 상태 디렉터리의
`agent/models.json`으로 복사합니다. 기존 복사본과 원본이 달라지면 자동
덮어쓰지 않고 운영자 초기화를 요구합니다. 갱신은 모든 작업 worker가
종료되어 실행 중 또는 격리 상태(quarantined)가 없음을 확인한 뒤에만
진행하세요. 기존 상태 디렉터리와 모델 파일을 비공개 백업하고, 관리자가
검토한 명시적 `modelsFile` 내용으로 해당 상태 디렉터리의
`agent/models.json`만 통제된 절차로 교체합니다. `agent/auth.json`과 OAuth
자격증명은 보존하고 모델 파일로 덮어쓰지 마세요. 전용 자동 reset 도구는
없습니다.

격리 상태는 worker나 Pi 프로세스 그룹의 소유·종료 여부를 안전하게 확인할 수
없다는 뜻입니다. 복구 API는 Linux boot ID, PID namespace, 프로세스 시작 시각
등의 소유 증거가 맞을 때만 진행하며, 모호하면 격리 상태를 유지합니다. 숫자
PID만 보고 신호를 보내지 마세요. 정리 API는 기본적으로 미리보기이며, 활성
작업·참조 중인 작업과 원본 저장소를 보호합니다. 격리 중에는 작업이 동시성
용량을 차지할 수 있습니다. 세부 절차는 [런타임 가이드](completion-runtime.md)를
따르세요.

새 런타임은 `/usr/bin/flock`과 프로세스 신원을 확인할 수 있는 `/proc`가 있는
Linux가 필요합니다. Mac의 MCP 클라이언트에서는 격리 Docker 실행을 권장합니다.
업그레이드 전 기존 worker를 모두 중지하세요. 이전·새 잠금 구현을 섞어
rolling upgrade하지 마세요.

회사 프록시, CA 또는 게이트웨이 연결은 각 환경에서 별도로 확인해야 합니다.
자동화 테스트의 로컬 mock 사용은 실제 회사 endpoint나 자격증명 검증을
의미하지 않습니다. 사용자별 OS 격리 역시 별도 과제입니다. 설치 및 네트워크 설정은 [사내 환경 설치 가이드](corporate-setup.md)를
참고하세요.
