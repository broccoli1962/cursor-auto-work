# cursorAutoWork

> ## ⚠️ 테스트 버전 (Experimental / Test Release)
>
> **이 프로젝트는 실험용 테스트 버전입니다. 프로덕션 환경에서 사용하지 마세요.**
>
> - 실제 운영 중인 프로젝트나 백업이 없는 코드베이스를 대상으로 실행하지 마세요.
> - 기본값은 `CURSOR_YOLO=false`, `AUTO_COMMIT=false`, `VALIDATION_MODE=lint` 입니다. UnityMCP 자율 조작·자동 커밋을 쓰려면 `.env` 에서 **명시적으로** 켜야 합니다.
> - 검수 파이프라인(컴파일/테스트/Diff)은 아직 충분히 검증되지 않았고, 잘못된 변경을 통과시킬 수 있습니다.
> - CLI 옵션, 환경 변수, `roadmap.json` 스키마는 예고 없이 변경될 수 있습니다.
> - 반드시 **Git으로 관리되는 사본**에서, 별도 브랜치를 만들고 실행하세요.
>
> 사용에 따른 코드 손실이나 예기치 않은 변경에 대한 책임은 사용자에게 있습니다.

Unity 프로젝트를 대상으로 **Cursor CLI(`agent`)를 무인 제어**하는 Node.js(TypeScript) 오케스트레이터입니다.

기획서(`spec.md`)와 단계별 로드맵(`roadmap.json`)을 읽어 Step 1부터 순차적으로 Agent에게 작업을 지시하고,
`VALIDATION_MODE`에 따라 Git Diff 린트 · (선택) Unity 컴파일 · (선택) EditMode 테스트 검수를 통과한 Step만 자동 커밋한 뒤 다음 Step으로 진행합니다.
실패하면 검수 결과를 피드백 프롬프트로 만들어 재지시하고, 재시도 한도를 넘기면 Discord로 사람 개입을 요청합니다.

```
┌─────────────┐   프롬프트    ┌──────────────┐   파일/에디터 조작   ┌──────────────┐
│ Orchestrator│ ───────────▶ │    agent     │ ──────────────────▶ │ Unity Project│
│  (이 저장소) │ ◀─────────── │ (+ UnityMCP) │                     └──────┬───────┘
└──────┬──────┘  NDJSON 스트림 └──────────────┘                            │
       │                                                                   ▼
       │  ① Git Diff 린트  ② (compile/full) Unity 컴파일  ③ (full+runTests) 테스트  ◀─┘
       │
       ├─ 통과 → git commit → 다음 Step (Fresh Context 재시작)
       └─ 실패 → 검수 결과를 피드백 프롬프트로 재지시 (최대 N회) → 초과 시 Discord 🚨
```

---

## 1. 요구 사항

| 항목 | 버전/비고 |
| --- | --- |
| Node.js | 18 이상 (권장 20 LTS) |
| Git | `lint`/`compile`/`full` 검수 및 자동 커밋 시 필수 |
| Unity Editor | 컴파일/테스트 검수 대상 버전 (예: 2022.3 LTS) |
| `agent` | [Cursor CLI](https://cursor.com/docs/cli/overview). `agent --version` 으로 확인 |

> `agent` CLI 는 별도 설치가 필요합니다 ([Installation](https://cursor.com/docs/cli/installation)). Windows 예: `irm 'https://cursor.com/install?win32=true' | iex`  
> 비대화형 실행을 위해 [Authentication](https://cursor.com/docs/cli/reference/authentication) (`CURSOR_API_KEY` 또는 로그인)을 완료해 두어야 오케스트레이터가 Agent를 구동할 수 있습니다.

---

## 2. 설치

```powershell
cd D:\cursorAutoWork
npm install
npm run build
```

---

## 3. 설정

`.env.example` 을 복사해 `.env` 를 만들고 값을 채웁니다.

```powershell
Copy-Item .env.example .env
```

최소한 `TARGET_PROJECT_PATH` 는 반드시 지정해야 합니다. `UNITY_PATH` 는 `VALIDATION_MODE=compile` 또는 `full` 일 때 필요합니다.

```dotenv
TARGET_PROJECT_PATH=D:\UnityProjects\MyGame
# compile/full 모드일 때만 필수
UNITY_PATH=C:\Program Files\Unity\Hub\Editor\2022.3.40f1\Editor\Unity.exe
```

주요 환경 변수:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TARGET_PROJECT_PATH` | `process.cwd()` | 작업 대상 Unity 프로젝트 루트 |
| `UNITY_PATH` | (없음) | Unity.exe. `compile`/`full` 모드에서 필수, `lint`/`skip` 에서는 검수에 미사용 |
| `CURSOR_AGENT_BIN` | `agent` | Cursor CLI 실행 명령 |
| `CURSOR_MODEL` | (CLI 기본값) | 메인 Agent가 사용할 모델 |
| `CURSOR_YOLO` | `false` | `--force` 를 붙여 MCP 도구 호출/파일 쓰기를 자동 승인 |
| `CURSOR_PROMPT_DELIVERY` | `auto` | 프롬프트 전달 방식: `auto` / `argv` / `stdin` / `file` ([4-4](#4-4-프롬프트-전달-방식)) |
| `DISCORD_WEBHOOK_URL` | (없음) | 미설정 시 알림은 콘솔에만 출력 |
| `SPEC_PATH` / `ROADMAP_PATH` | `./docs/*` | **대상 프로젝트 기준** 상대경로 |
| `STATE_PATH` | `./runtime/state.json` | 진행 상태 저장 위치 |
| `MAX_RETRIES` | `3` | Step 당 최대 재시도 |
| `AGENT_TIMEOUT_MS` | `1800000` | Agent 1회 실행 타임아웃 (30분) |
| `UNITY_TIMEOUT_MS` | `1200000` | Unity 배치모드 타임아웃 (20분) |
| `VALIDATION_MODE` | `lint` | 검수 프리셋: `lint` / `compile` / `full` / `skip` ([6-2](#6-2-검수-파이프라인)) |
| `AUTO_COMMIT` | `false` | 검수 통과 시 자동 커밋 |
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
이 저장소의 `docs/` 에는 작성 예시(2D 로그라이크)가 들어 있으니 참고하세요.

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

`task` 만 필수이고 나머지는 선택입니다. `runTests: true` 는 **`VALIDATION_MODE=full` 일 때만** 해당 Step에서 EditMode 테스트를 실행합니다.

### 4-2. `.cursorrules` 와 UnityMCP

- 대상 프로젝트 루트의 `.cursorrules`, `.cursor/rules/*.mdc`, `AGENTS.md` 는 **매 CLI 실행마다 프롬프트 최상단 System Context로 주입**됩니다. C# 스타일, UniTask/Addressables 사용 원칙, MVP 패턴 강제 등을 여기에 작성하세요.
- UnityMCP가 등록되어 있으면 자동 감지되어, Agent에게 "Editor 조작이 필요하면 MCP 도구를 직접 호출하라"는 지침이 함께 주입됩니다. 도구 호출 승인은 `CURSOR_YOLO=true`(`--force`)로 자동 처리됩니다.
- MCP 설정은 Cursor와 동일하게 전역 `~/.cursor/mcp.json` 과 프로젝트 `.cursor/mcp.json` 을 병합해서 읽습니다. 같은 이름이 양쪽에 있으면 프로젝트 설정이 우선합니다.

### 4-3. MCP가 실제로 살아 있는지 확인하기

`doctor` 는 설정 파일에 이름이 적혀 있는지만 보지 않고, 등록된 모든 MCP 서버에 **직접 접속해 JSON-RPC `initialize` → `tools/list` 핸드셰이크를 수행**합니다. HTTP(Streamable HTTP/SSE)와 stdio 두 방식 모두 지원합니다.

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
- UnityMCP는 서버가 떠 있어도 Unity Editor가 붙어 있지 않으면 도구 호출이 실패하므로, `mcpforunity://instances` 리소스를 추가로 읽어 **연결된 Editor 인스턴스**까지 표시합니다. 인스턴스가 없으면 경고가 뜹니다.
- 응답하지 않는 서버는 `[FAIL]` 과 원인(`ECONNREFUSED`, 타임아웃, 프로세스 종료 stderr 등)이 함께 출력되고, `[WARN]` 이슈로 요약됩니다. 종료 코드는 기존 `FATAL` 이슈 기준을 유지합니다.
- `run` 도 시작 직전 같은 점검을 수행해 로그에 남깁니다. 점검을 건너뛰려면 `--no-mcp-probe`, 대기 시간을 늘리려면 `--mcp-timeout <ms>` 를 사용하세요 (stdio 서버는 최초 `npx` 다운로드 때문에 느릴 수 있습니다).

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
| `file` | 프롬프트를 `runtime/prompts/` 에 저장하고 그 경로를 읽으라고 지시 |

`auto` 에서 stdin 전달이 실패하면 자동으로 `file` 방식으로 한 번 더 시도합니다. CLI 버전에 따라 stdin을 받지 못한다면 `CURSOR_PROMPT_DELIVERY=file` 로 고정하세요.

---

## 5. 실행

```powershell
# 환경 점검 (Unity, CLI, 규칙, 웹훅 + MCP 서버 실제 접속 확인)
node dist/index.js doctor

# 파이프라인 실행 (완료되지 않은 Step부터 이어서)
node dist/index.js run

# Step 3부터 5까지만 실행 (전체 완료로 표시되지 않음 — 아래 6-5 참고)
node dist/index.js run --from 3 --to 5

# Agent를 실행하지 않고 조립된 프롬프트만 확인 (state.json 변경 없음)
node dist/index.js preview-prompt --to 1

# 진행 상황 확인 ([x] 완료 / [>] 진행 중 / [~] 일시 중지 / [ ] 대기)
node dist/index.js status
```

CLI 옵션:

| 옵션 | 설명 |
| --- | --- |
| `--project <path>` | `TARGET_PROJECT_PATH` 덮어쓰기 |
| `--from <n>` / `--to <n>` | 실행 범위 지정 |
| `--retries <n>` | 재시도 한도 덮어쓰기 |
| `--validation <mode>` | `lint` / `compile` / `full` / `skip` (`VALIDATION_MODE` 덮어쓰기) |
| `--no-commit` | 자동 커밋 비활성화 |
| `--debug` | Agent 스트림 원문까지 출력 |
| `--no-mcp-probe` | MCP 서버 실제 접속 점검 생략 (`doctor`, `run`) |
| `--mcp-timeout <ms>` | MCP 응답 대기 시간 (기본 20000) |

`Ctrl+C` 를 누르면 진행 중인 Step(현재 시도)을 마친 뒤 안전하게 종료하며, 진행 상태는 `runtime/state.json` 에 `status: "paused"` 로 남아 다음 실행에서 이어집니다.

개발 중에는 빌드 없이 실행할 수도 있습니다.

```powershell
npx tsx src/index.ts preview-prompt --to 1
```

---

## 6. 동작 방식

### 6-1. Fresh Context 메모리 관리

세션이 길어질수록 성능이 떨어지는 문제를 피하기 위해, **매 Step(및 매 재시도)마다 새 세션으로 CLI를 구동**합니다.
이전 대화 전체를 넘기는 대신 다음만 압축해서 최상단에 주입합니다.

1. `.cursorrules` / `.cursor/rules` / `AGENTS.md` (System Context)
2. 감지된 MCP 서버 목록(전역 + 프로젝트)과 자율 조작 지침
3. `state.json` 의 현재 진행 상태 (완료 Step, 시도 횟수)
4. 최근 5개 Step의 핵심 요약과 변경 파일 (`memoryManager` 가 Agent 출력에서 점수 기반으로 추출)
5. 기획서 요약 (최대 6,000자)
6. 현재 Task와 완료 조건
7. 재시도인 경우 직전 **검수 실패·Agent 실행 실패·커밋 실패** 피드백

Agent CLI 가 비정상 종료(exit ≠ 0, 타임아웃)한 경우에도 출력 요약을 메모리에 남겨, 다음 시도 프롬프트에 반영합니다.

### 6-2. 검수 파이프라인 (`VALIDATION_MODE`)

검수는 **Git index 를 수정하지 않고** 워킹 트리 diff + untracked 파일 직접 읽기로 수행합니다.

| 모드 | 실행 내용 | Unity 기동 |
| --- | --- | --- |
| `lint` (기본) | Git Diff + 컨벤션 린트 | 0회 |
| `compile` | lint + Batchmode 컴파일 | 1회 |
| `full` | lint + 컴파일 + EditMode 테스트 (`step.runTests=true` 일 때) | 1~2회 |
| `skip` | diff 수집만, 실패 없음 | 0회 |

모드별 실패 조건 (`skip` 제외):

| 단계 | 내용 | 실패 시 |
| --- | --- | --- |
| Git Diff 린트 | tracked `git diff HEAD` + untracked 텍스트 파일 본문 검사. `Debug.Log` / `TODO` / 충돌 마커 등. `.png`·`.fbx` 등 바이너리·에셋은 생략 | **변경 없음** 또는 컨벤션 위반 |
| Unity 컴파일 | `compile`/`full` — `-batchmode -quit` 후 `error CS####` 파싱 | 에러 상위 N개를 피드백에 포함 |
| EditMode 테스트 | `full` + `runTests: true` — NUnit XML 파싱 | 실패 테스트명·메시지를 피드백에 포함 |

`lint`/`compile`/`full` 은 **Git 저장소가 필수**입니다. Unity는 컴파일 에러가 있어도 exit code 0을 반환하는 경우가 있어 **로그 파싱을 1차 판정**으로 사용합니다.

검수를 모두 통과하면 자동 커밋(`AUTO_COMMIT=true`) 시 **해당 Step 에서 diff 로 수집된 변경 파일만** `git add` 한 뒤 커밋합니다. 워킹 트리에 있던 기존 미커밋 변경은 함께 올라가지 않습니다.

`AUTO_COMMIT=true` 인데 커밋이 실패하면 Step 을 완료 처리하지 않고, 검수 실패와 동일하게 피드백을 주입해 재시도합니다.

### 6-3. 검수 건너뛰기

```dotenv
VALIDATION_MODE=skip
```

```powershell
node dist/index.js run --validation skip
```

켜져 있으면 lint/컴파일/테스트를 생략하고 Agent 실행 직후 Step을 통과 처리합니다.

- 커밋 메시지용 변경 파일 **수집**은 유지하지만, 변경 없음·린트 위반으로 실패시키지 않습니다.
- Agent 프로세스 자체가 실패한 경우에만 재시도합니다.
- `AUTO_COMMIT=true` 이면 검증되지 않은 코드가 커밋될 수 있으며, 커밋 본문에 `NOTE: validation skipped (VALIDATION_MODE=skip).` 가 기록됩니다.

문제를 해결한 뒤에는 `VALIDATION_MODE=lint`(또는 `compile`/`full`) 로 되돌리는 것을 권장합니다.

### 6-4. Discord 알림

| 이벤트 | 색상 |
| --- | --- |
| 🚀 Step 시작 | 블루 |
| 🎮 Unity 검수 진행 중 | 퍼플 |
| ✅ Step 성공 및 커밋 완료 | 그린 |
| ⚠️ 컴파일 에러 발생 및 재수정 지시 | 옐로 |
| 🚨 최대 재시도 초과 (사람 개입 요청) | 레드 |

웹훅 전송 실패는 로그만 남기고 파이프라인을 중단시키지 않습니다.

### 6-5. 진행 상태 (`state.json`) 및 재시도

`runtime/state.json` 의 주요 `status` 값:

| status | 의미 |
| --- | --- |
| `idle` | 대기 또는 부분 실행 범위만 완료 |
| `in_progress` | Step 실행 중 |
| `paused` | `Ctrl+C` 등으로 중단 — `currentStepId` 유지, 다음 `run` 에서 이어서 진행 |
| `completed` | 마지막 Step 하나가 방금 끝남 (다음 Step 시작 전 transient) |
| `needs_human` | 재시도 한도 초과 — 수동 확인 후 재실행 |
| `all_completed` | 로드맵 **전체** Step 이 `completedSteps` 에 포함됨 |

**부분 실행 (`--from` / `--to`)**  
지정 범위의 Step 만 끝내도 `all_completed` 로 표시되지 않습니다. 로드맵 전 Step 이 완료될 때만 `all_completed` 및 파이프라인 완료 Discord 알림이 발생합니다.

**재시도가 발생하는 경우** (최대 `MAX_RETRIES` 회):

- Agent CLI 비정상 종료·타임아웃
- 검수 실패 (변경 없음, 린트 위반, 컴파일/테스트 실패)
- `AUTO_COMMIT=true` 인데 git commit 실패

---

## 7. 프로젝트 구조

```
cursorAutoWork/
├─ src/
│  ├─ index.ts           # CLI 진입점 (run / preview-prompt / init / status / doctor)
│  ├─ orchestrator.ts    # 메인 제어 루프, 재시도, 상태 관리
│  ├─ cursorRunner.ts    # agent CLI spawn, NDJSON 파싱, .cursorrules 수집
│  ├─ mcpProbe.ts        # mcp.json 병합 로딩, MCP 서버 라이브 핸드셰이크 점검
│  ├─ unityValidator.ts  # Unity 배치모드 실행, CS 에러 파싱, NUnit XML 파싱
│  ├─ gitManager.ts      # diff 수집, 컨벤션 정적 검사, 자동 커밋
│  ├─ memoryManager.ts   # Fresh Context 프롬프트 조립, 요약 추출, state.json
│  ├─ notifier.ts        # Discord Webhook Embed 전송
│  ├─ roadmap.ts         # roadmap.json 로딩 및 스키마 검증
│  ├─ config.ts          # 환경 변수 로딩 및 사전 점검
│  ├─ encoding.ts        # 콘솔 코드페이지 처리 및 자식 프로세스 출력 디코딩
│  ├─ logger.ts          # 콘솔 + 파일 로거
│  └─ types.ts           # 공용 타입 정의
├─ docs/                 # 기획서/로드맵 작성 예시
├─ .env.example
└─ README.md
```

산출물은 **대상 Unity 프로젝트** 아래에 생성됩니다.

- `runtime/state.json` — 진행 상태 및 Step 메모리
- `runtime/orchestrator.log` — 오케스트레이터 로그
- `Logs/unity_build.log` — 배치모드 컴파일 로그
- `Logs/unity_test_results.xml` — EditMode 테스트 결과

---

## 8. 문제 해결

| 증상 | 원인 및 조치 |
| --- | --- |
| `agent` 실행 실패: spawn ENOENT / `'agent'은(는) 내부 또는 외부 명령... 아닙니다` | CLI가 PATH에 없습니다. [Cursor CLI 설치](https://cursor.com/docs/cli/installation) 후 `agent --version` 으로 확인하세요. `doctor` 도 동일하게 `--version` 을 호출합니다. 해결되지 않으면 `CURSOR_AGENT_BIN` 에 절대경로를 지정하세요. |
| Unity가 즉시 종료하고 exit code가 0이 아님 | Unity Editor가 같은 프로젝트를 열어 둔 상태면 `Library` 락으로 배치모드가 실패합니다. 에디터를 닫고 실행하세요. 라이선스 미인증도 같은 증상입니다. |
| 매번 "변경된 파일이 하나도 없습니다" 로 실패 | Agent가 파일을 쓰지 못하는 상태입니다. `CURSOR_YOLO=true` 인지, 대상 경로에 쓰기 권한이 있는지 확인하세요. |
| 컴파일 검수가 계속 타임아웃 | 최초 임포트는 오래 걸립니다. Unity Editor로 프로젝트를 한 번 연 뒤 실행하거나 `UNITY_TIMEOUT_MS` 를 늘리세요. |
| 한 Step에서 계속 재시도 후 중단 | Task 단위가 너무 큽니다. `roadmap.json` 의 Step을 더 잘게 나누세요. |
| `agent` 실행 오류: 명령줄이 너무 깁니다. | Windows `cmd.exe` 의 8191자 명령행 상한입니다. `CURSOR_PROMPT_DELIVERY=auto`(기본값)면 stdin으로 자동 우회합니다. 그래도 실패하면 `file` 로 고정하세요 ([4-4](#4-4-프롬프트-전달-방식)). |
| `Git 저장소가 아닙니다` (fatal) | `lint`/`compile`/`full` 은 Git Diff 검수가 필요합니다. 대상 프로젝트에서 `git init` 하거나 `VALIDATION_MODE=skip` 을 사용하세요. |
| `agent` 가 exit code ≠ 0 으로 종료 | Agent 실행 자체 실패로 재시도합니다. CLI 인증(`CURSOR_API_KEY` 또는 [Authentication](https://cursor.com/docs/cli/reference/authentication))·`CURSOR_AGENT_BIN` 경로를 확인하세요. |
| 검수 통과 후 커밋만 반복 실패 | `git` 권한·`.gitignore`·`GIT_AUTHOR_*` 설정을 확인하세요. Step 은 완료되지 않고 재시도됩니다. |
| `status` 가 `paused` 로 멈춤 | `Ctrl+C` 로 중단된 상태입니다. 문제 없으면 `run` 을 다시 실행하면 `currentStepId` 부터 이어집니다. |
| Agent가 Task 지시의 일부만 수행함 | 여러 줄 프롬프트가 명령행에서 잘렸을 수 있습니다. `CURSOR_PROMPT_DELIVERY` 를 `argv` 로 강제하지 마세요. |
| 콘솔 한글이 깨짐 | 실행 시 자동으로 `chcp 65001` 을 적용하지만, 일부 터미널에서는 수동으로 UTF-8 코드페이지를 설정해야 합니다. 로그 파일(`runtime/orchestrator.log`)은 항상 UTF-8입니다. |
| 로그의 오류 메시지가 `����` 로 나옴 | 자식 프로세스가 로컬 코드페이지(한국어 949 등)로 출력한 경우입니다. 현재는 UTF-8 → 콘솔 코드페이지 순으로 디코딩해 복원하므로, 재현되면 이슈로 알려주세요. |

---

## 9. 안전 관련 주의

이 저장소는 **테스트 버전**이며, 아래 항목은 선택이 아닌 필수입니다.

`CURSOR_YOLO=true` 는 Agent의 파일 쓰기와 MCP 도구 호출을 **사람 확인 없이 자동 승인**합니다.
반드시 Git으로 관리되는 프로젝트에서 사용하고, 중요한 작업 전에는 브랜치를 분리하세요.

```powershell
cd D:\UnityProjects\MyGame
git switch -c auto/orchestrator-run
```
