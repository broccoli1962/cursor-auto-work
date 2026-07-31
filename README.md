# cursorAutoWork

> ## ⚠️ 테스트 버전 (Experimental / Test Release)
>
> **이 프로젝트는 실험용 테스트 버전입니다. 프로덕션 환경에서 사용하지 마세요.**
>
> - 실제 운영 중인 프로젝트나 백업이 없는 코드베이스를 대상으로 실행하지 마세요.
> - 기본 설정(`CURSOR_YOLO=true`)에서 Agent가 **사람 확인 없이 파일을 수정하고 자동 커밋**합니다.
> - 검수 파이프라인(컴파일/테스트/Diff)은 아직 충분히 검증되지 않았고, 잘못된 변경을 통과시킬 수 있습니다.
> - CLI 옵션, 환경 변수, `roadmap.json` 스키마는 예고 없이 변경될 수 있습니다.
> - 반드시 **Git으로 관리되는 사본**에서, 별도 브랜치를 만들고 실행하세요.
>
> 사용에 따른 코드 손실이나 예기치 않은 변경에 대한 책임은 사용자에게 있습니다.

Unity 프로젝트를 대상으로 **Cursor Headless CLI(`cursor-agent`)를 무인 제어**하는 Node.js(TypeScript) 오케스트레이터입니다.

기획서(`spec.md`)와 단계별 로드맵(`roadmap.json`)을 읽어 Step 1부터 순차적으로 Agent에게 작업을 지시하고,
Unity Batchmode 컴파일 · EditMode 테스트 · Git Diff 3단계 검수를 통과한 Step만 자동 커밋한 뒤 다음 Step으로 진행합니다.
실패하면 컴파일 에러를 그대로 피드백 프롬프트로 만들어 재지시하고, 재시도 한도를 넘기면 Discord로 사람 개입을 요청합니다.

```
┌─────────────┐   프롬프트    ┌──────────────┐   파일/에디터 조작   ┌──────────────┐
│ Orchestrator│ ───────────▶ │ cursor-agent │ ──────────────────▶ │ Unity Project│
│  (이 저장소) │ ◀─────────── │ (+ UnityMCP) │                     └──────┬───────┘
└──────┬──────┘  NDJSON 스트림 └──────────────┘                            │
       │                                                                   ▼
       │  ① Unity -batchmode 컴파일  ② EditMode 테스트  ③ git diff 검수  ◀─┘
       │
       ├─ 통과 → git commit → 다음 Step (Fresh Context 재시작)
       └─ 실패 → 에러 로그를 피드백 프롬프트로 재지시 (최대 N회) → 초과 시 Discord 🚨
```

---

## 1. 요구 사항

| 항목 | 버전/비고 |
| --- | --- |
| Node.js | 18 이상 (권장 20 LTS) |
| Git | 자동 커밋 기능 사용 시 필수 |
| Unity Editor | 컴파일/테스트 검수 대상 버전 (예: 2022.3 LTS) |
| `cursor-agent` | Cursor Headless CLI. `cursor-agent --version` 으로 확인 |

> `cursor-agent` 는 별도 설치가 필요합니다. 설치 후 `cursor-agent login` 으로 인증을 완료해 두어야
> 오케스트레이터가 비대화형으로 Agent를 구동할 수 있습니다.

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

최소한 다음 두 값은 반드시 지정해야 합니다.

```dotenv
TARGET_PROJECT_PATH=D:\UnityProjects\MyGame
UNITY_PATH=C:\Program Files\Unity\Hub\Editor\2022.3.40f1\Editor\Unity.exe
```

주요 환경 변수:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TARGET_PROJECT_PATH` | `process.cwd()` | 작업 대상 Unity 프로젝트 루트 |
| `UNITY_PATH` | (없음) | Unity.exe 경로. 미설정 시 컴파일 검수를 건너뜀 |
| `CURSOR_AGENT_BIN` | `cursor-agent` | CLI 실행 명령 |
| `CURSOR_MODEL` | (CLI 기본값) | 사용할 모델 |
| `CURSOR_YOLO` | `true` | `--force` 를 붙여 MCP 도구 호출/파일 쓰기를 자동 승인 |
| `DISCORD_WEBHOOK_URL` | (없음) | 미설정 시 알림은 콘솔에만 출력 |
| `SPEC_PATH` / `ROADMAP_PATH` | `./docs/*` | **대상 프로젝트 기준** 상대경로 |
| `STATE_PATH` | `./runtime/state.json` | 진행 상태 저장 위치 |
| `MAX_RETRIES` | `3` | Step 당 최대 재시도 |
| `AGENT_TIMEOUT_MS` | `1800000` | Agent 1회 실행 타임아웃 (30분) |
| `UNITY_TIMEOUT_MS` | `1200000` | Unity 배치모드 타임아웃 (20분) |
| `RUN_UNITY_TESTS` | `false` | EditMode 테스트 전역 기본값 |
| `AUTO_COMMIT` | `true` | 검수 통과 시 자동 커밋 |
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

`task` 만 필수이고 나머지는 선택입니다. `runTests` 는 해당 Step에서만 EditMode 테스트를 강제 실행합니다.

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

---

## 5. 실행

```powershell
# 환경 점검 (Unity, CLI, 규칙, 웹훅 + MCP 서버 실제 접속 확인)
node dist/index.js doctor

# 파이프라인 실행 (완료되지 않은 Step부터 이어서)
node dist/index.js run

# Step 3부터 5까지만 실행
node dist/index.js run --from 3 --to 5

# Agent를 실행하지 않고 조립된 프롬프트만 확인
node dist/index.js run --dry-run --to 1

# 진행 상황 확인
node dist/index.js status
```

CLI 옵션:

| 옵션 | 설명 |
| --- | --- |
| `--project <path>` | `TARGET_PROJECT_PATH` 덮어쓰기 |
| `--from <n>` / `--to <n>` | 실행 범위 지정 |
| `--retries <n>` | 재시도 한도 덮어쓰기 |
| `--tests` | EditMode 테스트 강제 실행 |
| `--no-commit` | 자동 커밋 비활성화 |
| `--dry-run` | 프롬프트 조립만 확인 |
| `--debug` | Agent 스트림 원문까지 출력 |
| `--no-mcp-probe` | MCP 서버 실제 접속 점검 생략 (`doctor`, `run`) |
| `--mcp-timeout <ms>` | MCP 응답 대기 시간 (기본 20000) |

`Ctrl+C` 를 누르면 진행 중인 Step을 마친 뒤 안전하게 종료하며, 진행 상태는 `runtime/state.json` 에 남아 다음 실행에서 이어집니다.

개발 중에는 빌드 없이 실행할 수도 있습니다.

```powershell
npx tsx src/index.ts run --dry-run
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
7. 재시도인 경우 직전 검수 실패 피드백

### 6-2. 검수 파이프라인

| 단계 | 내용 | 실패 시 |
| --- | --- | --- |
| ① 컴파일 | `Unity.exe -batchmode -quit -nographics -projectPath . -logFile Logs/unity_build.log` 실행 후 로그에서 `error CS####` 파싱 | 에러 상위 N개(`MAX_ERROR_LINES`)를 피드백 프롬프트로 구성 |
| ② 테스트 | `-runTests -testPlatform EditMode -testResults Logs/unity_test_results.xml` 후 NUnit XML 파싱 | 실패한 테스트명과 메시지를 피드백에 포함 |
| ③ Git Diff | 변경 파일 수집 + `Debug.Log` / `console.log` / `TODO` / 충돌 마커 정적 검사 | 변경사항이 없거나 컨벤션 위반 시 실패 처리 |

Unity는 컴파일 에러가 있어도 종료 코드 0을 반환하는 경우가 있어, **로그 파싱 결과를 1차 판정 근거**로 사용합니다.

세 단계를 모두 통과하면 `git add . && git commit -m "feat: complete Step N - <title>"` 을 수행하고 다음 Step으로 넘어갑니다.

### 6-3. Discord 알림

| 이벤트 | 색상 |
| --- | --- |
| 🚀 Step 시작 | 블루 |
| 🎮 Unity 검수 진행 중 | 퍼플 |
| ✅ Step 성공 및 커밋 완료 | 그린 |
| ⚠️ 컴파일 에러 발생 및 재수정 지시 | 옐로 |
| 🚨 최대 재시도 초과 (사람 개입 요청) | 레드 |

웹훅 전송 실패는 로그만 남기고 파이프라인을 중단시키지 않습니다.

---

## 7. 프로젝트 구조

```
cursorAutoWork/
├─ src/
│  ├─ index.ts           # CLI 진입점 (run / init / status / doctor)
│  ├─ orchestrator.ts    # 메인 제어 루프, 재시도, 상태 관리
│  ├─ cursorRunner.ts    # cursor-agent spawn, NDJSON 파싱, .cursorrules 수집
│  ├─ mcpProbe.ts        # mcp.json 병합 로딩, MCP 서버 라이브 핸드셰이크 점검
│  ├─ unityValidator.ts  # Unity 배치모드 실행, CS 에러 파싱, NUnit XML 파싱
│  ├─ gitManager.ts      # diff 수집, 컨벤션 정적 검사, 자동 커밋
│  ├─ memoryManager.ts   # Fresh Context 프롬프트 조립, 요약 추출, state.json
│  ├─ notifier.ts        # Discord Webhook Embed 전송
│  ├─ roadmap.ts         # roadmap.json 로딩 및 스키마 검증
│  ├─ config.ts          # 환경 변수 로딩 및 사전 점검
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
| `cursor-agent 실행 실패: spawn ENOENT` | CLI가 PATH에 없음. `CURSOR_AGENT_BIN` 에 절대경로를 지정하세요. |
| Unity가 즉시 종료하고 exit code가 0이 아님 | Unity Editor가 같은 프로젝트를 열어 둔 상태면 `Library` 락으로 배치모드가 실패합니다. 에디터를 닫고 실행하세요. 라이선스 미인증도 같은 증상입니다. |
| 매번 "변경된 파일이 하나도 없습니다" 로 실패 | Agent가 파일을 쓰지 못하는 상태입니다. `CURSOR_YOLO=true` 인지, 대상 경로에 쓰기 권한이 있는지 확인하세요. |
| 컴파일 검수가 계속 타임아웃 | 최초 임포트는 오래 걸립니다. Unity Editor로 프로젝트를 한 번 연 뒤 실행하거나 `UNITY_TIMEOUT_MS` 를 늘리세요. |
| 한 Step에서 계속 재시도 후 중단 | Task 단위가 너무 큽니다. `roadmap.json` 의 Step을 더 잘게 나누세요. |
| 콘솔 한글이 깨짐 | 실행 시 자동으로 `chcp 65001` 을 적용하지만, 일부 터미널에서는 수동으로 UTF-8 코드페이지를 설정해야 합니다. 로그 파일(`runtime/orchestrator.log`)은 항상 UTF-8입니다. |

---

## 9. 안전 관련 주의

이 저장소는 **테스트 버전**이며, 아래 항목은 선택이 아닌 필수입니다.

`CURSOR_YOLO=true` 는 Agent의 파일 쓰기와 MCP 도구 호출을 **사람 확인 없이 자동 승인**합니다.
반드시 Git으로 관리되는 프로젝트에서 사용하고, 중요한 작업 전에는 브랜치를 분리하세요.

```powershell
cd D:\UnityProjects\MyGame
git switch -c auto/orchestrator-run
```
