# cursorAutoWork

> ## ⚠️ 테스트 버전 (Experimental / Test Release)
>
> **이 프로젝트는 실험용 테스트 버전입니다. 프로덕션 환경에서 사용하지 마세요.**
>
> - 실제 운영 중인 프로젝트나 백업이 없는 코드베이스를 대상으로 실행하지 마세요.
> - 기본값은 `CURSOR_YOLO=true`, `AUTO_COMMIT=false`, `VALIDATION_MODE=compile` 입니다. `compile` 은 열린 Unity Editor + UnityMCP 가 필요합니다. 자동 커밋은 `.env` 에서 **명시적으로** 켜야 합니다. YOLO 를 끄려면 `CURSOR_YOLO=false`.
> - 검수 파이프라인(컴파일/테스트/Diff)은 아직 충분히 검증되지 않았고, 잘못된 변경을 통과시킬 수 있습니다.
> - CLI 옵션, 환경 변수, `roadmap.json` 스키마는 예고 없이 변경될 수 있습니다.
> - 반드시 **Git으로 관리되는 사본**에서 실행하세요. 기본으로 `auto-work/<시각>` 작업 브랜치를 만듭니다 (`CREATE_WORK_BRANCH`).
>
> 사용에 따른 코드 손실이나 예기치 않은 변경에 대한 책임은 사용자에게 있습니다.

Unity 프로젝트를 대상으로 **Cursor CLI(`agent`)를 무인 제어**하는 Node.js(TypeScript) 오케스트레이터입니다.

대상 프로젝트의 기획서(`docs/spec.md`)와 로드맵(`docs/roadmap.json`)을 읽어 Step을 순서대로 지시합니다.
Agent가 끝나면 **추론 Verify → delta 린트 → (compile/full) Editor 컴파일 → (full+runTests) EditMode 테스트 → 완료 조건 판정**을 모두 통과해야 다음 Step으로 갑니다.
실패하면 피드백을 넣고 같은 세션을 resume 해 재시도하고, 한도를 넘기면 이번 Step 변경만 롤백한 뒤 Discord로 사람 개입을 요청합니다.

```
┌─────────────┐   프롬프트    ┌──────────────┐   파일/에디터 조작   ┌──────────────┐
│ Orchestrator│ ───────────▶ │    agent     │ ──────────────────▶ │ Unity Project│
│  (이 저장소) │ ◀─────────── │ (+ UnityMCP) │                     └──────┬───────┘
└──────┬──────┘  NDJSON 스트림 └──────────────┘                            │
       │                                                                   ▼
       │  ① 추론 Verify  ② delta 린트  ③ Editor 컴파일  ④ 테스트  ⑤ 판정  ◀─┘
       │
       ├─ 통과 → (선택) git commit → 다음 Step (새 세션)
       └─ 실패 → 피드백 + 세션 resume (최대 N회) → 초과 시 롤백 + Discord 🚨
```

이 저장소의 `docs/` 는 **작성 예시**입니다. 실제 작업 대상은 항상 `TARGET_PROJECT_PATH` 의 Unity 프로젝트입니다.

---

## 1. 요구 사항

| 항목 | 버전/비고 |
| --- | --- |
| Node.js | 18 이상 (권장 20 LTS) |
| Git | `lint`/`compile`/`full` 검수 및 자동 커밋 시 필수 |
| Unity Editor | `compile`/`full`(기본 `mcp`) 동안 **켜 둘 것**. 인스턴스가 없고 `UNITY_PATH` 가 있으면 자동 기동 |
| UnityMCP | Cursor `mcp.json` 에 등록. `tools/list` 로 `refresh`/`read_console` 별칭을 찾음 |
| `agent` | [Cursor CLI](https://cursor.com/docs/cli/overview). `agent --version` 으로 확인 |

> `agent` CLI 는 별도 설치가 필요합니다 ([Installation](https://cursor.com/docs/cli/installation)). Windows 예: `irm 'https://cursor.com/install?win32=true' | iex`  
> 비대화형 실행을 위해 [Authentication](https://cursor.com/docs/cli/reference/authentication) (`CURSOR_API_KEY` 또는 로그인)을 완료해 두어야 합니다. `doctor` 는 `status`/`whoami` 로 인증을 추가로 봅니다.

---

## 2. 설치

```powershell
cd D:\cursorAutoWork
npm install
npm run build
npm test
```

`npm test` 는 Unity Editor 없이 파서·git 스냅샷·추론 Verify·락 등 단위 테스트를 돌립니다.

---

## 3. 설정

`.env.example` 을 복사해 `.env` 를 만들고 값을 채웁니다.

```powershell
Copy-Item .env.example .env
```

최소한 `TARGET_PROJECT_PATH` 는 반드시 지정해야 합니다. `compile`/`full` 은 기본으로 **열린 Unity Editor + UnityMCP** 로 검수합니다. 에디터가 꺼져 있으면 `UNITY_PATH` 로 띄운 뒤 기다립니다. `UNITY_PATH` 가 **필수인 경우**는 `UNITY_VALIDATION_BACKEND=batch` 이거나, 자동 기동을 쓸 때뿐입니다.

```dotenv
TARGET_PROJECT_PATH=D:\UnityProjects\MyGame
# 자동 기동 또는 batch 채널에 사용
UNITY_PATH=C:\Program Files\Unity\Hub\Editor\2022.3.40f1\Editor\Unity.exe
```

주요 환경 변수:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TARGET_PROJECT_PATH` | `process.cwd()` | 작업 대상 Unity 프로젝트 루트 |
| `UNITY_PATH` | (없음) | Unity.exe. 자동 기동 또는 `batch` 채널에 사용 |
| `UNITY_VALIDATION_BACKEND` | `mcp` | `mcp`: 열린 에디터에 UnityMCP로 컴파일/테스트. `batch`: `-batchmode -quit` (에디터·MCP 끊김) |
| `UNITY_LAUNCH_EDITOR` | `true` | 인스턴스가 없으면 `UNITY_PATH` 로 에디터를 띄움 |
| `UNITY_LAUNCH_TIMEOUT_MS` | `180000` | 에디터 기동/접속 대기 (3분) |
| `UNITY_STOP_PLAY_MODE` | `true` | 검수 전 Play Mode 중지. `false` 이면 재생 중일 때 검수 실패 |
| `UNITY_RESTORE_PLAY_MODE` | `true` | 검수 후 원래 Play Mode 복구 |
| `CURSOR_AGENT_BIN` | `agent` | Cursor CLI 실행 명령 |
| `CURSOR_MODEL` | (CLI 기본값) | 메인 Agent가 사용할 모델 |
| `CURSOR_YOLO` | `true` | `--force` 를 붙여 MCP 도구 호출/파일 쓰기를 자동 승인. 끄려면 `false` |
| `CURSOR_PROMPT_DELIVERY` | `auto` | 프롬프트 전달 방식: `auto` / `argv` / `stdin` / `file` ([4-4](#4-4-프롬프트-전달-방식)) |
| `DISCORD_WEBHOOK_URL` | (없음) | 미설정 시 알림은 콘솔에만 출력 |
| `SPEC_PATH` / `ROADMAP_PATH` | `./docs/*` | **대상 프로젝트 기준** 상대경로 |
| `STATE_PATH` | `./runtime/state.json` | 진행 상태 저장 위치 |
| `RUNTIME_DIR` | `./runtime` | 락·로그·프롬프트 파일 디렉터리 |
| `MAX_RETRIES` | `3` | Step 당 최대 재시도 |
| `AGENT_TIMEOUT_MS` | `1800000` | Agent 1회 실행 타임아웃 (30분) |
| `UNITY_TIMEOUT_MS` | `1200000` | Unity MCP 대기/배치모드 타임아웃 (20분) |
| `VALIDATION_MODE` | `compile` | 검수 프리셋: `lint` / `compile` / `full` / `skip` ([6-2](#6-2-검수-파이프라인)) |
| `INFER_VERIFY` | `true` | `targetFiles`/완료 조건에서 파일·내용·프리팹·Addressables 검사 추론. 로드맵 JSON은 수정하지 않음 |
| `STEP_JUDGE` | `true` | 기계 체크·컴파일 후 완료 조건 판정 Agent. `--force` 없이 실행 |
| `JUDGE_TIMEOUT_MS` | `180000` | 판정 Agent 타임아웃 (3분) |
| `RESUME_ON_RETRY` | `true` | 검수 실패 재시도 시 직전 Agent 세션 `--resume` |
| `ROLLBACK_ON_FAIL` | `true` | 재시도 한도 초과 시 이번 Step delta 만 되돌림 (시작 당시 dirty 는 유지) |
| `CREATE_WORK_BRANCH` | `true` | `run` 시작 시 `auto-work/<시각>` 브랜치 생성 (이미 `auto-work/*` 이면 유지) |
| `RULES_MAX_CHARS` | `40000` | `.cursorrules` 등 규칙 예산. 초과 시 중간 생략 + 경고 |
| `SPEC_MAX_CHARS` | `20000` | 기획서 예산. 초과 시 중간 생략 + 경고 |
| `AUTO_COMMIT` | `false` | 검수 통과 시 자동 커밋. 시작 당시 dirty 파일은 add 하지 않음 |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | (없음) | 자동 커밋 작성자 (미설정 시 로컬 git config) |
| `MAX_ERROR_LINES` | `30` | 컴파일 실패 피드백에 포함할 에러 최대 줄 수 |
| `LOG_LEVEL` | `info` | `debug` 로 하면 Agent 스트림 원문까지 출력 |

---

## 4. 대상 프로젝트 준비

### 4-1. 기획서 / 로드맵 생성

```powershell
node dist/index.js init --project D:\UnityProjects\MyGame
```

`docs/spec.md` 와 `docs/roadmap.json` 템플릿이 대상 프로젝트에 생성됩니다.
이 저장소의 `docs/` 에는 작성 예시(2D 로그라이크)가 있습니다. **샘플에는 `verify` 가 없습니다.** 검수는 `targetFiles` 와 `acceptanceCriteria` 에서 추론합니다.

`roadmap.json` 의 Step 스키마:

```json
{
  "id": 1,
  "title": "프로젝트 기반 구조 설정",
  "task": "Agent 에게 전달할 구체적인 작업 지시문",
  "acceptanceCriteria": ["완료 조건 1", "완료 조건 2"],
  "targetFiles": ["Assets/Scripts/Core"],
  "runTests": false,
  "commitMessage": "feat: custom commit subject"
}
```

`task` 만 필수이고 나머지는 선택입니다. 일상적으로는 **`verify` 블록을 쓰지 않아도 됩니다.** 추론으로 안 잡히는 예외만 `verify.checks` 로 덮어쓸 수 있습니다. `runTests: true` 는 **`VALIDATION_MODE=full` 일 때만** 해당 Step에서 EditMode 테스트를 실행합니다.

### 4-2. `.cursorrules` 와 UnityMCP

- 대상 프로젝트 루트의 `.cursorrules`, `.cursor/rules/*.mdc`, `AGENTS.md` 는 **매 CLI 실행마다 프롬프트 최상단 System Context로 주입**됩니다. C# 스타일, UniTask/Addressables 사용 원칙, MVP 패턴 강제 등을 여기에 작성하세요. 기본 예산은 40,000자입니다.
- UnityMCP가 등록되어 있으면 자동 감지되어, Agent에게 "Editor 조작이 필요하면 MCP 도구를 직접 호출하라"는 지침이 함께 주입됩니다. 도구 호출 승인은 `CURSOR_YOLO=true`(`--force`)로 자동 처리됩니다.
- 오케스트레이터의 컴파일 검수도 같은 UnityMCP에 붙습니다. `tools/list` 에서 `refresh_unity` / `read_console` 등의 별칭을 고르고, 필수 도구가 없으면 사용 가능 목록과 함께 실패합니다.
- MCP 설정은 Cursor와 동일하게 전역 `~/.cursor/mcp.json` 과 프로젝트 `.cursor/mcp.json` 을 병합해서 읽습니다. 같은 이름이 양쪽에 있으면 프로젝트 설정이 우선합니다.

### 4-3. MCP가 실제로 살아 있는지 확인하기

`doctor` 는 설정 파일에 이름이 적혀 있는지만 보지 않고, 등록된 모든 MCP 서버에 **직접 접속해 JSON-RPC `initialize` → `tools/list` 핸드셰이크를 수행**합니다. HTTP(Streamable HTTP/SSE)와 stdio 두 방식 모두 지원합니다. `agent --version` 과 `status`/`whoami` 인증도 봅니다.

```powershell
node dist/index.js doctor
```

```
=== MCP 연결 점검 (initialize + tools/list 실제 호출) ===
  [ OK ] unityMCP (global, http) - mcp-for-unity-server 3.4.5 · 도구 48개 · 47ms
         Unity 인스턴스: AutoRpg@30a4666de7d51ef1
  [ OK ] mcp-gsheets (global, stdio) - spreadsheet 1.8.0 · 도구 44개 · 2406ms
```

- `[ OK ]` 는 서버가 지금 응답하고 있고 도구 목록까지 받아왔다는 뜻입니다.
- UnityMCP는 서버가 떠 있어도 Unity Editor가 붙어 있지 않으면 도구 호출이 실패하므로, `mcpforunity://instances` 리소스를 추가로 읽어 **연결된 Editor 인스턴스**까지 표시합니다.
- `run` 은 같은 MCP 점검을 한 뒤, `compile`/`full`(mcp) 이면 **에디터 게이트를 통과해야 Agent를 시작합니다.** UnityMCP 무응답·인스턴스 없음은 fatal 입니다. `--no-mcp-probe` 는 목록 점검만 건너뛰며, 에디터 게이트는 건너뛰지 않습니다.
- 대기 시간을 늘리려면 `--mcp-timeout <ms>` 를 사용하세요 (stdio 서버는 최초 `npx` 다운로드 때문에 느릴 수 있습니다).

### 4-4. 프롬프트 전달 방식

Windows에서 `agent` CLI 는 `.cmd` / `.ps1` 런처로 배포되어 셸(`cmd.exe`)을 경유해 실행됩니다. `cmd.exe` 명령행에는 두 가지 제약이 있습니다.

- 전체 명령행이 **8191자**를 넘으면 `명령줄이 너무 깁니다.` 로 즉시 실패합니다.
- 따옴표 안이라도 **줄바꿈은 명령 구분자**로 처리되어, 여러 줄 프롬프트는 첫 줄만 전달됩니다.

기획서와 규칙이 주입된 Step 프롬프트는 보통 2만 자가 넘고 당연히 여러 줄이므로, 기본값 `auto` 는 이런 경우 프롬프트를 **stdin으로 전달**합니다.

| 값 | 동작 |
| --- | --- |
| `auto` | 명령행에 안전하게 실릴 때만 인자로, 그 외에는 stdin으로 전달 (기본값) |
| `argv` | 항상 명령행 인자로 전달 |
| `stdin` | 항상 표준 입력으로 전달 |
| `file` | 프롬프트를 `runtime/prompts/` 에 저장하고 그 경로를 읽으라고 지시. 최근 3개만 유지 |

`auto` 에서 stdin 전달이 실패하면 자동으로 `file` 방식으로 한 번 더 시도합니다. CLI 버전에 따라 stdin을 받지 못한다면 `CURSOR_PROMPT_DELIVERY=file` 로 고정하세요.

---

## 5. 실행

```powershell
# 환경 점검 (Unity, CLI, 인증, 규칙, 웹훅 + MCP 서버 실제 접속 확인)
node dist/index.js doctor

# 파이프라인 실행 (완료되지 않은 Step부터 이어서)
node dist/index.js run

# 옵션을 명령 앞에 둬도 됩니다
node dist/index.js --project D:\UnityProjects\MyGame run

# Step 3부터 5까지만 실행 (전체 완료로 표시되지 않음 — 아래 6-5 참고)
node dist/index.js run --from 3 --to 5

# 이미 완료된 Step 을 다시 실행
node dist/index.js run --from 3 --force-rerun

# Agent를 실행하지 않고 조립된 프롬프트만 확인 (state.json 변경 없음)
node dist/index.js preview-prompt --to 1

# 진행 상황 확인 ([x] 완료 / [>] 진행 중 / [~] 일시 중지 / [ ] 대기)
node dist/index.js status
```

CLI 옵션:

| 옵션 | 설명 |
| --- | --- |
| `--project <path>` | `TARGET_PROJECT_PATH` 덮어쓰기 |
| `--from <n>` / `--to <n>` | 실행 범위 지정. 완료 Step 은 건너뜀 |
| `--force-rerun` | 완료된 Step 도 다시 실행. 이 경우 변경 없음 검사를 완화 |
| `--retries <n>` | 재시도 한도 덮어쓰기 |
| `--validation <mode>` | `lint` / `compile` / `full` / `skip` (`VALIDATION_MODE` 덮어쓰기) |
| `--no-commit` | 자동 커밋 비활성화 |
| `--debug` | Agent 스트림 원문까지 출력 |
| `--no-mcp-probe` | MCP 서버 목록 점검 생략 (`doctor`, `run`). 에디터 게이트는 유지 |
| `--mcp-timeout <ms>` | MCP 응답 대기 시간 (기본 20000) |
| `--no-infer-verify` | `targetFiles`/완료 조건에서 verify 추론 끄기 |
| `--no-judge` | 완료 조건 판정 Agent 끄기 |
| `--no-launch-editor` | 에디터 자동 기동 끄기 |
| `--no-resume` | 재시도 시 세션 resume 끄기 |

명령은 `--project D:\Game run` 처럼 옵션 뒤에 와도 됩니다.

같은 대상 프로젝트에 `run` 이 이미 있으면 `runtime/run.lock` 으로 거절합니다. 프로세스가 죽었으면 락을 회수합니다.

`Ctrl+C` 를 누르면 실행 중인 Agent 프로세스 트리와 검수 MCP 연결을 **즉시** 끊고, `runtime/state.json` 을 `status: "paused"` 로 남긴 뒤 종료합니다. Unity Editor 는 끄지 않습니다. 한 번 더 `Ctrl+C` 를 누르면 프로세스 자체를 강제 종료합니다 (`exit 130`). 다음 `run` 에서 이어서 진행됩니다.

개발 중에는 빌드 없이 실행할 수도 있습니다.

```powershell
npx tsx src/index.ts preview-prompt --to 1
```

---

## 6. 동작 방식

### 6-1. Fresh Context 메모리 관리

세션이 길어질수록 성능이 떨어지는 문제를 피하기 위해, **매 Step은 새 세션**으로 시작합니다.
검수 실패 재시도는 기본으로 **직전 세션을 resume** 하고 피드백을 넣습니다 (`RESUME_ON_RETRY=false` 또는 `--no-resume` 으로 끌 수 있음).

이전 대화 전체를 넘기는 대신 다음만 압축해서 최상단에 주입합니다.

1. `.cursorrules` / `.cursor/rules` / `AGENTS.md` (System Context, 기본 40,000자. 초과 시 중간 생략 + 경고)
2. 감지된 MCP 서버 목록(전역 + 프로젝트)과 자율 조작 지침
3. `state.json` 의 현재 진행 상태 (완료 Step, 시도 횟수)
4. 최근 5개 Step의 핵심 요약과 변경 파일 (`SUMMARY`/`FILES`/`NEXT` 규약 우선, 없으면 한/영 키워드)
5. 기획서 (기본 20,000자. 초과 시 중간 생략 + 경고)
6. 현재 Task와 완료 조건, 추론된 Verify 항목
7. 재시도인 경우 직전 **검수 실패·Agent 실행 실패·커밋 실패** 피드백

Agent CLI 가 비정상 종료(exit ≠ 0, 타임아웃)한 경우에도 출력 요약을 메모리에 남겨, 다음 시도 프롬프트에 반영합니다.
스트림에 토큰 usage가 있으면 `state.usage` 에 합산하고, 파이프라인 종료 시 로그와 Discord에 남깁니다.

### 6-2. 검수 파이프라인 (`VALIDATION_MODE`)

검수는 **Git index 를 수정하지 않고** 워킹 트리 diff + untracked 파일 직접 읽기로 수행합니다.
`skip` 이 아니면 Agent가 끝난 뒤 아래 순서이며, **앞에서 실패하면 Unity 검수를 띄우지 않습니다.**

| 모드 | 실행 내용 | Unity 프로세스 |
| --- | --- | --- |
| `lint` | 추론/명시 Verify + 이번 Step delta 린트 + (기본) 판정 | 없음 |
| `compile` (기본) | lint + 열린 Editor(MCP) 컴파일 + 판정 | 새 프로세스 없음 (에디터 유지) |
| `full` | lint + 에디터 컴파일 + EditMode 테스트 (`step.runTests=true` 일 때) + 판정 | 새 프로세스 없음 |
| `skip` | diff 수집만, 실패 없음 | 없음 |

모드별 실패 조건 (`skip` 제외):

| 단계 | 내용 | 실패 시 |
| --- | --- | --- |
| 추론 Verify | `targetFiles`·완료 조건 문장에서 파일/내용·프리팹 YAML·Addressables 등록을 추론. `verify.checks` 는 선택(덮어쓰기). 계약이 비면 실패 | 파일/심볼 없음, 빈 프리팹, 미등록 주소, 빈 계약, 주석/`using` 만의 변경 |
| Git Diff 린트 | tracked `git diff HEAD` + untracked 텍스트 파일 본문 검사. `Debug.Log` / `TODO` / 충돌 마커 등. `.png`·`.fbx` 등 바이너리·에셋은 생략 | 컨벤션 위반 |
| Unity 컴파일 | `compile`/`full` — UnityMCP `refresh` + 콘솔 `error CS####` (에디터를 끄지 않음). Play Mode 는 잠시 끄고 끝나면 복구 | 에러 상위 N개를 피드백에 포함 |
| EditMode 테스트 | `full` + `runTests: true` — UnityMCP `run_tests` / `get_test_job` (batch 채널은 NUnit XML) | 실패 테스트명·메시지를 피드백에 포함 |
| 완료 조건 판정 | 앞 단계 통과 후 읽기 전용 Agent가 조건마다 `evidence`(파일 경로)를 붙여 판정. 항목 수 불일치·근거 없는 ok는 실패 | `reasons`를 재시도 피드백에 포함 |

`lint`/`compile`/`full` 은 **Git 저장소가 필수**입니다. `compile`/`full`(mcp) 은 **run 시작 전에** UnityMCP 연결과 Editor 인스턴스를 확인합니다. 없으면 Agent를 시작하지 않습니다. `UNITY_PATH` 가 있으면 에디터를 띄운 뒤 대기합니다 (`UNITY_LAUNCH_EDITOR`).

기존 `.gitignore` 가 있으면 빠진 Unity 규칙(`Library/`, `Temp/` 등)만 덧붙입니다. `Library/` 와 `[Ll]ibrary/` 는 같은 것으로 봅니다.

검수를 모두 통과하면 자동 커밋(`AUTO_COMMIT=true`) 시 **이번 Step에서 새로 더러워진 파일만** `git add` 합니다. Step 시작 전에 이미 dirty였던 파일은 통째로 커밋하지 않습니다. 재시도 한도를 넘기면 그 Step이 만든 변경만 롤백하고, 시작 당시 dirty는 남깁니다.

`AUTO_COMMIT=true` 인데 커밋이 실패하면 Step 을 완료 처리하지 않고, 검수 실패와 동일하게 피드백을 주입해 재시도합니다.

### 6-3. 검수 건너뛰기

```dotenv
VALIDATION_MODE=skip
```

```powershell
node dist/index.js run --validation skip
```

켜져 있으면 lint/컴파일/테스트/판정을 생략하고 Agent 실행 직후 Step을 통과 처리합니다.

- 커밋 메시지용 변경 파일 **수집**은 유지하지만, 변경 없음·린트 위반으로 실패시키지 않습니다.
- Agent 프로세스 자체가 실패한 경우에만 재시도합니다.
- `AUTO_COMMIT=true` 이면 검증되지 않은 코드가 커밋될 수 있으며, 커밋 본문에 `NOTE: validation skipped (VALIDATION_MODE=skip).` 가 기록됩니다.

문제를 해결한 뒤에는 `VALIDATION_MODE=compile`(또는 `lint`/`full`) 로 되돌리는 것을 권장합니다.

### 6-4. Discord 알림

| 이벤트 | 색상 |
| --- | --- |
| 🚀 Step 시작 | 블루 |
| 🎮 검수 진행 중 | 퍼플 |
| ✅ Step 성공 및 (선택) 커밋 완료 | 그린 |
| ⚠️ 검수 실패 및 재수정 지시 | 옐로 |
| 🚨 최대 재시도 초과 (사람 개입 요청) | 레드 |

파이프라인 전체 완료 알림에는 토큰 합계(스트림에 usage가 있을 때)가 포함됩니다.
웹훅 전송 실패는 로그만 남기고 파이프라인을 중단시키지 않습니다.

### 6-5. 진행 상태 (`state.json`) 및 재시도

`runtime/state.json` 의 주요 `status` 값:

| status | 의미 |
| --- | --- |
| `idle` | 대기 또는 부분 실행 범위만 완료 |
| `in_progress` | Step 실행 중 |
| `paused` | `Ctrl+C` 등으로 중단 — `currentStepId` 유지, 다음 `run` 에서 이어서 진행 |
| `completed` | 마지막 Step 하나가 방금 끝남 (다음 Step 시작 전 transient) |
| `needs_human` | 재시도 한도 초과 — 이번 Step delta 롤백 후 수동 확인 |
| `all_completed` | 로드맵 **전체** Step 이 `completedSteps` 에 포함됨 |

완료된 Step 의 `attempts` 는 지워집니다. `workBranch` 와 `usage`(토큰 합계)도 함께 저장됩니다.

**부분 실행 (`--from` / `--to`)**  
지정 범위의 Step 만 끝내도 `all_completed` 로 표시되지 않습니다. 로드맵 전 Step 이 완료될 때만 `all_completed` 및 파이프라인 완료 Discord 알림이 발생합니다.

**재시도가 발생하는 경우** (최대 `MAX_RETRIES` 회):

- Agent CLI 비정상 종료·타임아웃
- 검수 실패 (변경 없음, 린트 위반, Verify/컴파일/테스트/판정 실패)
- `AUTO_COMMIT=true` 인데 git commit 실패

---

## 7. 프로젝트 구조

```
cursorAutoWork/
├─ src/
│  ├─ index.ts              # CLI (run / preview-prompt / init / status / doctor)
│  ├─ cliArgs.ts            # 명령·플래그 파서 (옵션 뒤 명령 허용)
│  ├─ orchestrator.ts       # 제어 루프, 재시도, resume, 롤백, 커밋 범위
│  ├─ cursorRunner.ts       # agent spawn, NDJSON, 규칙 수집, 인증 probe
│  ├─ mcpProbe.ts           # mcp.json 병합, 라이브 핸드셰이크
│  ├─ editorGate.ts         # run 전 Editor/UnityMCP 게이트, 자동 기동
│  ├─ unityMcp.ts           # 열린 에디터 세션, Play 중지/복구, 도구 호출
│  ├─ unityTools.ts         # UnityMCP 도구 별칭
│  ├─ unityValidator.ts     # MCP/배치 컴파일·테스트, CS/NUnit 파싱
│  ├─ unityAssetInspect.ts  # 프리팹 YAML · Addressables 디스크 검사
│  ├─ inferVerify.ts        # targetFiles/완료 조건에서 체크 추론
│  ├─ stepVerifier.ts       # 디스크 Verify 실행
│  ├─ stepJudge.ts          # 완료 조건 판정 Agent
│  ├─ gitManager.ts         # 스냅샷, scoped lint, gitignore 보완, 커밋/롤백
│  ├─ runLock.ts            # runtime/run.lock
│  ├─ memoryManager.ts      # Fresh Context, SUMMARY 파싱, state.json
│  ├─ textBudget.ts         # 규칙/기획서 중간 생략
│  ├─ notifier.ts           # Discord Webhook
│  ├─ roadmap.ts            # roadmap.json 스키마
│  ├─ config.ts             # 환경 변수
│  ├─ processKill.ts        # Ctrl+C 시 프로세스 트리 종료
│  ├─ encoding.ts           # 콘솔 코드페이지
│  ├─ logger.ts
│  └─ types.ts
├─ docs/                    # 기획서/로드맵 작성 예시 (verify 없음)
├─ .env.example
└─ README.md
```

산출물은 **대상 Unity 프로젝트** 아래에 생성됩니다.

- `runtime/state.json` — 진행 상태, Step 메모리, 토큰 합계, 작업 브랜치
- `runtime/run.lock` — 동시 `run` 방지
- `runtime/orchestrator.log` — 오케스트레이터 로그
- `runtime/prompts/` — `file` 전달 시 프롬프트 (최근 3개)
- `Logs/unity_build.log` — 컴파일 콘솔/배치 로그
- `Logs/unity_test_results.json` — MCP EditMode 결과 (`batch` 는 `.xml`)

---

## 8. 문제 해결

| 증상 | 원인 및 조치 |
| --- | --- |
| `agent` 실행 실패: spawn ENOENT / `'agent'은(는) 내부 또는 외부 명령... 아닙니다` | CLI가 PATH에 없습니다. [Cursor CLI 설치](https://cursor.com/docs/cli/installation) 후 `agent --version` 으로 확인하세요. `doctor` 도 동일하게 `--version` 을 호출합니다. 해결되지 않으면 `CURSOR_AGENT_BIN` 에 절대경로를 지정하세요. |
| `Cursor CLI 인증이 없습니다` | `doctor` 의 `status`/`whoami` 가 로그인 실패를 봤습니다. [Authentication](https://cursor.com/docs/cli/reference/authentication) 을 완료하세요. |
| `에디터/UnityMCP 가 준비되지 않아 Agent 를 시작하지 않습니다` | `compile`/`full` 은 열린 에디터가 필요합니다. 에디터를 켜 두거나 `UNITY_PATH` 로 자동 기동되게 하세요. `--no-mcp-probe` 로는 이 게이트를 건너뛰지 않습니다. |
| `UnityMCP 도구가 없습니다: refresh, readConsole` | MCP for Unity 버전/도구 이름이 다릅니다. `doctor` 에 찍힌 도구 목록을 확인하세요. |
| `다른 run 이 이미 실행 중입니다` | `runtime/run.lock` 이 살아 있는 프로세스에 묶여 있습니다. 이전 run 이 끝났다면 락 파일을 지워도 됩니다. |
| Unity가 즉시 종료하고 exit code가 0이 아님 | `UNITY_VALIDATION_BACKEND=batch` 일 때 Editor가 같은 프로젝트를 열어 두면 `Library` 락으로 실패합니다. 기본 mcp 채널은 에디터를 켠 채로 검수합니다. |
| 매번 "변경된 파일이 하나도 없습니다" 로 실패 | Agent가 대상 경로에 파일을 쓰지 못했습니다. `CURSOR_YOLO=true` 인지, `targetFiles` 가 맞는지 확인하세요. |
| 주석/`using` 만 바꾸고 통과하지 못함 | 의미 있는 변경이 없다고 봅니다. 구현을 남기세요. |
| 컴파일 검수가 계속 타임아웃 | 최초 임포트·도메인 리로드가 깁니다. 에디터로 한 번 연 뒤 실행하거나 `UNITY_TIMEOUT_MS` / `UNITY_LAUNCH_TIMEOUT_MS` 를 늘리세요. |
| Play Mode 가 검수 때문에 꺼짐 | 기본 동작입니다. 검수 후 다시 재생합니다. 끄려면 `UNITY_STOP_PLAY_MODE=false` (재생 중이면 검수 실패). |
| 한 Step에서 계속 재시도 후 중단 | Task 단위가 너무 큽니다. `roadmap.json` 의 Step을 더 잘게 나누세요. 워킹 트리의 이번 Step 산출물은 롤백됩니다. |
| `agent` 실행 오류: 명령줄이 너무 깁니다. | Windows `cmd.exe` 의 8191자 명령행 상한입니다. `CURSOR_PROMPT_DELIVERY=auto`(기본값)면 stdin으로 자동 우회합니다. 그래도 실패하면 `file` 로 고정하세요 ([4-4](#4-4-프롬프트-전달-방식)). |
| `Git 저장소가 아닙니다` (fatal) | `lint`/`compile`/`full` 은 Git Diff 검수가 필요합니다. 대상 프로젝트에서 `git init` 하거나 `VALIDATION_MODE=skip` 을 사용하세요. |
| `agent` 가 exit code ≠ 0 으로 종료 | Agent 실행 자체 실패로 재시도합니다. CLI 인증·`CURSOR_AGENT_BIN` 경로를 확인하세요. |
| 검수 통과 후 커밋만 반복 실패 | `git` 권한·`.gitignore`·`GIT_AUTHOR_*` 설정을 확인하세요. Step 은 완료되지 않고 재시도됩니다. |
| 내 미커밋 파일이 커밋에 안 들어감 | 시작 당시 dirty 파일은 자동 커밋에서 빼 둡니다. 의도된 동작입니다. |
| `status` 가 `paused` 로 멈춤 | `Ctrl+C` 로 중단된 상태입니다. 문제 없으면 `run` 을 다시 실행하면 `currentStepId` 부터 이어집니다. |
| Agent가 Task 지시의 일부만 수행함 | 여러 줄 프롬프트가 명령행에서 잘렸을 수 있습니다. `CURSOR_PROMPT_DELIVERY` 를 `argv` 로 강제하지 마세요. |
| 콘솔 한글이 깨짐 | 실행 시 자동으로 `chcp 65001` 을 적용하지만, 일부 터미널에서는 수동으로 UTF-8 코드페이지를 설정해야 합니다. 로그 파일(`runtime/orchestrator.log`)은 항상 UTF-8입니다. |
| 로그의 오류 메시지가 `����` 로 나옴 | 자식 프로세스가 로컬 코드페이지(한국어 949 등)로 출력한 경우입니다. 현재는 UTF-8 → 콘솔 코드페이지 순으로 디코딩해 복원하므로, 재현되면 이슈로 알려주세요. |

---

## 9. 안전 관련 주의

이 저장소는 **테스트 버전**이며, 아래 항목은 선택이 아닌 필수입니다.

`CURSOR_YOLO=true` 는 Agent의 파일 쓰기와 MCP 도구 호출을 **사람 확인 없이 자동 승인**합니다.
반드시 Git으로 관리되는 프로젝트에서 사용하세요. `CREATE_WORK_BRANCH=true`(기본) 이면 `run` 이 `auto-work/<시각>` 브랜치를 만듭니다. 중요한 작업 전에는 직접 브랜치를 나눠도 됩니다.

```powershell
cd D:\UnityProjects\MyGame
git switch -c auto/orchestrator-run
```
