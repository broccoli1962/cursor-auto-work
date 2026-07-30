# [샘플] 프로젝트 기획서

> 이 파일은 오케스트레이터 저장소에 포함된 **예시**입니다.
> 실제 사용 시에는 `TARGET_PROJECT_PATH/docs/spec.md` 에 대상 Unity 프로젝트의 기획서를 작성하세요.
> (`cursor-auto-work init` 명령으로 템플릿을 생성할 수 있습니다.)

## 1. 개요
- 프로젝트명: Sample Roguelike
- 장르 / 플랫폼: 2D 로그라이크 / PC (Windows)
- 한 줄 설명: 절차적으로 생성되는 던전을 탐험하며 성장하는 싱글플레이 로그라이크.

## 2. 핵심 게임플레이
- 플레이어는 방 단위로 구성된 던전을 이동하며 적을 처치한다.
- 각 층 클리어 시 3개의 강화 카드 중 하나를 선택한다.
- 사망 시 런이 종료되고 메타 재화를 획득한다.

## 3. 기술 스택 및 아키텍처
- Unity 버전: 2022.3 LTS
- 아키텍처 패턴: MVP (Model - View - Presenter)
- 비동기 처리: UniTask (코루틴 사용 금지)
- 리소스 로딩: Addressables (Resources.Load 사용 금지)
- 의존성 주입: 생성자 주입 기반 수동 DI

## 4. 폴더 구조 규약
```
Assets/
  Scripts/
    Core/        # 공통 유틸, 상수, 이벤트 버스
    Gameplay/    # 전투, 던전 생성, 플레이어
    UI/          # MVP View/Presenter
  Prefabs/
  Addressables/
```

## 5. 코드 컨벤션
- 클래스/메서드: PascalCase, 지역변수/파라미터: camelCase, private 필드: `_camelCase`
- `Debug.Log` 직접 호출 금지 (`Core/Logging/GameLogger` 사용)
- MonoBehaviour 는 View 계층에서만 사용하며 비즈니스 로직을 포함하지 않는다.

## 6. 완료 기준
- Unity 배치모드 컴파일 시 에러 0건.
- EditMode 테스트 전부 통과.
- 기획서에 명시된 모든 Step 이 커밋 이력에 존재.
