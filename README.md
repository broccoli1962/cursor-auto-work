# cursorAutoWork

> ## ⚠️ 테스트 버전 (Experimental / Test Release)
>
> **이 프로젝트는 실험용 테스트 버전입니다. 프로덕션 환경에서 사용하지 마세요.**
>
> - 실제 운영 중인 프로젝트나 백업이 없는 코드베이스를 대상으로 실행하지 마세요.
> - 기본값은 `CURSOR_YOLO=true`, `AUTO_COMMIT=false`, `AUTO_PUSH=false`, `VALIDATION_MODE=compile` 입니다. `compile` 은 열린 Unity Editor + 공식 Unity CLI 가 필요합니다. `unity` 가 없으면 설치 여부를 묻습니다. 자동 커밋/푸시는 `.env` 에서 **명시적으로** 켜야 합니다. YOLO 를 끄려면 `CURSOR_YOLO=false`.
> - 검수 파이프라인(컴파일/테스트/Diff)은 아직 충분히 검증되지 않았고, 잘못된 변경을 통과시킬 수 있습니다.
> - CLI 옵션, 환경 변수, `roadmap.json` 스키마는 예고 없이 변경될 수 있습니다.
> - 반드시 **Git으로 관리되는 사본**에서 실행하세요. 기본으로 `auto-work/<시각>` 작업 브랜치를 만듭니다 (`CREATE_WORK_BRANCH`).
>
> 사용에 따른 코드 손실이나 예기치 않은 변경에 대한 책임은 사용자에게 있습니다.

Unity 프로젝트를 대상으로 **Cursor CLI(`agent`)를 무인 제어**하는 Node.js(TypeScript) 오케스트레이터입니다.

대상 프로젝트의 기획서(`docs/spec.md`)와 로드맵(`docs/roadmap.json`)을 읽어 Step을 순서대로 지시합니다.
Agent가 끝나면 **추론 Verify → delta 린트 → (compile/full) Editor 컴파일 → (full+runTests) EditMode 테스트 → 완료 조건 판정**을 모두 통과해야 다음 Step으로 갑니다.
실패하면 피드백을 넣고 같은 세션을 resume 해 재시도하고, 한도를 넘기면 이번 Step 변경만 롤백한 뒤 Discord로 사람 개입을 요청합니다.

`run` 은 기본적으로 그 루프를 시간 예산 안에서 반복합니다. Step 을 개발한 뒤, 그 Step 의 `playtest` 가 있으면 Play Mode 에서 조작을 넣고 Unity CLI `eval` 로 씬 값을 읽어 합격 여부를 정합니다. 측정이 맞지 않으면 검토로 넘어가지 않고 같은 Step 을 다시 합니다. 측정이 맞거나 화면으로 볼 기능이 없는 Step 이면 별도 검토 세션이 기획과 구현을 보고, 필요하면 기획서와 남은 Step 을 고칩니다. 기본 예산은 4시간(`AUTONOMY_BUDGET_MS`)입니다. `GOAL` 이나 `docs/goal.md` 가 있으면 그 주제로 기획부터 다시 쓰고, 둘 다 없으면 이미 있는 기획서를 목표로 두고 로드맵은 유지합니다. 사이클을 끄려면 `AUTONOMY=false` 또는 `--no-autonomy`.

```
┌─────────────┐   프롬프트    ┌──────────────┐   파일/에디터 조작   ┌──────────────┐
│ Orchestrator│ ───────────▶ │    agent     │ ──────────────────▶ │ Unity Project│
│  (이 저장소) │ ◀─────────── │ (+ Unity CLI)│                     └──────┬───────┘
└──────┬──────┘  NDJSON 스트림 └──────────────┘                            │
       │                                                                   ▼
       │  ① 추론 Verify  ② delta 린트  ③ Editor 컴파일  ④ 테스트  ⑤ 판정  ◀─┘
       │
       ├─ 검수 통과 → (선택) `{영역} - {변경}` 커밋 → (선택) push
       │     └─ (자율) 그 Step 조작을 Unity CLI 로 측정
       │           ├─ 불일치 → 같은 구현 세션에서 수정 후 다시 측정. 예산 안에서는 그 Step 에 남음
       │           └─ 일치 또는 playtest 없음 → 검토 세션. revise 면 기획과 남은 Step 을 고침
       └─ 검수 실패 → 피드백 + 세션 resume (최대 N회) → 초과 시 롤백 + Discord 🚨
```

이 저장소의 `docs/` 는 **작성 예시**입니다. 실제 작업 대상은 항상 `TARGET_PROJECT_PATH` 의 Unity 프로젝트입니다.

---

## 1. 요구 사항

| 항목 | 버전/비고 |
| --- | --- |
| Node.js | 18 이상 (권장 20 LTS) |
| Git | `lint`/`compile`/`full` 검수 및 자동 커밋 시 필수 |
| Unity Editor | `compile`/`full`(기본 `cli`) 동안 **켜 둘 것**. 없으면 `unity open` 으로 자동 기동. Unity 6.0 이상 |
| Unity CLI | 공식 [`unity`](https://docs.unity.com/en-us/unity-cli/use-unity-cli) 바이너리. 없으면 `doctor`/`run` 이 설치를 묻거나 `--install-unity-cli` 로 설치 |
| Unity Pipeline | 프로젝트의 `com.unity.pipeline`. 에디터가 열린 뒤 `unity pipeline install` (없을 때 질문) |
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

`.env.example` 에 바꿀 수 있는 환경 변수를 기본값과 짧은 설명으로 적어 두었습니다. 복사한 뒤 필요한 값만 바꾸면 됩니다. 시작 시 제거된 키(`SKIP_VALIDATION`, `AUTONOMY_PLAYTEST_INPUT` 등)와 읽히지 않는 비슷한 이름의 키는 경고합니다.

```powershell
Copy-Item .env.example .env
```

최소한 `TARGET_PROJECT_PATH` 는 반드시 지정해야 합니다. `compile`/`full` 은 기본으로 **열린 Unity Editor + 공식 Unity CLI** 로 검수합니다. `unity` 가 PATH 에 없으면 터미널에서 설치 여부를 묻고, `UNITY_CLI_INSTALL=yes` 또는 `--install-unity-cli` 이면 공식 설치 스크립트를 실행합니다. 에디터가 꺼져 있으면 `unity open` 으로 띄운 뒤 기다립니다. `UNITY_PATH` 가 **필수인 경우**는 `UNITY_VALIDATION_BACKEND=batch` 이거나, `unity open` 이 실패해 폴백할 때뿐입니다.

```dotenv
TARGET_PROJECT_PATH=D:\UnityProjects\MyGame
# 자동 기동 또는 batch 채널에 사용
UNITY_PATH=C:\Program Files\Unity\Hub\Editor\2022.3.40f1\Editor\Unity.exe
```

주요 환경 변수:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TARGET_PROJECT_PATH` | `process.cwd()` | 작업 대상 Unity 프로젝트 루트 |
| `UNITY_PATH` | (없음) | Unity.exe. `batch` 채널, 또는 `unity open` 실패 시 폴백 |
| `UNITY_CLI_BIN` | `unity` | 공식 Unity CLI 실행 파일 |
| `UNITY_CLI_INSTALL` | `ask` | CLI 가 없을 때 `ask`(TTY 에서 질문) / `yes`(바로 설치) / `no` |
| `UNITY_PIPELINE_INSTALL` | `ask` | `com.unity.pipeline` 가 없을 때 `ask` / `yes` / `no` |
| `UNITY_VALIDATION_BACKEND` | `cli` | `cli`: 열린 에디터에 Unity CLI 로 컴파일/테스트. `batch`: `-batchmode -quit`. `mcp` 는 `cli` 로 취급 |
| `UNITY_LAUNCH_EDITOR` | `true` | 인스턴스가 없으면 `unity open` 으로 에디터를 띄움 |
| `UNITY_LAUNCH_TIMEOUT_MS` | `180000` | 에디터 기동/접속 대기 (3분) |
| `UNITY_STOP_PLAY_MODE` | `true` | 검수 전 Play Mode 중지. `false` 이면 재생 중일 때 검수 실패 |
| `UNITY_RESTORE_PLAY_MODE` | `true` | 검수 후 원래 Play Mode 복구 |
| `CURSOR_AGENT_BIN` | `agent` | Cursor CLI 실행 명령 |
| `CURSOR_MODEL` | (CLI 기본값) | 메인 Agent가 사용할 모델 |
| `CURSOR_YOLO` | `true` | 구현 Agent에 `--force` 를 붙여 셸(Unity CLI)/파일 쓰기를 자동 승인. `--trust` 는 YOLO와 관계없이 항상 붙음. 끄려면 `false` |
| `CURSOR_PROMPT_DELIVERY` | `auto` | 프롬프트 전달 방식: `auto` / `argv` / `stdin` / `file` ([4-4](#4-4-프롬프트-전달-방식)) |
| `DISCORD_WEBHOOK_URL` | (없음) | 미설정 시 알림은 콘솔에만 출력 |
| `SPEC_PATH` / `ROADMAP_PATH` | `./docs/*` | **대상 프로젝트 기준** 상대경로 |
| `STATE_PATH` | `./runtime/state.json` | 진행 상태 저장 위치 |
| `RUNTIME_DIR` | `./runtime` | 락·로그·프롬프트 파일 디렉터리 |
| `MAX_RETRIES` | `3` | Step 당 최대 재시도 |
| `AGENT_TIMEOUT_MS` | `1800000` | Agent 1회 실행 타임아웃 (30분) |
| `UNITY_TIMEOUT_MS` | `1200000` | Unity CLI 대기/배치모드 타임아웃 (20분) |
| `VALIDATION_MODE` | `compile` | 검수 프리셋: `lint` / `compile` / `full` / `skip` ([6-2](#6-2-검수-파이프라인)) |
| `INFER_VERIFY` | `true` | `targetFiles`/완료 조건에서 파일·내용·프리팹·Addressables 검사 추론. 로드맵 JSON은 수정하지 않음 |
| `STEP_JUDGE` | `true` | 기계 체크·컴파일 후 완료 조건 판정 Agent. `--force` 없이 실행. 구현과 같이 `--trust` 는 붙음 |
| `JUDGE_TIMEOUT_MS` | `180000` | 판정 Agent 타임아웃 (3분). `AGENT_TIMEOUT_MS` 와 **별개**. 조건이 많으면 `600000`(10분) 권장 |
| `AUTONOMY` | `true` | 기획·개발·검토·기획 수정 사이클. `false` / `no` / `off` 이면 로드맵만 실행 |
| `AUTONOMY_BUDGET_MS` | `14400000` | 계획을 고쳐 가며 따라가는 시간 (기본 4시간). 끝나면 `paused`, 다음 `run` 이 이어서 진행 |
| `AUTONOMY_MAX_CYCLES` | `48` | 사이클 안전 상한. 시간 예산이 먼저 끝나면 여기까지 가지 않음 |
| `AUTONOMY_STEPS_PER_CYCLE` | `1` | 검토 사이에 실행할 Step 수. 1이면 매 Step 뒤에 계획과 화면을 다시 봄 |
| `AUTONOMY_PLAYTEST` | `true` | 그 Step 의 `playtest` 를 Play Mode 에서 실행하고 `eval` 로 합격 여부를 읽음. 스크린샷은 수정용. `compile`/`full` + Unity CLI 일 때 |
| `AUTONOMY_PLAYTEST_SETTLE_MS` | `2000` | 재생 후, 그리고 그 Step 조작 후 캡처 전 대기 |
| `AUTONOMY_REVIEW_TIMEOUT_MS` | `600000` | 목표 대비 검토 Agent 타임아웃 (10분) |
| `GOAL` | (없음) | 개발 주제. 비우면 기획서를 목표로 보고 기존 로드맵을 유지. 값이 있으면 첫 실행에서 기획을 그 주제에 맞게 다시 씀. CLI `--goal` 이 우선 |
| `GOAL_PATH` | `./docs/goal.md` | `GOAL` 이 비어 있을 때 읽을 주제 파일. 파일이 없으면 무시 |
| `AUTONOMY_RESUME_SESSION` | `true` | 구현 세션을 Step 과 화면 확인 뒤로 이어 감. 검토는 새 세션 |
| `AUTONOMY_SESSION_STEPS` | `4` | 이 횟수 뒤 구현 세션만 새로 연다. 최근 검토 이유는 다음 프롬프트에 남긴다 |
| `AUTONOMY_PLAYTEST_RETRIES` | `3` | 기대 화면과 다르면 그 자리에서 고치고 조작을 다시 넣는 횟수 |
| `RESUME_ON_RETRY` | `true` | 검수 실패 재시도 시 직전 Agent 세션 `--resume` |
| `ROLLBACK_ON_FAIL` | `true` | 재시도 한도 초과 시 이번 Step delta 만 되돌림 (시작 당시 dirty 는 유지) |
| `CREATE_WORK_BRANCH` | `true` | `run` 시작 시 `auto-work/<시각>` 브랜치 생성 (이미 `auto-work/*` 이면 유지) |
| `RULES_MAX_CHARS` | `40000` | `.cursorrules` 등 규칙 예산. 초과 시 중간 생략 + 경고 |
| `SPEC_MAX_CHARS` | `20000` | 기획서 예산. 초과 시 중간 생략 + 경고 |
| `AUTO_COMMIT` | `false` | 검수 통과 시 자동 커밋. 시작 당시 dirty 파일은 add 하지 않음 |
| `AUTO_PUSH` | `false` | 커밋 성공 후 `git push -u origin HEAD`. force push 없음 |
| `COMMIT_LANGUAGE` | `ko` | 커밋 메시지 언어 `ko` / `en`. 형식은 항상 `{영역} - {변경}` |
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
  "commitMessage": "룰 - Game.Rules 카탈로그 추가",
  "playtest": {
    "input": "key:Space; wait:400",
    "expect": "점프 후 착지",
    "probe": {
      "events": ["JumpStarted", "Landed"],
      "position": { "object": "Player", "axis": "y", "deltaMin": 1 }
    }
  }
}
```

`task` 만 필수이고 나머지는 선택입니다. `playtest` 는 플레이어가 보고 조작하는 Step 에만 둡니다. `input` 은 그 기능만 시험하는 조작이고, `expect` 는 사람용 설명입니다. 합격은 `probe` 입니다. 메뉴는 `active.equals`, 점수 글자는 `text.contains`, 여러 대상은 `positions` / `actives` / `texts` 입니다. 기능 코드는 `CursorAutoWork.PlaytestLog.Mark("이벤트이름")` 를 호출합니다. `commitMessage` 가 `{영역} - {변경}` 이면 그 문구를 쓰고, `feat:` 같은 영문 conventional 이면 제목에서 다시 만듭니다. 일상적으로는 **`verify` 블록을 쓰지 않아도 됩니다.** 추론으로 안 잡히는 예외만 `verify.checks` 로 덮어쓸 수 있습니다. `runTests: true` 는 **`VALIDATION_MODE=full` 일 때만** 해당 Step에서 EditMode 테스트를 실행합니다.

완료 조건에 **「컴파일 에러 0건」「테스트가 통과한다」** 를 넣지 마세요. 컴파일은 `VALIDATION_MODE=compile`/`full` 이, 테스트는 `full` + `runTests` 가 이미 검사합니다. 판정 Agent는 Unity CLI 를 호출하지 못해 그 문장만으로는 통과 근거를 만들 수 없습니다. 조건은 파일·심볼·기획서 절처럼 디스크에서 증명할 내용만 적습니다.

### 4-2. `.cursorrules` 와 Unity CLI

- 대상 프로젝트 루트의 `.cursorrules`, `.cursor/rules/*.mdc`, `AGENTS.md` 는 **매 CLI 실행마다 프롬프트 최상단 System Context로 주입**됩니다. C# 스타일, UniTask/Addressables 사용 원칙, MVP 패턴 강제 등을 여기에 작성하세요. 기본 예산은 40,000자입니다. `.cursor/skills` 는 구현 프롬프트에 넣지 않습니다. 커밋 형식은 스킬 유무와 관계없이 오케스트레이터가 `{영역} - {변경}` 으로 작성합니다.
- `compile`/`full` 이면 Agent 에게 **공식 Unity CLI** 로 에디터를 조작하라고 지시합니다. Coplay UnityMCP 는 쓰지 않습니다. 예: `unity command create_gameobject --project-path "<프로젝트>"`. 명령 목록은 `unity command` 입니다. 셸 실행과 파일 쓰기는 `CURSOR_YOLO=true`(`--force`)로 자동 승인됩니다. 구현·판정 Agent 모두 `--trust` 를 받습니다. 판정은 `--force` 없이 읽기 전용이며 Unity CLI 를 호출하지 않습니다.
- 오케스트레이터 컴파일 검수도 같은 CLI 에 붙습니다. `unity command recompile` 후 `recompile_status` 를 폴링하고, `get_console_logs` 에서 `error CS####` 를 읽습니다. EditMode 테스트는 `unity command run_tests --mode editor` 입니다.
- 에디터와 CLI 를 잇는 [Unity Pipeline](https://docs.unity3d.com/Packages/com.unity.pipeline@0.6/manual/index.html) 패키지(`com.unity.pipeline`)가 없으면 `unity pipeline install` 을 묻습니다. Unity 6.0 이상이 필요합니다. 다른 MCP 서버는 전역 `~/.cursor/mcp.json` 과 프로젝트 `.cursor/mcp.json` 을 병합해서 읽습니다. 같은 이름이 양쪽에 있으면 프로젝트 설정이 우선합니다.

### 4-3. MCP가 실제로 살아 있는지 확인하기

`doctor` 는 설정 파일에 이름이 적혀 있는지만 보지 않고, 등록된 모든 MCP 서버에 **직접 접속해 JSON-RPC `initialize` → `tools/list` 핸드셰이크를 수행**합니다. HTTP(Streamable HTTP/SSE)와 stdio 두 방식 모두 지원합니다. `agent --version` 과 `status`/`whoami` 인증도 봅니다.

```powershell
node dist/index.js doctor
```

```
Unity CLI        : 1.0.0-beta.6
=== MCP 연결 점검 (initialize + tools/list 실제 호출) ===
  [ OK ] mcp-gsheets (global, stdio) - spreadsheet 1.8.0 · 도구 44개 · 2406ms
```

- `[ OK ]` 는 서버가 지금 응답하고 있고 도구 목록까지 받아왔다는 뜻입니다. Unity 검수는 이 MCP 목록이 아니라 **Unity CLI** 로 합니다.
- `doctor` 는 `unity --version` 도 봅니다. CLI 가 없고 `compile`/`full` 이면 설치 여부를 묻습니다 (`UNITY_CLI_INSTALL`, `--install-unity-cli`).
- `run` 은 `compile`/`full`(cli) 이면 **에디터 게이트를 통과해야 Agent를 시작합니다.** CLI 없음·에디터 없음·Pipeline 미설치는 fatal 입니다. `--no-mcp-probe` 는 MCP 목록 점검만 건너뛰며, Unity CLI 게이트는 건너뛰지 않습니다.
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

# 파이프라인 실행 (기본: 개발 후 검토하고, 필요하면 기획을 고친 뒤 다시 개발)
node dist/index.js run

# 주제를 환경 변수로 두면 기획부터 그 주제에 맞춘다
# GOAL=한 판짜리 2D 로그라이크

# 이번 실행만 로드맵 실행으로 제한
node dist/index.js run --no-autonomy

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
| `--no-push` | 자동 푸시 비활성화 |
| `--debug` | Agent 스트림 원문까지 출력 |
| `--no-mcp-probe` | MCP 서버 목록 점검 생략 (`doctor`, `run`). 에디터 게이트는 유지 |
| `--mcp-timeout <ms>` | MCP 응답 대기 시간 (기본 20000) |
| `--no-infer-verify` | `targetFiles`/완료 조건에서 verify 추론 끄기 |
| `--no-judge` | 완료 조건 판정 Agent 끄기 |
| `--no-launch-editor` | 에디터 자동 기동 끄기 |
| `--no-resume` | 재시도 시 세션 resume 끄기 |
| `--install-unity-cli` | Unity CLI 가 없으면 묻지 않고 공식 스크립트로 설치 |
| `--no-install-unity-cli` | Unity CLI 를 설치하지 않고, 없으면 안내 후 중단 |
| `--goal <주제>` | 이번 실행의 개발 주제. `GOAL` 보다 우선하며, 기획서와 로드맵을 그 주제에 맞게 다시 씀 |
| `--cycles <n>` | 자율 루프 최대 사이클. `AUTONOMY_MAX_CYCLES` 덮어쓰기 |
| `--autonomy` | `AUTONOMY=false` 여도 이번 실행은 사이클을 켬 |
| `--no-autonomy` | 이번 실행은 로드맵만 실행 |

명령은 `--project D:\Game run` 처럼 옵션 뒤에 와도 됩니다.

같은 대상 프로젝트에 `run` 이 이미 있으면 `runtime/run.lock` 으로 거절합니다. 프로세스가 죽었으면 락을 회수합니다.

`Ctrl+C` 를 누르면 실행 중인 Agent 프로세스 트리와 Unity CLI 검수 프로세스를 **즉시** 끊고, `runtime/state.json` 을 `status: "paused"` 로 남긴 뒤 종료합니다. Unity Editor 는 끄지 않습니다. 한 번 더 `Ctrl+C` 를 누르면 프로세스 자체를 강제 종료합니다 (`exit 130`). 다음 `run` 에서 이어서 진행됩니다.

개발 중에는 빌드 없이 실행할 수도 있습니다.

```powershell
npx tsx src/index.ts preview-prompt --to 1
```

---

## 6. 동작 방식

### 6-1. Fresh Context 메모리 관리

`AUTONOMY=false` 이면 **매 Step은 새 세션**으로 시작합니다. `AUTONOMY=true` 이고 `AUTONOMY_RESUME_SESSION=true`(기본값) 이면 구현은 한 세션을 Step 과 화면 확인 뒤로 이어 갑니다. 검토와 기획 수정은 그 세션을 쓰지 않습니다.
검수 실패 재시도는 기본으로 **직전 세션을 resume** 하고 피드백을 넣습니다 (`RESUME_ON_RETRY=false` 또는 `--no-resume` 으로 끌 수 있음).

이전 대화 전체를 넘기는 대신 다음만 압축해서 최상단에 주입합니다.

1. `.cursorrules` / `.cursor/rules` / `AGENTS.md` (System Context, 기본 40,000자. 초과 시 중간 생략 + 경고)
2. Unity CLI 조작 지침(`compile`/`full`)과, Unity 가 아닌 MCP 서버 목록
3. `state.json` 의 현재 진행 상태 (완료 Step, 시도 횟수)
4. 최근 5개 Step의 핵심 요약과 변경 파일 (`SUMMARY`/`FILES`/`NEXT` 규약 우선, 없으면 한/영 키워드)
5. 기획서 (기본 20,000자. 초과 시 중간 생략 + 경고). 완료 조건은 기획서를 정본으로 해석한다
6. 현재 Task와 완료 조건, 추론된 Verify 항목
7. 재시도인 경우 직전 **검수 실패·Agent 실행 실패·커밋/푸시 실패** 피드백

Agent CLI 가 비정상 종료(exit ≠ 0, 타임아웃)한 경우에도 출력 요약을 메모리에 남겨, 다음 시도 프롬프트에 반영합니다.
스트림에 토큰 usage가 있으면 `state.usage` 에 합산하고, 파이프라인 종료 시 로그와 Discord에 남깁니다.

### 6-2. 검수 파이프라인 (`VALIDATION_MODE`)

검수는 **Git index 를 수정하지 않고** 워킹 트리 diff + untracked 파일 직접 읽기로 수행합니다.
`skip` 이 아니면 Agent가 끝난 뒤 아래 순서이며, **앞에서 실패하면 Unity 검수를 띄우지 않습니다.**

| 모드 | 실행 내용 | Unity 프로세스 |
| --- | --- | --- |
| `lint` | 추론/명시 Verify + 이번 Step delta 린트 + (기본) 판정 | 없음 |
| `compile` (기본) | lint + 열린 Editor(Unity CLI) 컴파일 + 판정 | 새 프로세스 없음 (에디터 유지) |
| `full` | lint + 에디터 컴파일 + EditMode 테스트 (`step.runTests=true` 일 때) + 판정 | 새 프로세스 없음 |
| `skip` | diff 수집만, 실패 없음 | 없음 |

모드별 실패 조건 (`skip` 제외):

| 단계 | 내용 | 실패 시 |
| --- | --- | --- |
| 추론 Verify | `targetFiles`·완료 조건 문장에서 파일/내용·프리팹 YAML·Addressables 등록을 추론. `verify.checks` 는 선택(덮어쓰기). 계약이 비면 실패 | 파일/심볼 없음, 빈 프리팹, 미등록 주소, 빈 계약, 주석/`using` 만의 변경 |
| Git Diff 린트 | tracked `git diff HEAD` + untracked 텍스트 파일 본문 검사. `Debug.Log` / `TODO` / 충돌 마커 등. `.png`·`.fbx` 등 바이너리·에셋은 생략 | 컨벤션 위반 |
| Unity 컴파일 | `compile`/`full` — `unity command recompile` + `get_console_logs` 의 `error CS####` (에디터를 끄지 않음). Play Mode 는 `editor_stop` 으로 잠시 끄고 `editor_play` 로 복구 | 에러 상위 N개를 피드백에 포함 |
| EditMode 테스트 | `full` + `runTests: true` — `unity command run_tests --mode editor` 후 `test_status` (batch 채널은 NUnit XML) | 실패 테스트명·메시지를 피드백에 포함 |
| 완료 조건 판정 | 앞 단계 통과 후 읽기 전용 Agent가 기획서를 정본으로 조건마다 `evidence`(구현 파일 경로)를 붙여 판정. Unity CLI 호출 없음. `Assets/`·`server/`·`Packages/`·`Docs/` 경로와 `:줄` 접미사를 디스크에서 확인. 항목 수 불일치·근거 없는 ok는 실패 | `reasons`를 재시도 피드백에 포함 |

`lint`/`compile`/`full` 은 **Git 저장소가 필수**입니다. `compile`/`full`(cli) 은 **run 시작 전에** Unity CLI, Pipeline, Editor 인스턴스를 확인합니다. 없으면 Agent를 시작하지 않습니다. 에디터가 없으면 `unity open` 으로 띄운 뒤 대기합니다 (`UNITY_LAUNCH_EDITOR`).

기존 `.gitignore` 가 있으면 빠진 Unity 규칙(`Library/`, `Temp/` 등)만 덧붙입니다. `Library/` 와 `[Ll]ibrary/` 는 같은 것으로 봅니다.

검수를 모두 통과하면 자동 커밋(`AUTO_COMMIT=true`) 시 **이번 Step에서 새로 더러워진 파일만** `git add` 합니다. Step 시작 전에 이미 dirty였던 파일은 통째로 커밋하지 않습니다. `.env` / `credentials.json` 은 제외합니다. 재시도 한도를 넘기면 그 Step이 만든 변경만 롤백하고, 시작 당시 dirty는 남깁니다.

자동 커밋 메시지는 항상 `{영역} - {변경}` 입니다. 관심사가 섞이면 영역별로 나눕니다. 언어만 `COMMIT_LANGUAGE`(`ko`/`en`)로 바꿉니다.

`AUTO_PUSH=true` 이면 커밋 후 `git push -u origin HEAD` 합니다. `--force` 는 쓰지 않습니다.

`AUTO_COMMIT=true` 인데 커밋이나 푸시가 실패하면 Step 을 완료 처리하지 않고, 검수 실패와 동일하게 피드백을 주입해 재시도합니다.

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
- `AUTO_COMMIT=true` 이면 검증되지 않은 코드가 커밋될 수 있습니다. 메시지는 여전히 `{영역} - {변경}` 입니다.

문제를 해결한 뒤에는 `VALIDATION_MODE=compile`(또는 `lint`/`full`) 로 되돌리는 것을 권장합니다.

### 6-4. Discord 알림

| 이벤트 | 색상 |
| --- | --- |
| 🚀 Step 시작 | 블루 |
| 🎮 검수 진행 중 | 퍼플 |
| ✅ Step 성공 및 (선택) 커밋/푸시 완료 | 그린 |
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
- `AUTO_COMMIT=true` 인데 git commit 또는 (`AUTO_PUSH` 일 때) push 실패

### 6-6. 자율 개발 사이클 (기본 켜짐)

`AUTONOMY=true`(기본값) 이면 `run` 이 로드맵을 한 번에 끝내지 않습니다. 기본으로 Step 하나를 개발·검수한 뒤, 그 Step 의 `playtest` 만 Play Mode 에서 실행합니다. 측정이 맞거나 `playtest` 가 없으면 검토 Agent 가 기획과 구현을 봅니다. 측정이 틀리면 검토로 가지 않고, 시간 예산이 남는 동안 같은 Step 을 다시 합니다. 예산이 끝나면 `paused` 로 남고, 다음 `run` 이 그 계획에서 계속합니다. `AUTONOMY_MAX_CYCLES`(기본 48)는 안전 상한입니다. `AUTONOMY=false` 또는 `--no-autonomy` 이면 로드맵만 실행합니다.

합격은 스크린샷 설명이 아닙니다. 오케스트레이터가 입력 전 기준, 약 200ms 뒤의 대조, 조작마다의 표본, 입력이 끝난 뒤의 표본을 `unity command eval` 로 읽습니다. `probe.events` 는 입력 뒤에 그 순서로 남아 있어야 하고, 입력 전에 이미 있으면 실패합니다. `position` 은 마지막 좌표가 아니라 입력 이후 정점입니다. `active` / `text` 는 메뉴가 켜졌는지, UI 글자가 바뀌었는지를 봅니다. 풀에 꺼져 있는 오브젝트와 이름 뒤 `(Clone)` 복제도 같은 이름으로 찾고, 개체 id 로 따라갑니다. 측정 결과가 있으면 화면 설명 판정은 하지 않습니다. `Logs/playtest/cycle-N-before.png`, `cycle-N-mid.png`, `cycle-N-after.png` 는 구현 세션이 실패를 볼 때 쓰는 그림입니다.

측정이 어긋나면 같은 구현 세션이 코드를 고치고 조작을 다시 넣습니다. 기본 3회(`AUTONOMY_PLAYTEST_RETRIES`)입니다. 그래도 맞지 않으면 그 Step 완료를 취소하고 `playtest.failure` 와 `playtest.history` 를 로드맵에 남깁니다. `playtest.expect` 와 한 번 적힌 `probe` 는 이후 검토가 더 느슨한 조건으로 바꾸지 못합니다. 검수 실패의 첫 줄과 측정 실패 이유는 모델이 `LESSON:` 을 적지 않아도 상태 파일에 들어갑니다. 구현 출력의 끝 200자도 `구현 메모` 로 남습니다. 세션을 열었는데 출력이 비어 있거나 resume 이 실패하면 그 대화를 버리고 기획서와 로드맵으로 새 세션을 엽니다.

구현 세션은 Step 과 측정 뒤로 이어 갑니다(`AUTONOMY_RESUME_SESSION`, 기본 켜짐). 검토와 기획 수정은 그 세션을 쓰지 않습니다. `AUTONOMY_SESSION_STEPS`(기본 4)마다 구현 세션만 새로 열며, 최근 검토 이유와 메모는 다음 프롬프트에 남습니다. 디스크의 기획서와 로드맵이 옛 대화보다 우선합니다.

입력은 OS 커서가 아니라 Unity Input System 입니다. 폴더 생성처럼 화면에 없는 Step 에는 `playtest` 를 두지 않습니다. `AUTONOMY_PLAYTEST=false` 이거나 검수가 `lint`/`skip` 이면 측정을 하지 않습니다. `wait` 는 그 시간이 끝난 뒤에 한 번 읽습니다. 대기 중에만 올라갔다 착지한 높이는 표본에 없을 수 있습니다. 키를 받은 함수가 매 프레임 위치와 속도를 점프 곡선으로 쓰면, 그 숫자는 점프와 같게 읽힙니다.

주제는 환경 변수로 둡니다. 우선순위는 `--goal`, `GOAL`, `GOAL_PATH`(`docs/goal.md`) 입니다. 셋 다 없으면 기획서 자체를 목표로 보고, 이미 있는 로드맵은 유지한 채 개발과 검토만 합니다. 주제가 있거나 기획서·로드맵이 아직 자리표시자면 첫 사이클에서 기획을 다시 씁니다.

```
주제
  → (필요할 때만) 기획서와 로드맵을 작성
  → Step 을 AUTONOMY_STEPS_PER_CYCLE 개만 개발·검수
  → playtest 가 있으면 Play Mode 에서 그 조작만 넣고 probe 를 읽음
       불일치 → 같은 구현 세션에서 수정 후 다시 측정. 예산이 남으면 검토 없이 같은 Step
       일치 또는 playtest 없음 → 검토 Agent
            done     → 종료
            revise   → 남은 Step 과 기획서를 고치고 다음 사이클
            blocked  → needs_human, exit 1
  → 시간 예산이 끝나면 paused. 다음 run 이 이어서 진행
```

검토가 `revise` 이면 끝난 Step 을 다시 열거나, 지시를 바꾸거나, 새 Step 을 뒤에 붙입니다. 이미 완료된 Step 본문은 기획 Agent 가 같은 id 로 덮어쓰지 못합니다. 개발 중 한 Step 이 재시도 한도를 넘기면 파이프라인을 바로 종료하지 않고, 그 실패를 검토 입력으로 넘깁니다. 검토는 그때 `done` 을 낼 수 없습니다.

같은 목표로 다시 실행하면 `state.json` 의 사이클에서 이어갑니다. 검토가 `done` 이면 같은 문장으로는 다시 시작하지 않습니다. `GOAL` 이나 `--goal` 문장을 바꾸면 기획부터 다시 씁니다. 사이클 한도에서 막히면 `AUTONOMY_MAX_CYCLES` 또는 `--cycles` 를 올리거나 기획서를 직접 고친 뒤 다시 실행합니다.

기획·기획서 수정 Agent 는 `CURSOR_YOLO` 와 무관하게 `--force` 로 문서를 씁니다. 검토 Agent 는 Step 판정과 같이 `--force` 없이 읽기 전용입니다. 게임 구현 Step 의 승인 정책은 그대로 `CURSOR_YOLO` 를 따릅니다.

`--from`, `--to`, `--force-rerun` 은 그 사이클의 개발 범위만 바꿉니다. 검토와 기획 수정은 그대로 이어집니다. 범위만 실행하고 검토를 건너뛰려면 `--no-autonomy` 를 붙입니다.

---

## 7. 프로젝트 구조

```
cursorAutoWork/
├─ src/
│  ├─ index.ts              # CLI (run / preview-prompt / init / status / doctor)
│  ├─ cliArgs.ts            # 명령·플래그 파서 (옵션 뒤 명령 허용)
│  ├─ orchestrator.ts       # 제어 루프, 재시도, resume, 롤백, 커밋 범위, --goal 사이클
│  ├─ autonomy.ts           # 기획/검토 판정, 로드맵 수정, 완료 Step 보존, 시간 예산
│  ├─ playtest.ts           # Play Mode 조작, 스크린샷, probe 표본
│  ├─ playtestProbe.ts      # PlaytestLog, 입력 전 대조, 정점·활성·글자 판정
│  ├─ cursorRunner.ts       # agent spawn, NDJSON, 규칙 수집, 인증 probe
│  ├─ mcpProbe.ts           # mcp.json 병합, 라이브 핸드셰이크
│  ├─ editorGate.ts         # run 전 Editor/Unity CLI 게이트, unity open
│  ├─ unityCli.ts           # 공식 unity CLI, 설치 질문, pipeline 명령
│  ├─ unityMcp.ts           # 예전 Coplay 세션 파서 (검수 경로에서는 사용하지 않음)
│  ├─ unityTools.ts         # 예전 UnityMCP 도구 별칭
│  ├─ unityValidator.ts     # CLI/배치 컴파일·테스트, CS/NUnit 파싱
│  ├─ unityAssetInspect.ts  # 프리팹 YAML · Addressables 디스크 검사
│  ├─ inferVerify.ts        # targetFiles/완료 조건에서 체크 추론
│  ├─ stepVerifier.ts       # 디스크 Verify 실행
│  ├─ stepJudge.ts          # 완료 조건 판정 Agent (기획서 정본, evidence 경로 확인)
│  ├─ projectCommit.ts      # `{영역} - {변경}` 메시지, 관심사 묶음, 시크릿 제외
│  ├─ gitManager.ts         # 스냅샷, scoped lint, gitignore 보완, 커밋/푸시/롤백
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
- `Logs/unity_test_results.json` — Unity CLI EditMode 결과 (`batch` 는 `.xml`)
- `Logs/playtest/cycle-N-before.png`, `cycle-N-mid.png`, `cycle-N-after.png` — 측정 전·중·후 Game 뷰
- `Assets/CursorAutoWork/PlaytestLog.cs` — 기능 코드가 `Mark` 로 남기는 이벤트 버퍼. 오케스트레이터가 없으면 만들고 컴파일합니다.

---

## 8. 문제 해결

| 증상 | 원인 및 조치 |
| --- | --- |
| `agent` 실행 실패: spawn ENOENT / `'agent'은(는) 내부 또는 외부 명령... 아닙니다` | CLI가 PATH에 없습니다. [Cursor CLI 설치](https://cursor.com/docs/cli/installation) 후 `agent --version` 으로 확인하세요. `doctor` 도 동일하게 `--version` 을 호출합니다. 해결되지 않으면 `CURSOR_AGENT_BIN` 에 절대경로를 지정하세요. |
| `Cursor CLI 인증이 없습니다` | `doctor` 의 `status`/`whoami` 가 로그인 실패를 봤습니다. [Authentication](https://cursor.com/docs/cli/reference/authentication) 을 완료하세요. |
| `Unity CLI(unity)가 설치되어 있지 않습니다` | 터미널에서 `y` 로 설치하거나 `--install-unity-cli` / `UNITY_CLI_INSTALL=yes` 를 사용하세요. 이미 설치됐다면 `UNITY_CLI_BIN` 에 절대경로를 지정합니다. |
| `에디터/Unity CLI 가 준비되지 않아 Agent 를 시작하지 않습니다` | `compile`/`full` 은 열린 에디터와 Pipeline 패키지가 필요합니다. 에디터를 켜 두거나 `unity open` 자동 기동을 쓰세요. Pipeline 은 `unity pipeline install` 또는 `UNITY_PIPELINE_INSTALL=yes`. |
| `다른 run 이 이미 실행 중입니다` | `runtime/run.lock` 이 살아 있는 프로세스에 묶여 있습니다. 이전 run 이 끝났다면 락 파일을 지워도 됩니다. |
| Unity가 즉시 종료하고 exit code가 0이 아님 | `UNITY_VALIDATION_BACKEND=batch` 일 때 Editor가 같은 프로젝트를 열어 두면 `Library` 락으로 실패합니다. 기본 cli 채널은 에디터를 켠 채로 검수합니다. |
| 매번 "변경된 파일이 하나도 없습니다" 로 실패 | Agent가 대상 경로에 파일을 쓰지 못했습니다. `CURSOR_YOLO=true` 인지, `targetFiles` 가 맞는지 확인하세요. |
| 주석/`using` 만 바꾸고 통과하지 못함 | 의미 있는 변경이 없다고 봅니다. 구현을 남기세요. |
| 컴파일 검수가 계속 타임아웃 | 최초 임포트·도메인 리로드가 깁니다. 에디터로 한 번 연 뒤 실행하거나 `UNITY_TIMEOUT_MS` / `UNITY_LAUNCH_TIMEOUT_MS` 를 늘리세요. |
| Play Mode 가 검수 때문에 꺼짐 | 기본 동작입니다. 검수 후 다시 재생합니다. 끄려면 `UNITY_STOP_PLAY_MODE=false` (재생 중이면 검수 실패). |
| 한 Step에서 계속 재시도 후 중단 | Task 단위가 너무 큽니다. `roadmap.json` 의 Step을 더 잘게 나누세요. 워킹 트리의 이번 Step 산출물은 롤백됩니다. |
| `agent` 실행 오류: 명령줄이 너무 깁니다. | Windows `cmd.exe` 의 8191자 명령행 상한입니다. `CURSOR_PROMPT_DELIVERY=auto`(기본값)면 stdin으로 자동 우회합니다. 그래도 실패하면 `file` 로 고정하세요 ([4-4](#4-4-프롬프트-전달-방식)). |
| `Git 저장소가 아닙니다` (fatal) | `lint`/`compile`/`full` 은 Git Diff 검수가 필요합니다. 대상 프로젝트에서 `git init` 하거나 `VALIDATION_MODE=skip` 을 사용하세요. |
| `agent` 가 exit code ≠ 0 으로 종료 | Agent 실행 자체 실패로 재시도합니다. CLI 인증·`CURSOR_AGENT_BIN` 경로를 확인하세요. |
| `Workspace Trust Required` 후 판정 JSON 실패 | 비대화형 `agent -p` 가 대상 폴더를 아직 신뢰하지 않음. 구현은 `--force`, 판정은 `--force` 없음. 현재는 양쪽 모두 `--trust` 를 붙인다. 예전 `dist` 이면 `npm run build` 후 재실행. 한 번 `cd` 대상 프로젝트 후 `agent -p "ok" --trust` 로 신뢰를 남겨도 된다. |
| 판정 `JSON 으로 해석하지 못했습니다` + 중간 설명만 남음 | 판정이 `JUDGE_TIMEOUT_MS`(기본 3분)에 잘림. `AGENT_TIMEOUT_MS` 를 늘려도 판정은 그대로다. `.env` 에 `JUDGE_TIMEOUT_MS=600000` 등을 넣고 **run 을 다시 시작**. |
| 판정: 컴파일 0건/테스트 그린을 기계 체크로 증명 불가 | 완료 조건에서 그 문장을 뺀다. 컴파일은 `compile`/`full`, 테스트는 `full`+`runTests` 가 담당. 판정은 Unity CLI 를 호출하지 않는다. |
| 판정: `server/...` evidence 가 디스크에 없음 | 예전 빌드는 `Assets/` 경로만 확인했다. 지금 빌드는 `server/` 등과 `:줄` 을 허용한다. `npm run build` 후 Step 을 다시 돈다. |
| 푸시 실패로 Step 이 완료 안 됨 | `AUTO_PUSH=true` 인데 remote/권한이 없음. `origin` 과 인증을 확인하거나 `--no-push`. force push 는 하지 않는다. |
| 검수 통과 후 커밋만 반복 실패 | `git` 권한·`.gitignore`·`GIT_AUTHOR_*` 설정을 확인하세요. Step 은 완료되지 않고 재시도됩니다. |
| 내 미커밋 파일이 커밋에 안 들어감 | 시작 당시 dirty 파일은 자동 커밋에서 빼 둡니다. 의도된 동작입니다. |
| `status` 가 `paused` 로 멈춤 | `Ctrl+C` 로 중단된 상태입니다. 문제 없으면 `run` 을 다시 실행하면 `currentStepId` 부터 이어집니다. |
| Agent가 Task 지시의 일부만 수행함 | 여러 줄 프롬프트가 명령행에서 잘렸을 수 있습니다. `CURSOR_PROMPT_DELIVERY` 를 `argv` 로 강제하지 마세요. |
| 콘솔 한글이 깨짐 | 실행 시 자동으로 `chcp 65001` 을 적용하지만, 일부 터미널에서는 수동으로 UTF-8 코드페이지를 설정해야 합니다. 로그 파일(`runtime/orchestrator.log`)은 항상 UTF-8입니다. |
| 로그의 오류 메시지가 `����` 로 나옴 | 자식 프로세스가 로컬 코드페이지(한국어 949 등)로 출력한 경우입니다. 현재는 UTF-8 → 콘솔 코드페이지 순으로 디코딩해 복원하므로, 재현되면 이슈로 알려주세요. |

---

## 9. 안전 관련 주의

이 저장소는 **테스트 버전**이며, 아래 항목은 선택이 아닌 필수입니다.

`CURSOR_YOLO=true` 는 Agent의 파일 쓰기와 셸(Unity CLI) 실행을 **사람 확인 없이 자동 승인**합니다.
반드시 Git으로 관리되는 프로젝트에서 사용하세요. `CREATE_WORK_BRANCH=true`(기본) 이면 `run` 이 `auto-work/<시각>` 브랜치를 만듭니다. 중요한 작업 전에는 직접 브랜치를 나눠도 됩니다.

```powershell
cd D:\UnityProjects\MyGame
git switch -c auto/orchestrator-run
```
