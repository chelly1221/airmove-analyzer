# NEC ASTERIX 비행검사기 항적분석체계

## 프로젝트 개요
Tauri v2 기반 **Windows Portable** 데스크톱 앱. NEC 레이더 저장자료(ASS 파일, ASTERIX CAT048)를 파싱하여 비행검사기 항적을 분석하고 Loss 구간을 탐지/시각화한다.
**전체 TrackPoint 규모는 10M+(천만 건) 이상** — 모든 데이터 파이프라인은 이 규모를 전제로 설계.

## 기술 스택
- **Frontend**: React 19 + TypeScript 5.8 + Vite 7 + Tailwind 4 + react-router-dom 7
- **Backend**: Rust (Tauri v2), SQLite (db.rs, 21개 테이블)
- **Map**: deck.gl 9.2 + react-map-gl 8 (GPU), MapLibre GL JS 5
- **GPU**: WebGPU 컴퓨트 셰이더 (커버리지/파노라마/도면) + CPU 폴백
- **PDF**: WebView2 PrintToPdf (primary) + html2canvas-pro + jsPDF (폴백)
- **State**: Zustand 5, **Font**: Pretendard Variable

## 빌드 환경 (Windows 필수)

WSL2에서 `cmd.exe`를 통해 Windows 측 도구를 호출하여 빌드.

**필수**: Node.js v20+ (Windows), Rust stable (MSVC), Visual Studio Build Tools 2022 (C++ 워크로드), WebView2

```bash
# node_modules는 반드시 Windows 측에서 설치 (WSL에서 설치하면 네이티브 바인딩 깨짐)
rm -rf node_modules
cmd.exe /c "cd /d C:\code\airmove-analyzer && npm install"

# 빌드
cmd.exe /c "set PATH=%USERPROFILE%\.cargo\bin;C:\nvm4w\nodejs;%PATH% && cd /d C:\code\airmove-analyzer && npx tauri build"
```

**주의**: WSL `npm install` → Linux 바인딩 설치 → Windows 빌드 깨짐. 반드시 `node_modules` 삭제 후 Windows에서 재설치.

## 핵심 아키텍처

### 멀티 윈도우
`main.tsx`에서 Tauri 윈도우 라벨로 분기: `"main"` → App.tsx, `"trackmap"` → TrackMapApp.tsx, `"drawing"` → DrawingApp.tsx

### 비행(Flight) 기반 분석
분석 단위는 파일이 아닌 **비행(Flight)**. 데이터 흐름:
1. ASS 파싱 → DB 저장 + `radar_name` 태깅
2. `sendPointsToWorker()` → Worker에 전송 (메인에 축적 안 함)
3. `startConsolidate()` → Worker에서 mode_s+radar_name 그룹핑 + gap 분리
4. Worker가 `FLIGHT_CHUNK`로 1개씩 스트리밍 → `appendFlights()` → UI 즉시 반영
5. 각 페이지에서 `queryViewportPoints()`로 Worker에 포인트 쿼리 (포인트는 Worker 소유)

### 앱 재시작 복원
App.tsx `useRestoreSettings()`: DB에서 설정/LOS/보고서/커버리지 복원. 진행률 5단계: loading→history→grouping→building→done

## 도메인 지식

### NEC ASS 파일 포맷 (ASTERIX CAT048)
- NEC 프레임 헤더: `[월][일][시][분]` 4바이트 + 카운터 1바이트
- CAT048 (0x30): I020(radar_type 6종 + 유령표적 제거), I040(극좌표→WGS84), I090(고도), I140(UTC초), I200(속도/방위), I220(Mode-S)
- 자정 보정: prev_tod > 70000 && curr_tod < 16000 → +86400s
- 유효 범위: lat 25-50°, lon 115-145° (동아시아)

### Loss 탐지 알고리즘
- 스캔 주기 자동 추정 (중앙값), 기본 임계값 7.0초
- **signal_loss**: 일반 표적소실
- **out_of_range**: 양끝 ≥ 최대범위 88%, 또는 15연속 미탐지 + 경계 이상
- 최대 범위: 전체 거리의 95% 백분위수
- 제외: 6시간 초과 gap, 0.5초 미만 gap

### LOS 분석 (4/3 유효지구 모델)
- 실제 지구(R=6,371km) 디스플레이 프레임에서 4/3 유효지구(R_eff=8,495km) 굴절 경로 표시
- `curvDrop(d) = d²/(2R)`, `curvDrop43(d) = d²/(2R_eff)`
- 4/3 굴절선 디스플레이 변환: `h43 + curvDrop43(d) - curvDrop(d)`
- 차단 판정은 4/3 프레임에서 수행
- 고도: SRTM HGT (로컬), 산 이름: peak DB (N3P SHP, 오프라인)

### 좌표 변환 (coord.rs)
- **EPSG:5186** → WGS84: 중앙자오선 127°E (건물통합정보, 토지이용)
- **EPSG:5179** → WGS84: 중앙자오선 127.5°E (N3P 산봉우리)

### 커버리지 맵
- 2단계: Phase 1 SRTM+건물 프로파일(1회) → Phase 2 고도별 이진 탐색 O(log N)
- 건물 필터: 10km 이내 10m+, 10-30km 30m+, 30km+ 60m+
- WebGPU 0.01° 고해상도 36,000 레이, CPU 폴백

## 아키텍처 원칙: 스트리밍 우선

**10M+ 포인트를 다루는 모든 파이프라인은 스트리밍 방식으로 구현한다.**

10M TrackPoint ≈ 2.5GB. 메인 스레드 축적 시 OOM.

### 필수 규칙
1. **메인 스레드에 대량 데이터 축적 금지** — DB 로드 즉시 Worker 전송, 로컬 참조 해제
2. **Worker 내부 async + yield** — `await setTimeout(0)`으로 이벤트 루프 양보
3. **결과도 청크 스트리밍** — 단위별(비행, 레이어) 청크 전송
4. **store 점진 업데이트** — `appendFlights()` 사용, 전체 `setFlights()` 금지
5. **처리 완료 그룹 즉시 해제** — Worker Map에서 `delete` → GC
6. **spread 금지 (대량)** — `push(...bigArray)` 대신 `for` 루프. 10M+에서 스택 오버플로우
7. **다운샘플링/stride 샘플링 절대 금지** — 렌더링 포함 모든 파이프라인에서 **전수 포인트** 사용. 누락 시 Loss 탐지/통계 정확도 훼손

### 기존 Worker 참고
- `src/workers/flightConsolidation.worker.ts` — 비행 통합 + 뷰포트 쿼리
- `src/workers/coverageBuilder.worker.ts` — 커버리지 맵 빌드
- `src/utils/flightConsolidationWorker.ts` — Worker 래퍼 (콜백 스트리밍 패턴)

## 코딩 컨벤션
- Rust: snake_case, Result/Option 에러 핸들링
- TypeScript: camelCase, 컴포넌트 PascalCase
- CSS: Tailwind utility-first
- 한글 주석
- 색상: #ffffff(배경), #f8f9fa(카드), #a60739(액센트), #e94560(에러)
