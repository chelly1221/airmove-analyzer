# NEC ASTERIX 비행검사기 항적분석체계

## 프로젝트 개요
Tauri 기반 **Windows Portable** 데스크톱 애플리케이션으로, NEC 레이더 저장자료(NEC ASS 파일)를 파싱하여 비행검사기의 항적을 분석하고, 항적 Loss 구간을 탐지/시각화하는 특화 분석 도구. **전체 TrackPoint 규모는 10M+(천만 건) 이상**이므로, 모든 데이터 파이프라인은 이 규모를 전제로 설계해야 한다.

## 배포 형태
- **Windows Portable EXE** (설치 불필요, 단일 실행파일)
- 빌드 결과물: `src-tauri/target/release/airmove-analyzer.exe`
- NSIS 인스톨러도 생성됨: `src-tauri/target/release/bundle/nsis/`

## 빌드 환경 (Windows 필수)

Tauri v2 Windows 빌드이므로 **Windows 환경에서** 아래 도구들이 설치되어 있어야 함.
WSL2에서 `cmd.exe`를 통해 Windows 측 도구를 호출하여 빌드 가능.

### 필수 설치 항목
1. **Node.js** (v20+) — Windows 네이티브 설치 (nvm4w 또는 공식 설치파일)
   - `npm`, `npx` 명령이 Windows PATH에 있어야 함
2. **Rust** (stable) — `rustup-init.exe`로 설치 (https://rustup.rs)
   - 기본 타겟: `stable-x86_64-pc-windows-msvc`
   - PATH: `%USERPROFILE%\.cargo\bin`
3. **Visual Studio Build Tools 2022** — C++ 워크로드 필수
   - https://visualstudio.microsoft.com/ko/visual-cpp-build-tools/
   - 설치 시 **"C++를 사용한 데스크톱 개발"** 워크로드 체크
   - MSVC 링커(`link.exe`)가 없으면 Rust 컴파일 실패
4. **WebView2 Runtime** — Windows 10/11에 기본 포함, 없으면 MS에서 설치

### WSL2에서 빌드하는 방법
```bash
# node_modules는 반드시 Windows 측에서 설치 (WSL에서 설치하면 네이티브 바인딩 깨짐)
rm -rf node_modules  # WSL 측 node_modules 있으면 제거
cmd.exe /c "cd /d C:\code\airmove-analyzer && npm install"

# 빌드 (Windows PATH에 cargo, npm 포함 필요)
cmd.exe /c "set PATH=%USERPROFILE%\.cargo\bin;C:\nvm4w\nodejs;%PATH% && cd /d C:\code\airmove-analyzer && npx tauri build"
```

### 주의사항
- WSL에서 `npm install`하면 Linux용 네이티브 바인딩이 설치되어 Windows 빌드 시 `@tauri-apps/cli` 등이 깨짐
- sharp 등 네이티브 패키지를 WSL에서 설치한 후에는 반드시 `node_modules` 삭제 후 Windows에서 재설치
- `cmd.exe`를 통한 빌드 시 PATH에 cargo 경로를 명시적으로 추가해야 함

## 기술 스택
- **Frontend**: React 19 + TypeScript 5.8 + Vite 7 + Tailwind 4 + react-router-dom 7
- **Backend**: Rust (Tauri v2)
- **Map**: deck.gl 9.2 + react-map-gl 8 (GPU 가속), MapLibre GL JS 5 (동심원/라벨)
- **PDF**: WebView2 PrintToPdf (primary, CDP 네이티브) + html2canvas-pro 2.0 + jsPDF 2.5 (폴백)
- **File Dialog**: @tauri-apps/plugin-dialog, @tauri-apps/plugin-fs, @tauri-apps/plugin-opener
- **State**: Zustand 5
- **Icons**: lucide-react
- **Date**: date-fns 4
- **GIS**: shapefile 크레이트 (SHP 파싱), EPSG:5186/5179→WGS84 좌표 변환, wmm 크레이트 (자기편각)
- **Font**: Pretendard Variable (public/fonts/)

## 앱 아키텍처: 멀티 윈도우
- **main.tsx**가 Tauri 윈도우 라벨(`getCurrentWebviewWindow().label`)로 분기:
  - `"main"` → `App.tsx` (기본 앱: 자료관리/분석/보고서/설정)
  - `"trackmap"` → `TrackMapApp.tsx` (별도 윈도우: 3D 항적 지도)
  - `"drawing"` → `DrawingApp.tsx` (별도 윈도우: 2D 도면/측면도)
- Sidebar에서 지도/도면 클릭 시 `new WebviewWindow(label, {width:1400, height:900})`로 별도 윈도우 생성
- 메인 윈도우 종료 시 모든 자식 윈도우 자동 정리 (`useCloseAllOnExit`)

## 프로젝트 구조
```
src/                    # React frontend
  ├── App.tsx           # 라우터 + TrackMap 항상 마운트 + 앱 시작 시 설정/LOS/보고서 복원
  ├── main.tsx          # React entry point (윈도우 라벨 분기: main/trackmap/drawing)
  ├── index.css         # 전역 CSS (화이트 테마 + #a60739 액센트, Leaflet/MapLibre 오버라이드)
  ├── apps/
  │   ├── DrawingApp.tsx    # 별도 윈도우용 그리기 앱 래퍼
  │   └── TrackMapApp.tsx   # 별도 윈도우용 항적 지도 앱 래퍼
  ├── dev/
  │   ├── SourceOverlay.tsx         # 개발 모드 우클릭 소스 파일:줄번호 표시 오버레이
  │   └── babelPluginSourceAttrs.ts # Babel 플러그인: JSX에 data-source 속성 자동 주입
  ├── pages/
  │   ├── AircraftManagement.tsx  # 비행검사기 관리 (최대 10대)
  │   ├── Drawing.tsx             # 그리기 도구 + 수동 건물 등록 도형 (DrawingApp 윈도우에서 사용)
  │   ├── FileUpload.tsx          # NEC ASS 파일 업로드/파싱 (배치 지원, Mode-S/Squawk 필터)
  │   ├── LossAnalysis.tsx        # 표적소실 분석 (테이블/비행별/비교 뷰)
  │   ├── LoSObstacle.tsx         # 360° LoS 파노라마 & 장애물 분석 (deck.gl 시각화)
  │   ├── RadarManagement.tsx     # 레이더 사이트 관리 (추가/편집/삭제, 맵 좌표 선택)
  │   ├── ReportGeneration.tsx    # PDF 보고서 (설정→미리보기 2단계, 섹션 토글)
  │   ├── Settings.tsx            # 설정 + DB 내보내기/가져오기 + GIS 데이터 임포트 + SRTM 다운로드
  │   └── TrackMap.tsx            # 항적 지도 (deck.gl GPU 렌더링, 커버리지 오버레이)
  ├── components/
  │   ├── Layout/
  │   │   ├── Sidebar.tsx         # 사이드바 네비게이션 (w-48, 파노라마 패널, 보고서 메타데이터 패널, 백그라운드 작업 패널)
  │   │   └── Titlebar.tsx        # Tauri 커스텀 타이틀바 (드래그/창 컨트롤)
  │   ├── Map/
  │   │   ├── DeckGLOverlay.tsx     # deck.gl ↔ MapLibre 통합 (MapboxOverlay)
  │   │   ├── ImagePositioner.tsx   # 도면 이미지 오버레이 (위치/회전/투명도 조절, MapLibre 소스 연동)
  │   │   └── LoSProfilePanel.tsx   # LOS 단면도 (SVG 차트, 크로스헤어+포인트 핀+건물 클릭/호버+상세보기 모달, 맵/차트 스크린샷 캡처)
  │   ├── BuildingGroupPanel.tsx  # 건물 그룹 관리 사이드 패널 (그룹 CRUD, 도면 오버레이, 토글)
  │   ├── Report/
  │   │   ├── EditableText.tsx                   # contentEditable 인라인 텍스트 편집
  │   │   ├── ReportAircraftSection.tsx          # 비행검사기 현황 테이블
  │   │   ├── ReportCoverPage.tsx                # 표지 (문서번호/시행일자/레이더명, 인라인 편집)
  │   │   ├── ReportFlightComparisonSection.tsx  # 비행별 비교 분석
  │   │   ├── ReportFlightLossAnalysisSection.tsx # 비행별 Loss 상세 분석
  │   │   ├── ReportFlightProfileSection.tsx     # 비행 프로파일 섹션
  │   │   ├── ReportLoSSection.tsx               # LOS 분석 결과 테이블
  │   │   ├── ReportLossSection.tsx              # 표적소실 구간 상세 테이블
  │   │   ├── ReportMapSection.tsx               # 항적 지도 캡처 이미지
  │   │   ├── ReportOMAltitudeDistribution.tsx   # 장애물월간: Loss 고도 분포 히스토그램
  │   │   ├── ReportOMAzDistScatter.tsx          # 장애물월간: 방위별 거리/고도 산점도 (SVG 극좌표 차트)
  │   │   ├── ReportOMBuildingLoS.tsx            # 장애물월간: 건물 LOS 차단 vs 표적고도
  │   │   ├── ReportOMCoverageDiff.tsx           # 장애물월간: 커버리지 비교 (건물 유/무)
  │   │   ├── ReportOMDailyChart.tsx             # 장애물월간: 일별 PSR/Loss 추이 차트
  │   │   ├── ReportOMFindings.tsx               # 장애물월간: 분석 소견 (서술형)
  │   │   ├── ReportOMLossEvents.tsx             # 장애물월간: Loss 이벤트 상세 테이블
  │   │   ├── ReportOMSummarySection.tsx         # 장애물월간: 대상 장애물 요약 테이블
  │   │   ├── ReportOMWeeklyChart.tsx            # 장애물월간: 주간 집계 차트
  │   │   ├── ReportPage.tsx                     # A4 페이지 래퍼 (210×297mm)
  │   │   ├── ReportPanoramaSection.tsx          # 360° 파노라마 장애물 분석 (SVG 차트+8방위 요약+건물 목록)
  │   │   ├── ReportPSAdditionalLoss.tsx         # 사전검토: 추가 표적소실 분석 상세 테이블
  │   │   ├── ReportPSAngleHeight.tsx            # 사전검토: 지형 앙각 및 건축가능 높이 분석
  │   │   ├── ReportPSSummarySection.tsx         # 사전검토: 대상 건물 요약 섹션
  │   │   ├── ReportStatsSection.tsx             # 분석 통계 (추이 차트+비행별 막대 차트)
  │   │   ├── ReportSummarySection.tsx           # 요약 (KPI 그리드, 종합 판정, 분석 소견)
  │   │   └── useReportExport.ts                 # PDF 내보내기 훅 (WebView2 PrintToPdf primary + html2canvas 폴백)
  │   └── common/
  │       ├── Card.tsx              # 통계 카드 + SimpleCard
  │       ├── DataTable.tsx         # 범용 데이터 테이블 (정렬, 선택 행 강조)
  │       ├── Dropdown.tsx          # 재사용 드롭다운 (키보드 내비게이션, 구분선)
  │       ├── EmptyState.tsx        # 빈 상태 플레이스홀더 (아이콘+메시지+액션 버튼)
  │       ├── Modal.tsx             # 모달 컴포넌트
  │       ├── MonthPicker.tsx       # 월 선택기 (YYYY-MM)
  │       ├── ParseFilterModal.tsx  # 파싱 필터 모달 (Mode-S/Squawk 코드 필터, AND/OR 로직)
  │       └── Toast.tsx             # 토스트 알림 (error/warning/success/info, 자동 소멸)
  ├── utils/
  │   ├── altitudeCorrection.ts       # 이상고도 보정 (수직속도 기반 + 선형 보간)
  │   ├── buildingTileCache.ts        # 뷰포트 기반 건물 타일 캐시 (줌 인지, progressive 로딩, Float64 바이너리 IPC)
  │   ├── flightConsolidation.ts      # 비행 통합 로직 (gap 분리 + 수동 병합)
  │   ├── flightConsolidationWorker.ts # Worker 래퍼 (콜백 스트리밍 + 진행률 콜백 + 뷰포트 쿼리)
  │   ├── gpu2d.ts                    # WebGL2 GPU 가속 2D 렌더링 (LOS 프로파일, 타임라인)
  │   ├── gpuCompute.ts               # WebGPU 디바이스 싱글턴 + 범용 컴퓨트 셰이더 실행
  │   ├── gpuCoverage.ts              # WebGPU 커버리지 맵 (0.01° 고해상도, 36000 레이)
  │   ├── gpuDrawingCompute.ts        # WebGPU 도면 타임라인 (최대거리/EW변환/밀도히스토그램)
  │   ├── gpuPanorama.ts              # WebGPU 360° 파노라마 앙각 계산 가속
  │   ├── lossDetection.ts            # Loss 탐지 (TypeScript 구현, 개별 LossPoint 생성)
  │   ├── omFindingsGenerator.ts      # 장애물 월간 분석 소견 자동 생성 (Haversine 거리, 등급 판정, 선형 회귀 추세)
  │   ├── omStats.ts                  # 장애물 월간 통계 유틸 (가중 평균/표준편차, 신뢰도 기반 등급)
  │   ├── planOverlay.ts              # MapLibre 도면 이미지 오버레이 (추가/제거/투명도/회전)
  │   └── radarCoverage.ts            # 레이더 커버리지 맵 (다중 고도 레이어, GeoJSON 변환)
  ├── workers/
  │   ├── flightConsolidation.worker.ts  # 비행 통합 Worker (포인트 소유, 비행 빌드, 뷰포트 쿼리, 진행률 보고)
  │   └── coverageBuilder.worker.ts      # 커버리지 맵 Worker (레이어 빌드, GeoJSON 폴리곤 생성, progressive rendering)
  ├── store/
  │   └── index.ts      # Zustand 전역 상태
  └── types/
      ├── index.ts          # TypeScript 인터페이스 정의 (re-export hub)
      ├── aircraft.ts       # 항공기 타입 (Aircraft)
      ├── building.ts       # 건물 타입 (ManualBuilding, BuildingGroup, BuildingOnPath, Building3D, NearbyPeak)
      ├── flight.ts         # 비행 타입 (Flight, ManualMergeRecord)
      ├── landuse.ts        # 토지이용 타입 (LandUseZone, LandUseImportStatus)
      ├── los.ts            # LOS 타입 (LoSProfileData, ElevationPoint, LineOfSightResult)
      ├── loss.ts           # Loss 타입 (LossSegment, LossPoint)
      ├── obstacle.ts       # 장애물 월간 타입 (AzSector, RadarFileSet, DailyStats, RadarMonthlyResult)
      ├── panorama.ts       # 파노라마 타입 (PanoramaPoint)
      ├── parse.ts          # 파싱 타입 (ParseStatistics, ParsedFile, AnalysisResult)
      ├── prescreening.ts   # 사전검토 타입 (ProposedBuilding, PreScreeningResult, AdditionalLossEvent)
      ├── radar.ts          # 레이더 타입 (RadarSite)
      ├── report.ts         # 보고서 타입 (ReportMetadata, SavedReportSummary, SavedReportDetail)
      ├── track.ts          # 항적 타입 (TrackPoint)
      └── ui.ts             # UI 타입 (PageId, UploadedFile)
src-tauri/src/          # Rust backend
  ├── lib.rs            # Tauri entry point + IPC commands (89개)
  ├── main.rs           # WebView2 GPU 가속 강제 플래그 설정
  ├── db.rs             # SQLite 데이터베이스 (21개 테이블, 설정/캐시/건물/GIS 영속화)
  ├── building.rs       # LOS 경로 건물 쿼리 + 수동 건물 CRUD + 3D 건물 쿼리
  ├── coord.rs          # EPSG:5186(Korea 2000 Central Belt) + EPSG:5179(Unified) → WGS84, ECEF→WGS84
  ├── declination.rs    # 자기편각 캐시 (NOAA API + WMM 오프라인 폴백)
  ├── fac_building.rs   # 건물통합정보(F_FAC_BUILDING) SHP 임포트 (상세 폴리곤, 높이, 3D 쿼리)
  ├── geo.rs            # 공통 지리 유틸리티 (Haversine 거리, 방위각, 목표점 계산)
  ├── landuse.rs        # 토지이용계획정보 SHP/CSV 임포트 (용도지역 폴리곤, 뷰포트 쿼리)
  ├── peak.rs           # 산봉우리 지명 DB (N3P SHP, EPSG:5179, Overpass API 대체 오프라인 조회)
  ├── srtm.rs           # SRTM HGT 1-arcsecond (30m) 타일 읽기 + 바이리니어 보간 + DB/파일 듀얼 저장
  ├── vworld.rs         # vWorld.kr 자동 로그인 + GIS 데이터 자동 다운로드 (건물/토지이용/N3P)
  ├── parser/
  │   ├── mod.rs
  │   └── ass.rs        # ASTERIX CAT048 파싱 (NEC 프레임 + FSPEC + 유령표적 제거 + Mode-S/Squawk 필터)
  ├── analysis/
  │   ├── mod.rs
  │   ├── coverage.rs       # GPU 커버리지 프리샘플 + 이진 탐색 LOS 엔진 (건물 제외 옵션)
  │   ├── loss.rs           # Loss 탐지 (자동 임계값 + signal_loss/out_of_range + LossPoint)
  │   ├── los.rs            # Line of Sight (4/3 유효지구반경 모델)
  │   ├── obstacle_monthly.rs  # 장애물 월간 분석 (방위 섹터별 PSR/Loss 일별 집계)
  │   ├── panorama.rs       # 360° LoS 파노라마 (지형+건물 통합 스캔)
  │   └── pre_screening.rs  # 장애물 전파영향 사전검토 (제안 건물의 레이더 영향 분석)
  └── models/
      └── mod.rs        # 데이터 모델 (serde 직렬화)
src-tauri/icons/        # 앱 아이콘 (icon.ico, icon.png, 각종 크기)
public/                 # 정적 자산
  ├── radar-icon.png    # 레이더 아이콘 (맵 표시용)
  ├── building-icon.png # 건물 아이콘 (LOS 건물 하이라이트용)
  ├── airplane-icon.png # 항공기 아이콘 (맵 표시용)
  ├── fonts/
  │   └── PretendardVariable.woff2  # Pretendard 가변 폰트
  └── favicon.svg       # 파비콘
```

## 핵심 기능
1. 비행검사기 관리 (최대 10대, Mode-S 코드, 등록번호, DB 영속화)
2. NEC ASS 파일 파싱 (ASTERIX CAT048 바이너리, 배치 병렬 파싱 with rayon, 유령표적 자동 제거, Mode-S/Squawk 필터)
3. 항적 시각화 (deck.gl GPU 렌더링, 탐지 유형별 색상 분리)
4. Loss 구간 자동 탐지 (Signal Loss만 표시, 범위이탈 분리 분류, 개별 LossPoint 추적)
5. 레이더 사이트 관리 (좌표/고도/안테나높이/지원범위NM, 전용 관리 페이지, DB 영속화)
6. 레이더 동심원 표시 (20NM 간격, 200NM까지, MapLibre 네이티브 레이어)
7. 검색 가능한 Mode-S 드롭다운 필터 + UNKNOWN/소수 항적 자동 제외
8. LOS 분석 (SVG 단면도: 지형+건물+실제지구곡률+4/3굴절 모델+산 이름, 크로스헤어+포인트 핀)
9. 항적 지도 상태 유지 (App.tsx에서 항상 마운트, offscreen 토글)
10. GPU 상태 뱃지 (실제 WebGL 렌더러 감지, HW/SW 표시)
11. PDF 보고서 (WebView2 PrintToPdf primary, html2canvas 폴백, 섹션 토글, 인라인 텍스트 편집)
12. 재생/구간 컨트롤 (실시간 배속 재생, 구간 선택 드래그)
13. 3D 지형 (AWS Terrarium DEM, 음영기복도, 고도 배율 조절)
14. Dot 모드 (개별 표적 점+수직선 시각화)
15. 구조화된 호버 툴팁 (항적/Loss/레이더에 다중행 정보 표시)
16. 도면/측면도 그리기 도구 (거리 축 라벨, 수동 건물 도형 등록, 타원 지오메트리 지원, 타임라인 스크롤 줌)
18. 비행 통합 (gap 분리 + 수동 병합, 분석 단위를 파일→비행으로 전환)
19. 파싱 데이터 DB 영속화 (앱 재시작 시 자동 복원)
20. DB 내보내기/가져오기 (전체 데이터 이식)
21. LOS↔지도 양방향 연동 (단면도 포인트 클릭→지도 하이라이트)
22. 레이더 커버리지 맵 (다중 고도 레이어, 지형 프로파일 캐시 기반 빠른 계산, Cone of Silence)
23. LOS 스크린샷 캡처 (맵 JPEG + 차트 PNG, DB 영속화, 보고서 재활용)
26. GIS 건물통합정보 임포트 (F_FAC_BUILDING SHP, EPSG:5186→WGS84, 3D 폴리곤 지원)
27. 수동 건물 관리 (점/사각형/타원/선 도형, CRUD, 그룹 관리, LOS 분석 반영, 도형 지오메트리 샘플링)
28. SRTM 고도 데이터 (1-arcsecond 30m 해상도, 한국 영역 타일 다운로드/캐시)
29. 360° LoS 파노라마 (방위별 최대 앙각 장애물 탐색, 지형+건물 통합)
30. 이상고도 보정 (수직속도 기반 탐지 + 선형 보간)
31. 파노라마 캐시 (계산 결과 DB 영속화, 보고서 생성 시 재활용)
32. 다중 레이더 필터링 (TrackPoint/Flight에 radar_name 태깅, 선택 레이더별 데이터 분리 표시)
33. LOS 맵↔차트 양방향 포인트 클릭+호버 (맵에서 항적 포인트 클릭→차트 핀 동기화, 호버→차트 하이라이트, 차트 핀/호버→맵 하이라이트)
34. 커버리지 동심 링 시각화 (다중 고도 범위 시 겹침 없는 스펙트럼 링 방식)
35. 도면 타임라인 줌 (스크롤 휠로 시간축 확대/축소, 마우스 위치 기준 줌, 구간 핸들 줌 연동)
36. 파노라마 맵 건물 호버 (ScatterplotLayer onHover→파노라마 차트 건물 하이라이트 연동)
37. LOS 단면도 빈 영역 클릭 재생성 (프로파일 표시 중 빈 맵 클릭→새 좌표로 LOS 재생성)
38. LOS 건물↔맵 양방향 하이라이트 (차트 건물 호버/클릭→맵 노란 마커, 건물 오버레이 비활성 상태에서도 표시)
39. 건물 상세보기 사이드바 (LOS 차트 건물 클릭→상세보기 링크→Google Street View+위성지도 사이드 패널)
40. 커버리지 계산 이진 탐색 최적화 (LOS 차단점 O(log N), bearingStep 해상도 조절)
41. 커버리지 맵 단일 레이어 통합 (다중 PolygonLayer→단일 PolygonLayer, GPU 오버헤드 감소)
42. LOS 맵 스크린샷 개선 (MapLibre triggerRepaint + deck.gl 오버레이 합성)
43. LOS 건물 하이라이트 아이콘 (ScatterplotLayer→IconLayer 건물 아이콘 마커)
44. 스트리밍 데이터 복원 (파일 메타 선로드→파일별 포인트 분할 로드, 대용량 DB 복원 시 UI 프리징 방지)
45. SRTM DB 저장 (HGT 타일 SQLite BLOB 저장, DB 우선 로드 + 파일 폴백, 자동 마이그레이션)
46. 건물 그룹 관리 (그룹 CRUD, 색상/메모, 도면 이미지 오버레이, 수동 건물 그룹 배정)
47. 건물 데이터 일괄 임포트 (다중 ZIP 선택, 파일명 행정구역코드 자동 감지, 순차 임포트)
48. GIS 건물 높이 교차검증 (층수 기반 높이 선택, 이웃 비교 이상치 자동 제거)
49. 비동기 항적 렌더링 (대량 포인트 처리 시 UI 양보, 1M+ 포인트 비동기 전환)
50. 파노라마 차트 지형/건물 분리 렌더링 (지형 실루엣 + 건물 세로선 + 통합 외곽선 3레이어)
51. 장애물 월간 분석 보고서 (방위 섹터별 PSR 탐지율/Loss율 일별 집계, 다중 레이더 병렬 분석)
52. WebGPU 컴퓨트 셰이더 (커버리지 0.01° 고해상도, 파노라마 앙각, 도면 거리/밀도 계산, CPU 폴백)
53. 커버리지 비교 분석 (건물 유/무 커버리지 차이 시각화, 장애물 영향 정량화)
54. GPU 프리샘플링 파이프라인 (Rust SRTM+건물 프리샘플 → base64 전송 → WebGPU/Worker 병렬 계산)
55. 개발 모드 소스 오버레이 (우클릭→소스 파일:줄번호 표시, Babel 플러그인 자동 주입)
56. 장애물 월간 보고서 10개 섹션 (요약/일별PSR/일별Loss/주간/방위산점도/커버리지비교/건물LOS/고도분포/Loss이벤트/소견)
57. 비행 통합 진행률 표시 (DB복원/파싱 시 5단계 progress bar: loading→history→grouping→building→done)
58. 항적 progressive rendering (대량 포인트 50K마다 중간 렌더링, mode_s별 timestamp 정렬로 세그먼트 무결성 보장)
59. 장애물 전파영향 사전검토 (제안 건물의 레이더 LOS 차단 분석, 최대 건축가능 높이 산출, 추가 Loss 예측)
60. vWorld GIS 데이터 자동 다운로드 (건물통합정보/토지이용계획/N3P 산봉우리, 자동 로그인+지역코드 필터)
61. 산봉우리 지명 오프라인 DB (연속수치지형도 N3P SHP, Overpass API 대체, 밀리초 단위 조회)
62. 토지이용계획정보 (용도지역 폴리곤 임포트, 맵 오버레이, 뷰포트 쿼리)
63. 자기편각 관리 (NOAA API + WMM 오프라인 폴백, DB 캐시)
64. 멀티 윈도우 (main/trackmap/drawing 별도 Tauri 윈도우, 자동 정리)
65. 보고서 저장/관리 (PDF + 설정 DB 영속화, 목록/상세 조회/삭제)
66. LOS/커버리지 결과 캐시 (DB 영속화, 무효화 검증)
67. 사전검토 보고서 3개 섹션 (요약/앙각·높이분석/추가Loss 상세)

## 핵심 아키텍처: 비행(Flight) 기반 분석
분석 단위가 "파싱 파일(`AnalysisResult`)"에서 "**비행(`Flight`)**"으로 전환됨.

### 데이터 흐름
1. ASS 파일 파싱 → DB 자동 저장 + 포인트에 `radar_name` 태깅
2. 포인트를 `sendPointsToWorker()`로 Worker에 전송 (메인 스레드에 축적하지 않음)
3. `startConsolidate()` → Worker에서 mode_s+radar_name 그룹핑 + gap 분리
4. Worker가 비행 1개씩 `FLIGHT_CHUNK`로 스트리밍 → `appendFlights()` → UI 즉시 반영
5. 각 페이지에서 `queryViewportPoints()`로 Worker에 포인트 쿼리 (포인트는 Worker가 소유)
6. 각 페이지에서 `radarSite.name`으로 필터링하여 선택 레이더 데이터만 표시

### 앱 재시작 복원
- App.tsx `useRestoreSettings()`: DB에서 항공기 + 레이더 설정 + LOS 결과 + 저장 보고서 + 커버리지 캐시 복원
- **진행률 표시**: 복원 시작부터 `consolidationProgress` 상태로 5단계 진행률 (loading→history→grouping→building→done)

## Tauri IPC 명령
| 명령 | 설명 |
|------|------|
| **파싱/분석** | |
| `parse_ass_file` | 단일 ASS 파일 파싱 |
| `analyze_tracks` | 파싱 결과로 Loss 분석 |
| `parse_and_analyze` | 파싱+분석 통합 (DB 자동 저장) |
| `parse_and_analyze_batch` | 배치 병렬 파싱 (rayon, 이벤트 스트리밍, DB 자동 저장) |
| `analyze_obstacle_monthly` | 다중 레이더 장애물 월간 분석 (방위 섹터별 PSR/Loss 일별 집계) |
| `analyze_pre_screening` | 장애물 전파영향 사전검토 (제안 건물의 레이더 영향 분석) |
| **항공기** | |
| `get_aircraft_list` | 저장된 항공기 목록 |
| `save_aircraft` | 항공기 추가/수정 |
| `delete_aircraft` | 항공기 삭제 |
| `filter_tracks_by_mode_s` | Mode-S 필터링 |
| **파일 I/O** | |
| `read_file_base64` | 파일 base64 읽기 (폰트 로딩용) |
| `write_file_base64` | base64 데이터를 파일로 저장 (PDF 저장용) |
| `webview_print_to_pdf` | WebView2 네이티브 PDF 생성 (CDP Page.printToPdf) |
| **데이터 관리** | |
| `load_setting` / `save_setting` | Key-Value 설정 로드/저장 |
| `export_database` | DB 파일을 지정 경로로 내보내기 (WAL 체크포인트 후 복사) |
| `import_database` | 외부 DB 파일로 교체 (SQLite 매직 바이트 검증 후 재연결) |
| **LOS 결과 영속화** | |
| `save_los_result` | LOS 분석 결과 저장 |
| `load_los_results` | 저장된 LOS 결과 목록 로드 |
| `delete_los_result` | LOS 결과 삭제 |
| `clear_los_results` | LOS 결과 전체 삭제 |
| **수동 병합 이력** | |
| `save_manual_merge` | 수동 비행 병합 이력 저장 |
| `load_manual_merges` | 병합 이력 로드 |
| `clear_manual_merges` | 병합 이력 전체 삭제 |
| **커버리지 캐시** | |
| `save_coverage_cache` / `load_coverage_cache` | 커버리지 캐시 저장/로드 |
| `has_coverage_cache` / `clear_coverage_cache` | 캐시 존재 확인/삭제 |
| **보고서 영속화** | |
| `save_report` | 보고서 저장 (PDF + 설정) |
| `list_saved_reports` | 저장된 보고서 목록 |
| `load_report_detail` | 보고서 상세 로드 |
| `delete_saved_report` | 보고서 삭제 |
| **지형/고도** | |
| `fetch_elevation` | SRTM 타일 기반 배치 고도 조회 |
| `download_srtm_korea` | 한국 영역 SRTM 타일 다운로드 |
| `get_srtm_status` | SRTM 타일 가용 상태 조회 |
| **파노라마** | |
| `calculate_los_panorama` | 360° LoS 파노라마 계산 (지형+건물) |
| `panorama_merge_buildings` | GPU 계산 파노라마에 건물 병합 |
| `save_panorama_cache` / `load_panorama_cache` / `clear_panorama_cache` | 파노라마 캐시 CRUD |
| **GIS 건물통합정보 (F_FAC_BUILDING)** | |
| `import_fac_building_data` | F_FAC_BUILDING SHP ZIP 임포트 |
| `query_fac_buildings_3d` | 뷰포트 내 3D 건물 쿼리 |
| `get_fac_building_import_status` | 임포트 상태 조회 |
| `clear_fac_building_data` | 건물 데이터 삭제 |
| **3D 건물 쿼리** | |
| `query_buildings_3d` | 경로 상 건물 3D 쿼리 |
| `query_buildings_3d_binary` | 바이너리 3D 건물 쿼리 (Float64Array) |
| `query_buildings_in_bbox` | Bbox 내 건물 쿼리 |
| `query_buildings_along_path` | LOS 경로 상 건물 조회 |
| **토지이용계획** | |
| `import_landuse_data` | 토지이용계획 SHP/CSV 임포트 |
| `query_landuse_in_bbox` | 뷰포트 내 토지이용 폴리곤 쿼리 |
| `get_landuse_import_status` / `clear_landuse_data` | 상태 조회/삭제 |
| `download_landuse_tiles` / `get_landuse_tile` / `get_landuse_tile_count` / `clear_landuse_tiles` | 타일 캐시 관리 |
| **산봉우리 지명** | |
| `import_peak_data` | N3P SHP 산봉우리 임포트 |
| `query_nearby_peaks` | 반경 내 인근 산봉우리 조회 |
| `get_peak_import_status` / `clear_peak_data` | 상태 조회/삭제 |
| **건물 그룹** | |
| `list_building_groups` / `add_building_group` / `update_building_group` / `delete_building_group` | 건물 그룹 CRUD |
| `save_group_plan_image` / `load_group_plan_image` / `delete_group_plan_image` | 그룹 도면 이미지 관리 |
| `update_plan_overlay_props` | 도면 오버레이 속성 업데이트 |
| **수동 건물** | |
| `list_manual_buildings` / `add_manual_building` / `update_manual_building` / `delete_manual_building` | 수동 건물 CRUD |
| **자기편각** | |
| `get_magnetic_declination` | 좌표별 자기편각 조회 |
| `refresh_declination_cache` | NOAA 데이터로 캐시 갱신 |
| **GPU 프리샘플링** | |
| `presample_panorama_elevations` | 파노라마 SRTM 고도 그리드 프리샘플 (base64, GPU용) |
| `presample_coverage_elevations` | 커버리지 SRTM+건물 고도 프리샘플 (배치 단위, GPU용) |
| **커버리지 계산** | |
| `compute_coverage_terrain_profile` | 지형 프로파일 계산 |
| `compute_coverage_layer` / `compute_coverage_layers_batch` | 고도별 커버리지 레이어 |
| `is_coverage_profile_valid` / `invalidate_coverage_profile` | 캐시 유효성 |
| `compute_coverage_terrain_profile_excluding` | 특정 건물 제외 지형 프로파일 |
| `compute_coverage_layers_batch_excluded` | 건물 제외 커버리지 레이어 |
| **vWorld 자동 다운로드** | |
| `vworld_download_buildings` | GIS 건물 자동 다운로드 |
| `vworld_download_fac_buildings` | F_FAC_BUILDING 자동 다운로드 |
| `vworld_download_landuse` | 토지이용계획 자동 다운로드 |
| `vworld_download_n3p` | N3P 산봉우리 자동 다운로드 |

### 배치 파싱 이벤트
- `batch-parse-result`: 파일별 결과 (성공/실패)
- `batch-parse-done`: 배치 완료 통계
- `parse-points-chunk`: 5000포인트 단위 스트리밍 (메모리 관리)

### 장애물 월간 분석 이벤트
- `obstacle-monthly-progress`: 레이더별 분석 진행 (radar_name, stage=parsing/analyzing, progress)

## GPU 가속
- `src-tauri/src/main.rs`에서 WebView2에 GPU 가속 강제 플래그 설정
- `--ignore-gpu-blocklist --enable-gpu --enable-gpu-rasterization --enable-unsafe-webgpu --enable-features=Vulkan,WebGPU` 등
- iGPU 없는 CPU(F 모델)에서도 외장 GPU 활용 보장

### WebGPU 컴퓨트 셰이더
- **디바이스 관리**: `gpuCompute.ts` — 싱글턴 WebGPU 디바이스 (discrete GPU 우선), Lost Device 자동 복구
- **커버리지 컴퓨트**: `gpuCoverage.ts` — 0.01° 고해상도 36,000 레이, 2-pass GPU 파이프라인
  - Pass 1: 곡률 보정 + running max angle 누적
  - Pass 2: 고도별 이진 탐색 LOS 차단점
  - 메모리 인지 배치 처리 (maxStorageBufferBindingSize 기반 분할)
- **파노라마 컴퓨트**: `gpuPanorama.ts` — Rust 프리샘플 18M 포인트 → GPU 최대 앙각 계산 (5GB→72MB 압축)
- **도면 컴퓨트**: `gpuDrawingCompute.ts` — Haversine 최대거리 (트리 리덕션), EW 좌표 변환, 밀도 히스토그램 (atomic)
- **프리샘플 파이프라인**: Rust SRTM+건물 → base64 → Worker 디코드 → GPU 컴퓨트 (또는 CPU 폴백)
- **CPU 폴백**: 모든 GPU 커널에 동일 로직 CPU 구현 포함 (WebGPU 미지원 브라우저 대응)

## NEC ASS 파일 포맷 (ASTERIX CAT048)
- NEC RDRS 녹화 파일은 ASTERIX 형식의 데이터 블록을 포함
- NEC 프레임 헤더: `[월][일][시][분]` 4바이트 + 카운터 1바이트
- ASTERIX CAT048 (0x30): 모노레이더 타겟 보고 - 좌표/고도/속도/Mode-S
- I020: Target Report Descriptor → `radar_type` (6종: mode_ac/mode_ac_psr/mode_s_allcall/mode_s_rollcall/mode_s_allcall_psr/mode_s_rollcall_psr) + 유령표적(sidelobe/multipath) 감지→제거
- I040: 극좌표 RHO/THETA → 레이더 사이트 기준 WGS-84 변환
- I090: Flight Level (고도), I140: UTC 자정 기준 초
- I200: Ground Speed + Heading, I220: 24비트 ICAO Mode-S 주소
- NEC 프레임 탐지: 월+일만 매칭 (시/분은 유효범위 검증만)
- 자정 경과 보정 (prev_tod > 70000 && curr_tod < 16000 → +86400s)
- 유효성 필터: 동아시아 확장 범위 (lat 25-50°, lon 115-145°) — 국제선 진입/이탈 구간 포함
- **Mode-S/Squawk 필터**: 파싱 시 Mode-S 코드 또는 Mode-3/A(Squawk) 코드로 필터링 (AND/OR 로직, include/exclude)

## Loss 탐지 알고리즘
- **구현**: Rust (서버사이드) + TypeScript (클라이언트사이드, `src/utils/lossDetection.ts`)
- **레이더 스캔 주기**: 자동 추정 (중앙값 기반, 기본 7초)
- **임계값**: 기본 7.0초 (`DEFAULT_THRESHOLD_SECS`)
- **분류 기준**:
  - `signal_loss`: 일반 표적소실
  - `out_of_range`: 양쪽 끝점 ≥ 최대 범위의 88%, 또는 15연속 스캔 미탐지 + 한쪽 경계 이상
- **최대 레이더 범위 추정**: 전체 트랙 거리의 95% 백분위수
- **제외 조건**: 6시간 초과 gap (공항 정류 등), 0.5초 미만 gap
- **LossPoint**: 개별 미탐지 스캔 추적 (mode_s, timestamp, lat/lon/altitude 보간, radar_distance_km, gap_start/end_time, gap_duration_secs, total_missed_scans, scan_index)

## 레이더 커버리지 맵
- **아키텍처**: 지형 프로파일 캐시 기반 2단계 계산
  - Phase 1: SRTM + 건물 고도 조회 (무거운 계산, 1회 수행) → `CoverageTerrainProfile`
  - Phase 2: 고도별 레이어 계산 (캐시 재사용, 이진 탐색 O(log N)) → `CoverageLayer`
- **GPU 가속**: WebGPU 컴퓨트 셰이더 → 0.01° 고해상도 (36,000 레이), CPU 폴백 지원
- **프리샘플**: Rust에서 SRTM+건물 고도 배치 추출 → base64 → GPU/Worker 병렬 처리
- **건물 제외 모드**: 특정 수동 건물 제외 프로파일 → 장애물 영향 비교 분석
- **건물 필터**: 10km 이내 10m+, 10-30km 30m+, 30km+ 60m+ 높이만 반영
- **다중 고도**: 100ft 단위 200층 사전 계산 → 슬라이더로 실시간 전환
- **Cone of Silence**: `heightAboveRadar / tan(maxElevDeg)` → 반경 계산
- **GeoJSON 변환**: MapLibre fill-extrusion 레이어로 시각화
- **동심 링 시각화**: 다중 고도 범위 시 안쪽 레이어를 홀(hole)로 뚫어 겹침 없는 스펙트럼 링 생성


## GIS 데이터 계층화

### 3단계 데이터 통합 아키텍처

#### Layer 1: 기본 지형 (SRTM DEM)
- **SRTM 1-arcsecond** (30m 해상도), 3601×3601 big-endian i16
- **저장**: SQLite `srtm_tiles` BLOB 우선 → 파일 폴백 (자동 마이그레이션)
- **읽기**: `SrtmReader` — DB/파일 듀얼 소스 + 메모리 캐시 + 바이리니어 보간
- **다운로드**: `download_srtm_korea` — 한국 영역 타일 자동 다운로드 (DB + 파일 동시 저장)

#### Layer 2: 객체 데이터 (건물, 산봉우리, 토지이용)

##### F_FAC_BUILDING (건물통합정보)
- **소스**: 국토교통부 F_FAC_BUILDING SHP (EPSG:5186, EUC-KR)
- **임포트**: `import_fac_building_data` → 진행률 이벤트 → SQLite `fac_buildings` 테이블
- **높이 필터**: 0 < h ≤ 650m
- **필드**: HEIGHT, BLD_NM(건물명), DONG_NM(동명칭), USABILITY(용도), PNU(지번), BD_MGT_SN(도로명주소)
- **3D 쿼리**: `query_fac_buildings_3d()` — 뷰포트 내 폴리곤 건물 조회 (높이순)
- **자동 다운로드**: `vworld_download_fac_buildings` — vWorld.kr 자동 로그인 + 지역코드 다운로드

##### 산봉우리 지명 (N3P)
- **소스**: 국토지리정보원 연속수치지형도 N3P SHP (EPSG:5179, EUC-KR)
- **임포트**: `import_peak_data` → SQLite `peak_names` 테이블
- **필드**: MTNM(산명), HEIG(높이), BJCD(법정동코드)
- **쿼리**: `query_nearby_peaks()` — 반경 검색 (Haversine, 거리순)
- **용도**: LOS 프로파일 차트 산 이름 어노테이션 (**Overpass API 대체, 오프라인 전환**)
- **자동 다운로드**: `vworld_download_n3p`

##### 토지이용계획정보
- **소스**: vWorld 토지이용계획정보 SHP (EPSG:5186) 또는 CSV
- **임포트**: `import_landuse_data` → SQLite `landuse_zones` 테이블
- **필드**: zone_type_code(용도코드), zone_type_name(용도명), area_sqm
- **쿼리**: `query_landuse_in_bbox()` — 뷰포트 내 용도지역 폴리곤
- **자동 다운로드**: `vworld_download_landuse`

#### Layer 3: 좌표 변환 (coord.rs)
- **EPSG:5186** → WGS84: 중앙자오선 127°E, k₀=1, FE=200km, FN=600km (건물통합정보, 토지이용)
- **EPSG:5179** → WGS84: 중앙자오선 127.5°E, k₀=0.9996, FE=1000km, FN=2000km (N3P 산봉우리)
- **ECEF** → WGS84: Bowring 반복법 (mm 정밀도)

### vWorld 자동 다운로드 (vworld.rs)
- **로그인**: AJAX MITM (base64 인코딩 자격증명, 세션 쿠키 유지)
- **데이터셋**: DS_ID=18 (건물), DS_ID=14 (토지이용)
- **파일 목록**: 지역코드 필터링 + 페이지네이션
- **다운로드**: reqwest 클라이언트 (300s 타임아웃, User-Agent 스푸핑)

### 수동 건물
- **그룹 관리**: `building_groups` 테이블 (name, color, memo, plan_image BLOB, plan_bounds_json, plan_opacity, plan_rotation, area_bounds_json)
- **도면 오버레이**: 그룹별 도면 이미지 MapLibre raster 레이어 (위치/투명도/회전 조절)
- **도형 유형**: polygon, multi (`GeometryType`)
- **CRUD**: `manual_buildings` 테이블, Drawing.tsx에서 도형 그리기 (도형 확정 후 자동 맵핏)
- **LOS 반영**: GIS 건물과 함께 경로 분석에 통합 (도형별 샘플 포인트 생성으로 공간 쿼리)

### 자기편각 (declination.rs)
- **소스**: NOAA API (온라인) → DB `declination_cache` 캐시
- **폴백**: WMM (World Magnetic Model) 오프라인 계산 (wmm 크레이트)
- **용도**: ASS 파일 파싱 시 자기편각 보정 (True North 변환)

## 360° LoS 파노라마
- **모듈**: `src-tauri/src/analysis/panorama.rs`
- **원리**: 레이더 안테나에서 0°~360° 방위별 ray → 지형(SRTM) + GIS/수동 건물 중 최대 앙각 장애물
- **건물 높이 필터**: MAX_BUILDING_HEIGHT_M = 650m (비현실적 높이 제외)
- **수동 건물 지오메트리 확장**: polygon(좌표 배열 그대로), multi(서브 도형 재귀 확장) 샘플링
- **출력**: `PanoramaPoint[]` — 방위, 거리, 높이, 앙각, 지면고도, 장애물 유형(terrain/gis_building/manual_building)/이름/주소/용도
- **캐싱**: `save_panorama_cache` / `load_panorama_cache` — 계산 결과 DB 영속화, 보고서 재활용
- **4/3 유효지구 모델**: R_EFF = 6,371,000 × 4/3, 앙각 계산에 굴절 모델 적용
- **건물 병합**: `panorama_merge_buildings()` — GPU 지형 계산 후 건물 데이터 병합

## 장애물 월간 분석 (Obstacle Monthly)
- **모듈**: `src-tauri/src/analysis/obstacle_monthly.rs`
- **원리**: 대상 건물의 방위 섹터 내 항공기 필터 → 일별 PSR 탐지율/Loss율 집계 → 비대상 방위 기준선 비교
- **입력**: `RadarFileSet[]` (레이더별 파일 경로 + 방위 섹터 + 좌표 + antenna_height + min_obstacle_distance_km)
- **방위 섹터**: `AzSector[]` (start_deg, end_deg) — 건물 방위 기반 대상/비대상 영역 분리
- **일별 통계**: PSR 탐지율, Loss율, Loss 이벤트 위치정보(LossPointGeo), 기준선(비대상 방위) 비교
- **주간 집계**: 월 내 주차별 요약 (일별 데이터 그룹핑)
- **커버리지 비교**: 건물 유/무 커버리지 프로파일 차이 → 장애물 영향 정량화
- **출력**: `RadarMonthlyResult` (daily_stats[], avg_loss_altitude_ft, total_files_parsed, total_points_filtered, failed_files)
- **보고서 섹션** (10개):
  1. 요약 (`ReportOMSummarySection`): 대상 장애물 테이블 (높이, 방위/거리)
  2. 일별 PSR (`ReportOMDailyChart`): PSR 탐지율 시계열 막대 차트
  3. 일별 Loss (`ReportOMDailyChart`): Loss율 시계열 (대상 vs 기준선)
  4. 주간 집계 (`ReportOMWeeklyChart`): 주차별 요약
  5. 방위 산점도 (`ReportOMAzDistScatter`): Loss 포인트 극좌표 산점도 + 건물 차폐 영역
  6. 커버리지 비교 (`ReportOMCoverageDiff`): 건물 유/무 커버리지 diff
  7. 건물 LOS (`ReportOMBuildingLoS`): 표적 고도 vs LOS 차단각
  8. 고도 분포 (`ReportOMAltitudeDistribution`): Loss 이벤트 고도 히스토그램
  9. Loss 이벤트 (`ReportOMLossEvents`): 상세 테이블 (위치/시각/지속시간)
  10. 분석 소견 (`ReportOMFindings`): 서술형 종합 판정

## 장애물 전파영향 사전검토 (Pre-Screening)
- **모듈**: `src-tauri/src/analysis/pre_screening.rs`
- **원리**: 제안 건물(ProposedBuilding)이 레이더 LOS를 차단하는지 사전 분석
- **입력**: ProposedBuilding[] (id, name, lat/lon, height_m, ground_elev_m) + RadarFileSet[]
- **분석 항목**:
  - 기존 지형 앙각 (MIN_TERRAIN_ANGLE_DEG = 0.25°)
  - 건물 포함 시 앙각 계산
  - 최대 건축가능 높이 산출 (기존 지형 앙각 기준)
  - 추가 Loss 이벤트 예측 (AdditionalLossEvent)
- **출력**: `PreScreeningResult` (radar_results[] → building_results[] → additional_loss_events[])
- **보고서 섹션** (3개):
  1. 요약 (`ReportPSSummarySection`): 대상 건물 목록 + 건축가능 높이
  2. 앙각/높이 (`ReportPSAngleHeight`): 지형 앙각 vs 건물 높이 비교 분석
  3. 추가 Loss (`ReportPSAdditionalLoss`): 추가 표적소실 상세 테이블

## 데이터 모델
### Aircraft
`id`, `name`, `registration`, `model`, `mode_s_code`, `organization`, `memo`, `active`

### TrackPoint
`timestamp`, `mode_s`, `latitude`, `longitude`, `altitude`, `speed`, `heading`, `radar_type`(mode_ac/mode_ac_psr/mode_s_allcall/mode_s_rollcall/mode_s_allcall_psr/mode_s_rollcall_psr), `raw_data`, `radar_name?`

### Flight (핵심 분석 단위)
`id`(format: `${mode_s}_${start_time}`), `mode_s`, `aircraft_name?`, `callsign?`, `departure_airport?`, `arrival_airport?`, `start_time`, `end_time`, `track_points[]`(@deprecated, Worker 소유), `loss_segments[]`, `loss_points[]`, `total_loss_time`, `total_track_time`, `loss_percentage`, `max_radar_range_km`, `match_type`("gap"|"manual"), `radar_name?`, `point_count`, `bbox`(minLat/maxLat/minLon/maxLon), `radar_type_counts`, `within_60nm_stats?`(total/psr)

### RadarSite
`name`, `latitude`, `longitude`, `altitude`, `antenna_height`, `range_nm`(제원상 지원범위 NM), `active?`

### LossSegment
`mode_s`, `start_time`/`end_time`, `start_lat/lon`, `end_lat/lon`, `start_altitude`, `end_altitude`, `last_altitude`, `duration_secs`, `distance_km`, `loss_type`(signal_loss/out_of_range), `start_radar_dist_km`, `end_radar_dist_km`

### LossPoint
`mode_s`, `timestamp`, `latitude`, `longitude`, `altitude`, `radar_distance_km`, `loss_type`, `scan_index`, `total_missed_scans`, `gap_start_time`, `gap_end_time`, `gap_duration_secs`

### LoSProfileData
`id`, `radarSiteName`, `radarLat/Lon/Height`, `targetLat/Lon`, `bearing`, `totalDistance`, `elevationProfile[]`(ElevationPoint: distance/elevation/lat/lon), `losBlocked`, `maxBlockingPoint`(distance/elevation/name), `mapScreenshot?`(base64 JPEG), `chartScreenshot?`(base64 PNG), `timestamp`

### BuildingGroup
건물 그룹 (id, name, color, memo, has_plan_image, plan_bounds_json, plan_opacity, plan_rotation, area_bounds_json)

### BuildingOnPath / ManualBuilding / Building3D
- **BuildingOnPath**: LOS 경로 상 건물 (distance_km, near_dist_km, far_dist_km, height_m, ground_elev_m, total_height_m, name, address, usage, lat, lon, polygon?, is_manual)
- **ManualBuilding**: 수동 건물 (id, name, latitude, longitude, height, ground_elev, memo, geometry_type, geometry_json, group_id)
- **Building3D**: 3D 건물 (lat, lon, height_m, polygon, name, usage, source: "fac"|"manual", group_color?)
- **NearbyPeak**: 인근 산봉우리 (name, height_m, latitude, longitude, distance_km)

### PanoramaPoint
방위별 최대 앙각 장애물 (azimuth_deg, elevation_angle_deg, distance_km, obstacle_height_m, ground_elev_m, obstacle_type, name, address, usage, lat, lon)

### AzSector / RadarFileSet (장애물 월간)
`AzSector`: 방위 섹터 (start_deg, end_deg)
`RadarFileSet`: 레이더별 분석 세트 (radar_name, radar_lat/lon/altitude, antenna_height, file_paths, azimuth_sectors, min_obstacle_distance_km)

### DailyStats / LossPointGeo / RadarMonthlyResult
`DailyStats`: 일별 통계 (date, day_of_month, week_num, total_points, ssr_combined_points, psr_combined_points, psr_rate, loss_rate, loss_points_summary[], baseline_loss_rate, baseline_psr_rate)
`LossPointGeo`: Loss 이벤트 위치정보 (lat, lon, alt_ft, duration_s)
`RadarMonthlyResult`: 레이더별 월간 분석 결과 (radar_name, daily_stats[], avg_loss_altitude_ft, total_files_parsed, total_points_filtered, failed_files[])

### PreScreening 타입
- `ProposedBuilding`: 제안 건물 (id, name, lat/lon, height_m, ground_elev_m)
- `AdditionalLossEvent`: 추가 Loss 이벤트 (mode_s, start/end_time, duration_secs, start/end_lat/lon, start/end/avg_alt_ft, radar_distance_km, azimuth_deg)
- `PreScreeningBuildingResult`: 건물별 결과 (terrain_elevation_angle_deg, building_elevation_angle_deg, max_buildable_height_m, additional_loss_events[], affected_aircraft_count)
- `PreScreeningRadarResult`: 레이더별 결과 (building_results[], analysis_period)
- `PreScreeningResult`: 전체 결과 (radar_results[])

## 맵 렌더링 구조
- **deck.gl 레이어** (GPU 캔버스):
  - `PathLayer`: 항적 경로 (gap/radar_type 변경 시 세그먼트 분할)
  - `LineLayer`: Loss 구간 빨간 점선, LOS 미리보기선
  - `ScatterplotLayer`: Loss 시작/종료 마커, Dot 모드 포인트, LOS 항적 하이라이트
  - `IconLayer`: 레이더 아이콘, LOS 건물 하이라이트 (building-icon.png)
  - `PolygonLayer`: 커버리지 맵 (다중 고도 폴리곤 단일 레이어 통합)
  - `LineLayer` (dot-stems): Dot 모드 수직선
- **MapLibre 네이티브 레이어** (맵 캔버스):
  - `range-ring-lines`: 동심원 (20NM 간격)
  - `range-ring-labels`: 거리 라벨
  - `radar-center-label`: 레이더 사이트명
  - `hillshade`: DEM 음영기복도
  - `terrain-dem` source: AWS Terrarium (raster-dem)
  - 레이더 커버리지 fill 레이어 (다중 고도)
  - 도면 이미지 오버레이 (planOverlay.ts → MapLibre raster source)
- **항적 색상 팔레트** (탐지 유형 기반, Line/Dot 모드 공통):
  - Mode S Roll-Call: blue [59,130,246]
  - Mode S Roll-Call + PSR: green [34,197,94]
  - Mode S All-Call: sky blue [56,189,248]
  - Mode S All-Call + PSR: lime [132,204,22]
  - Mode A/C (±PSR): yellow [234,179,8]
  - fallback: gray [128,128,128]
- **기체별 색상 팔레트** (Drawing.tsx, Sidebar.tsx — mode_s 인덱스 기반):
  - blue, emerald, violet, cyan, orange, pink, lime, amber, indigo, teal (10색 순환)
- TrackMap은 App.tsx에서 항상 마운트 (offscreen 토글, 보고서 맵 캡처 지원)
- `window.__maplibreInstance`: 보고서에서 맵 캡처용 MapLibre 인스턴스 노출

## 호버/인터랙션
- **항적 맵 호버**: deck.gl pickable + onHover → 구조화된 다중행 툴팁 (기체명, 시각, 고도, 속도, 레이더 타입, 좌표)
- **Loss 호버**: 시작/종료 시각, 지속시간, 거리, 고도 상세 표시
- **레이더 호버**: 사이트명, 지원범위, 좌표
- **LOS 차트 크로스헤어**: SVG 마우스 추적 → 수직선 + 거리/지형고도/굴절선높이/여유고 실시간 표시
- **LOS 포인트 핀**: 클릭 시 고정, 황색 stroke, 지도↔차트 양방향 하이라이트 연동
- **LOS 맵↔차트 호버**: 맵 포인트 호버→차트 하이라이트(시안 stroke), 차트 포인트 호버→맵 마커 표시 (onTrackPointHover/externalHoverIdx)
- **LOS 맵 항적 포인트**: deck.gl ScatterplotLayer, 클릭 시 차트 핀 동기화 (externalHighlightIdx), 호버 시 차트 하이라이트 (externalHoverIdx)
- **LOS 건물 호버/클릭**: 경로 상 건물 높이/주소/용도 시각화, 클릭 시 핀 고정(앰버), 맵에 건물 아이콘 하이라이트 (건물 오버레이 비활성에서도 표시)
- **LOS 건물 상세보기**: 건물 클릭 툴팁에 상세보기 링크 → Google Street View + Google Maps 위성지도 사이드바 (레이더→건물 방위 기반 heading, 애니메이션 전환)
- **LOS 빈 영역 클릭 재생성**: 프로파일 표시 중 맵 빈 영역 클릭 시 해당 좌표로 LOS 단면도 재생성 (deck.gl 포인트 클릭과 구분)
- **데이터 테이블**: 선택 행 시각적 강조 (ring + 배경색)
- **PathLayer**: autoHighlight (흰색 오버레이)

## LOS 분석 (실제 지구 디스플레이 프레임)
- **원리**: 실제 지구(R=6,371km) + 굴절 전파 경로 = 4/3 유효지구(R_eff=8,495km) + 직선 경로 (수학적 등가)
- **디스플레이 프레임**: 실제 지구반경(R) 기준 — 직선 LOS가 직선으로 표시됨
  - `curvDrop(d) = d² / (2 × R)`: 디스플레이 프레임 곡률 보정 (실제 지구)
  - `curvDrop43(d) = d² / (2 × R_eff)`: 4/3 유효지구 곡률 보정 (굴절 계산용)
  - 4/3 굴절선 → 디스플레이 변환: `h43 + curvDrop43(d) - curvDrop(d)`
- **차트 요소**:
  1. 녹색 면: 조정 지형 (실제 지구 곡률 보정)
  2. 주황 실선: 최저 탐지가능 높이 (4/3 전파굴절, 프레임 변환 적용)
  3. 흰색 점선: 최저 탐지가능 높이 (직선 LOS, 직선으로 표시)
  4. 시안 점선: BRA 0.25° 기준선 (고도 ft AMSL 표시)
  5. 빨간 점: 최대 차단점 (산 이름: peak DB 오프라인 조회)
  6. 건물 블록: LOS 경로 상 GIS/수동 건물 (높이, 주소, 용도)
- **차단 판정**: 4/3 프레임에서 수행 (굴절 전파 기준)
- **고도 소스**: SRTM HGT 타일 (로컬) 또는 open-meteo.com (폴백, 150 샘플, 100개씩 배치)
- **산 이름**: peak DB (오프라인, N3P 데이터), Overpass API 폴백 (natural=peak, 반경 3km)
- **지도 연동**: 단면도 포인트 클릭 → TrackMap에 하이라이트 마커, 프로파일 로딩 완료 → 카메라 자동 정렬

## PDF 보고서 시스템
### 아키텍처
- **2단계 워크플로우**: 설정(템플릿+섹션 토글) → HTML 미리보기(인라인 편집) → PDF 내보내기
- **렌더링 파이프라인**: WebView2 PrintToPdf (CDP 네이티브, primary) → html2canvas-pro + jsPDF (폴백)
- **저장**: Tauri `write_file_base64` + `@tauri-apps/plugin-dialog` 저장 다이얼로그
- **보고서 영속화**: `save_report` IPC로 PDF + 설정 DB 저장, `list_saved_reports` / `load_report_detail` / `delete_saved_report`로 관리

### 보고서 템플릿 (7종)
- `weekly`: 주간 보고서
- `monthly`: 월간 보고서
- `flights`: 비행별 보고서
- `single`: 단일 비행 보고서
- `obstacle`: 장애물 분석 보고서
- `obstacle_monthly`: 장애물 월간 분석 보고서
- `pre_screening`: 장애물 전파영향 사전검토 보고서

### 기본 9개 섹션 (토글 가능)
1. **표지** (`ReportCoverPage`): 문서번호, 시행일자, 레이더명, 제목/부제 인라인 편집
2. **요약** (`ReportSummarySection`): KPI 그리드, 종합 판정 등급(양호/주의/경고), 편집 가능한 분석 소견
3. **항적 지도** (`ReportMapSection`): MapLibre 캡처 이미지
4. **분석 통계** (`ReportStatsSection`): 주간 보고서 시 최근 10주 추이 테이블+SVG 이중 막대 차트, 비행별 상세 테이블+가로 막대 차트
5. **소실 상세** (`ReportLossSection`): 표적소실 구간 테이블 (월간 보고서 최대 20건)
6. **LOS 분석** (`ReportLoSSection`): LOS 결과 테이블 (차단/양호 배지)
7. **장애물 분석** (`ReportPanoramaSection`): 360° 파노라마 SVG 차트, 8방위 요약 테이블, 상위 15건 건물 목록
9. **기체 현황** (`ReportAircraftSection`): 비행검사기 현황 테이블

### 장애물 월간 보고서 10개 섹션 (obstacle_monthly 전용)
1. **장애물 요약** (`ReportOMSummarySection`): 대상 장애물 목록
2. **일별 PSR** (`ReportOMDailyChart`): PSR 탐지율 일별 추이
3. **일별 Loss** (`ReportOMDailyChart`): Loss율 일별 추이 (대상 vs 기준선)
4. **주간 집계** (`ReportOMWeeklyChart`): 주차별 요약
5. **방위 산점도** (`ReportOMAzDistScatter`): Loss 포인트 극좌표 산점도 + 건물 차폐 영역
6. **커버리지 비교** (`ReportOMCoverageDiff`): 건물 유/무 커버리지 diff
7. **건물 LOS** (`ReportOMBuildingLoS`): 표적 고도 vs LOS 차단각
8. **고도 분포** (`ReportOMAltitudeDistribution`): Loss 고도 히스토그램
9. **Loss 이벤트** (`ReportOMLossEvents`): 상세 테이블
10. **분석 소견** (`ReportOMFindings`): 서술형 종합 판정

### 사전검토 보고서 3개 섹션 (pre_screening 전용)
1. **사전검토 요약** (`ReportPSSummarySection`): 대상 건물 목록 + 건축가능 높이
2. **앙각/높이 분석** (`ReportPSAngleHeight`): 지형 앙각 vs 건물 높이 비교
3. **추가 Loss 상세** (`ReportPSAdditionalLoss`): 추가 표적소실 이벤트 테이블

### 공통 컴포넌트
- `ReportPage`: A4 페이지 래퍼 (210×297mm, `data-page` 속성)
- `EditableText`: contentEditable 인라인 텍스트 편집
- `useReportExport`: PDF 내보내기 훅 (WebView2 PrintToPdf primary, 페이지 자동 분할, 페이지 번호 삽입)

## 비행 통합 로직
### Worker 기반 (src/workers/flightConsolidation.worker.ts)
- **`consolidateAndStream()`**: Worker 내부 비행 통합 — 그룹핑 + 비행 빌드 + FLIGHT_CHUNK 스트리밍 + CONSOLIDATE_PROGRESS 진행률
- **`_flightIndex`**: Worker가 소유하는 비행별 포인트 인덱스 (메인에 포인트 전송 안 함)
- **`QUERY_VIEWPORT_POINTS`**: 뷰포트 쿼리 API — 필터/청크 스트리밍 (2M 상한)

### Worker 래퍼 (src/utils/flightConsolidationWorker.ts)
- **`sendPointsToWorker()`**: 메인→Worker 포인트 전송 (메인에 축적 안 함)
- **`startConsolidate()`**: Worker 통합 시작 + onFlightChunk 콜백 스트리밍
- **`queryViewportPoints()`**: Worker에 뷰포트 포인트 쿼리 (청크 수신→배열 조립)
- **`setConsolidationProgressCallback()`**: Worker 진행률 → store 업데이트 콜백 등록
- **`createThrottledChunkHandler()`**: 비행 청크 throttle 배치 (250ms 간격, 리렌더 최소화)
- **`queryFlightPoints()`** / **`queryFlightPointsBatch()`**: 특정 비행 포인트 쿼리
- **`getPointSummary()`**: Worker 포인트 요약 조회

### 공통 로직 (src/utils/flightConsolidation.ts)
- **`consolidateFlights()`**: 레거시 동기 통합 (Worker 미사용 시 폴백)
- **`manualMergeFlights()`**: 사용자가 선택한 비행 수동 병합 (match_type="manual")
- **`flightLabel()`**: `기체명 · 콜사인 · 출발→도착` 형식 비행 라벨

## 이상고도 보정 (src/utils/altitudeCorrection.ts)
- **절대 범위 검사**: -100m ~ 20,000m
- **수직속도 기반**: 100m/s 초과 → 이상값 후보 (전투기 급상승 수준, ~20,000 ft/min)
- **연속 이상값 탐지**: 가장 가까운 정상 이전 포인트 기준 비교 (연속 이상값도 포착)
- **첫/끝점 검사**: 인접 정상 포인트 2개의 추세와 비교
- **보간**: 양쪽 정상 포인트로 선형 보간
- **적용**: 파싱 후 비행 통합 전 자동 적용

## Zustand 전역 상태 (src/store/index.ts)
- **항공기**: aircraft[] (최대 10대, preset: 1호기 FL7779/71BF79, 2호기 FL7778/71BF78)
- **파일**: uploadedFiles[] (상태: pending/parsing/done/error)
- **Worker 포인트**: workerPointCount, workerPointSummary[] (실제 포인트는 Worker 소유, 메인에는 요약만)
- **비행**: flights[], selectedFlightId, appendFlights(), finalizeFlights(), mergeFlights(ids)
- **통합 상태**: consolidating, consolidationProgress (stage: loading|history|grouping|building|done, current, total, flightsBuilt)
- **파싱 통계**: parseStatsList[] (파일별 파싱 통계)
- **레이더**: radarSite (현재 활성), customRadarSites[] (프리셋 + 사용자 등록, DB 영속화)
- **필터**: selectedModeS ("__ALL__"=전체(기본값), null=등록기체, 특정코드)
- **LOS**: losResults[] (저장된 LOS 프로파일)
- **파노라마**: panoramaViewActive, panoramaActivePoint, panoramaPinned, panoramaOverlayData, panoramaOverlayVisible
- **커버리지**: coverageData, coverageVisible, coverageLoading, coverageProgress, coverageProgressPct, coverageError, coverageCacheAvailable
- **보고서**: reportMetadata, savedReports[]
- **건물**: buildingGroups[], manualBuildings[], activePlanOverlays (Map)
- **다운로드 상태**: facBuildingDownloading, n3pDownloading, landuseDownloading, srtmDownloading, peakImporting
- **UI**: activePage, loading, loadingMessage
- **개발**: devMode (소스 오버레이 토글)

## SQLite 데이터베이스 (src-tauri/src/db.rs)
- **settings**: Key-Value 설정 저장 (레이더 사이트 설정 등)
- **aircraft**: 비행검사기 (id, name, registration, model, mode_s_code, organization, memo, active)
- **elevation_cache**: 고도 캐시 (open-meteo 결과)
- **panorama_cache**: 360° 파노라마 계산 결과 캐시 (radar_lat/lon PK, data_json)
- **los_results**: LOS 분석 결과 영속화 (프로파일 + 스크린샷)
- **manual_merge_history**: 수동 비행 병합 이력 (source_flight_ids_json)
- **coverage_cache**: 커버리지 맵 캐시 (radar_name PK, layers_json)
- **garble_summary_cache**: Garble 요약 통계 캐시
- **saved_reports**: 저장된 보고서 (title, template, pdf_base64, metadata_json)
- **weather_garble_correlation**: 기상-Garble 상관분석 캐시
- **building_groups**: 건물 그룹 (name, color, memo, plan_image BLOB, plan_bounds_json, plan_opacity, plan_rotation, area_bounds_json)
- **manual_buildings**: 수동 건물 (geometry_type, geometry_json, group_id FK→building_groups)
- **srtm_tiles**: SRTM HGT 타일 BLOB (name PK, ~25MB/타일, 파일 폴백 호환)
- **fac_buildings**: 건물통합정보 (region, centroid, bbox, height, building_name, dong_name, usability, pnu, polygon_json)
- **fac_building_import_log**: 건물통합정보 임포트 이력
- **peak_names**: 산봉우리 지명 (name, height_m, lat, lon, bjcd)
- **peak_import_log**: 산봉우리 임포트 이력
- **landuse_zones**: 토지이용계획 폴리곤 (zone_type_code, zone_type_name, centroid, bbox, polygon_json, area_sqm)
- **landuse_import_log**: 토지이용계획 임포트 이력
- **landuse_tiles**: 토지이용계획도 타일 캐시 (z, x, y)
- **declination_cache**: 자기편각 캐시 (lat_key, lon_key, date_key, declination_deg, source)
- **폐기된 테이블**: ~~buildings~~, ~~building_import_log~~ (fac_buildings로 대체), ~~weather_cache~~, ~~cloud_grid_cache~~ (삭제됨)

## 아키텍처 원칙: 스트리밍 우선

**대량 데이터(10M+ 포인트)를 다루는 모든 파이프라인은 스트리밍 방식으로 구현한다.**

### 왜 스트리밍인가
- 10M TrackPoint ≈ 2.5GB. 메인 스레드에 전체 축적하면 OOM 크래시.
- structured clone(postMessage)도 전체를 한 번에 보내면 OOM.
- 동기 함수 안에서 postMessage를 여러 번 호출해도, Worker 이벤트 루프가 안 풀리면 진짜 스트리밍이 아님.

### 스트리밍 패턴 (현재 적용)

**비행 통합 파이프라인** (`flightConsolidation.worker.ts` + `flightConsolidationWorker.ts`):
```
DB → 파일1 로드 → sendPointsToWorker(파일1) → 로컬 GC   ← 메인에 축적 안 함
  → setConsolidationProgress(loading, 1/N)               ← 파일별 진행률
DB → 파일2 로드 → sendPointsToWorker(파일2) → 로컬 GC
  → setConsolidationProgress(loading, 2/N)
...
setConsolidationProgressCallback(store 업데이트)          ← Worker 진행률 콜백 등록
startConsolidate() →
  Worker: 그룹핑 → CONSOLIDATE_PROGRESS(grouping, K/total)
  Worker: buildFlight(비행1) → FLIGHT_CHUNK → yield
    메인: appendFlights([비행1]) → store → UI 즉시 반영
  Worker: CONSOLIDATE_PROGRESS(building, 1/groups, flightsBuilt=1)
  Worker: buildFlight(비행2) → FLIGHT_CHUNK → yield
  ...
  Worker: CONSOLIDATE_PROGRESS(done) → CONSOLIDATE_DONE
```

**항적 렌더링 파이프라인** (TrackMap.tsx):
```
queryViewportPoints() → Worker에서 포인트 쿼리 (2M 상한)
→ mode_s별 그룹핑 → timestamp 정렬 → 세그먼트 분할 (7초 gap)
→ PathLayer 데이터 빌드 (progressive rendering: 50K마다 중간 플러시)
```

### 새 파이프라인 구현 시 필수 규칙

1. **메인 스레드에 대량 데이터 축적 금지**: DB/파일에서 로드한 데이터는 즉시 Worker로 전송하고 로컬 참조 해제
2. **Worker 내부 async + yield 필수**: `await setTimeout(0)`으로 이벤트 루프 양보 → postMessage 실제 전달 + GC 허용
3. **결과도 청크 스트리밍**: Worker → 메인 결과 반환 시 전체가 아닌 단위별(비행, 레이어 등) 청크로 전송
4. **store 점진 업데이트**: `appendFlights()` 같은 점진 추가 액션 사용. 전체를 모아서 한 번에 `setFlights()` 금지
5. **처리 완료 그룹 즉시 해제**: Worker Map/배열에서 처리 완료된 그룹 `delete` → GC 허용
6. **spread 금지 (대량)**: `push(...bigArray)` 대신 `for` 루프 `push`. spread는 스택 오버플로우 유발 (10M+)
7. **다운샘플링/stride 샘플링 절대 금지**: 성능 최적화를 위해 TrackPoint를 다운샘플링(간인, 솎아내기)하거나 stride 샘플링(N번째마다 추출)하는 것은 어떤 경우에도 허용하지 않는다. 렌더링 포함 모든 파이프라인에서 **전수 포인트**를 사용해야 한다. 포인트를 누락하면 Loss 구간 탐지/통계/LOS 분석의 정확도가 훼손된다.

### 기존 Worker 구현 참고
- `src/workers/flightConsolidation.worker.ts` — 비행 통합 + 뷰포트 쿼리 + 진행률 보고
- `src/workers/coverageBuilder.worker.ts` — 커버리지 맵 (레이어 빌드, GeoJSON 폴리곤 생성, progressive rendering)
- `src/utils/flightConsolidationWorker.ts` — Worker 래퍼 (콜백 스트리밍 + 진행률 콜백 패턴)

## 코딩 컨벤션
- Rust: snake_case, 에러 핸들링은 Result/Option 사용
- TypeScript: camelCase, 컴포넌트는 PascalCase
- CSS: Tailwind utility-first, 화이트 테마 기본
- 한글 주석 사용
- 색상 테마: #ffffff(배경), #f8f9fa(카드), #f3f4f6(보조), #a60739(액센트), #e94560(하이라이트/에러)
