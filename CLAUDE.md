# NEC ASTERIX 비행검사기 항적분석체계

## 프로젝트 개요
Tauri 기반 **Windows Portable** 데스크톱 애플리케이션으로, NEC 레이더 저장자료(NEC ASS 파일)를 파싱하여 비행검사기의 항적을 분석하고, 항적 Loss 구간을 탐지/시각화하는 특화 분석 도구.

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
- **Frontend**: React 19 + TypeScript 5.8 + Vite 7 + Tailwind 4
- **Backend**: Rust (Tauri v2)
- **Map**: deck.gl 9.2 + react-map-gl 8 (GPU 가속), MapLibre GL JS 5 (동심원/라벨)
- **PDF**: jsPDF 2.5 + html2canvas 1.4 (HTML 미리보기 → 캡처 → PDF 변환)
- **File Dialog**: @tauri-apps/plugin-dialog (PDF 저장 경로 선택)
- **State**: Zustand 5
- **Icons**: lucide-react
- **Date**: date-fns

## 프로젝트 구조
```
src/                    # React frontend
  ├── App.tsx           # 라우터 + TrackMap 항상 마운트 + 앱 시작 시 DB 복원
  ├── main.tsx          # React entry point
  ├── index.css         # 전역 CSS (다크 테마, Leaflet/MapLibre 오버라이드)
  ├── pages/
  │   ├── AircraftManagement.tsx  # 비행검사기 관리 (최대 10대)
  │   ├── Dashboard.tsx           # 홈 대시보드 (비행 기반 통계 카드)
  │   ├── Drawing.tsx             # 그리기 도구
  │   ├── FileUpload.tsx          # NEC ASS 파일 업로드/파싱 (배치 지원)
  │   ├── LossAnalysis.tsx        # 표적소실 분석 (테이블/비행별/비교 뷰)
  │   ├── ReportGeneration.tsx    # PDF 보고서 (설정→미리보기 2단계, 섹션별 토글)
  │   ├── Settings.tsx            # 설정 + DB 내보내기/가져오기
  │   └── TrackMap.tsx            # 항적 지도 (deck.gl GPU 렌더링)
  ├── components/
  │   ├── Layout/
  │   │   ├── Sidebar.tsx         # 사이드바 네비게이션 (w-60, 공항명 한글 변환)
  │   │   └── Titlebar.tsx        # Tauri 커스텀 타이틀바 (드래그/창 컨트롤)
  │   ├── Map/
  │   │   ├── DeckGLOverlay.tsx   # deck.gl ↔ MapLibre 통합 (MapboxOverlay)
  │   │   ├── LOSProfilePanel.tsx # LOS 단면도 (SVG 차트, 크로스헤어+포인트 핀 기능)
  │   │   ├── LossMarkers.tsx     # React Leaflet 용 Loss 마커 (미사용 예비)
  │   │   ├── MapStyleToggle.tsx  # 맵 스타일 전환 (다크/표준)
  │   │   └── TrackLayer.tsx      # React Leaflet 용 항적 레이어 (미사용 예비)
  │   ├── Report/
  │   │   ├── EditableText.tsx        # contentEditable 인라인 텍스트 편집
  │   │   ├── ReportAircraftSection.tsx   # 비행검사기 현황 테이블
  │   │   ├── ReportCoverPage.tsx     # 표지 (문서번호/시행일자/레이더명, 인라인 편집)
  │   │   ├── ReportLOSSection.tsx    # LOS 분석 결과 테이블
  │   │   ├── ReportLossSection.tsx   # 표적소실 구간 상세 테이블
  │   │   ├── ReportMapSection.tsx    # 항적 지도 캡처 이미지
  │   │   ├── ReportPage.tsx          # A4 페이지 래퍼 (210×297mm)
  │   │   ├── ReportStatsSection.tsx  # 분석 통계 (추이 차트+비행별 막대 차트)
  │   │   ├── ReportSummarySection.tsx # 요약 (KPI 그리드, 종합 판정, 분석 소견)
  │   │   └── useReportExport.ts      # PDF 내보내기 훅 (html2canvas→jsPDF)
  │   └── common/
  │       ├── Card.tsx            # 통계 카드 + SimpleCard
  │       ├── DataTable.tsx       # 범용 데이터 테이블 (정렬, 선택 행 강조)
  │       └── Modal.tsx           # 모달 컴포넌트
  ├── utils/
  │   ├── flightConsolidation.ts  # 비행 통합 (OpenSky 매칭 + gap 분리)
  │   └── lossDetection.ts       # Loss 탐지 (TypeScript 구현, Rust 알고리즘 이식)
  ├── store/
  │   └── index.ts      # Zustand 전역 상태 (항공기/파일/비행/레이더/LOS/UI)
  └── types/
      └── index.ts      # TypeScript 인터페이스 정의
src-tauri/src/          # Rust backend
  ├── lib.rs            # Tauri entry point + IPC commands (21개)
  ├── main.rs           # WebView2 GPU 가속 강제 플래그 설정
  ├── db.rs             # SQLite 데이터베이스 (운항이력/파싱데이터/설정 영속화)
  ├── parser/
  │   ├── mod.rs
  │   └── ass.rs        # ASTERIX CAT048 파싱 (NEC 프레임 + FSPEC 기반)
  ├── analysis/
  │   ├── mod.rs
  │   ├── loss.rs       # Loss 탐지 (자동 임계값 + signal_loss/out_of_range 분류)
  │   └── los.rs        # Line of Sight (4/3 유효지구반경 모델)
  └── models/
      └── mod.rs        # 데이터 모델 (serde 직렬화)
src-tauri/icons/        # 앱 아이콘 (icon.ico, icon.png, 각종 크기)
public/                 # 정적 자산
  ├── radar-icon.png    # 레이더 아이콘 (맵 표시용)
  └── favicon.svg       # 파비콘
```

## 핵심 기능
1. 비행검사기 관리 (최대 10대, Mode-S 코드, 등록번호, aircraft.json 영속화)
2. NEC ASS 파일 파싱 (ASTERIX CAT048 바이너리, 배치 병렬 파싱 with rayon)
3. 항적 시각화 (deck.gl GPU 렌더링, SSR+PSR/SSR Only 색상 분리)
4. Loss 구간 자동 탐지 (Signal Loss만 표시, 범위이탈 분리 분류)
5. 레이더 사이트 관리 (좌표/고도/안테나높이/지원범위NM, 설정 DB 영속화)
6. 레이더 동심원 표시 (20NM 간격, 200NM까지, MapLibre 네이티브 레이어)
7. 검색 가능한 Mode-S 드롭다운 필터 + UNKNOWN/소수 항적 자동 제외
8. LOS 분석 (SVG 단면도: 지형+실제지구곡률+4/3굴절 모델+산 이름, 크로스헤어+포인트 핀)
9. 항적 지도 상태 유지 (App.tsx에서 항상 마운트, offscreen 토글)
10. GPU 상태 뱃지 (실제 WebGL 렌더러 감지, HW/SW 표시)
11. PDF 보고서 (HTML 미리보기→캡처→PDF, 7개 섹션 토글, 인라인 텍스트 편집, 추이 차트)
12. 재생/구간 컨트롤 (실시간 배속 재생, 구간 선택 드래그)
13. 3D 지형 (AWS Terrarium DEM, 음영기복도, 고도 배율 조절)
14. Dot 모드 (개별 표적 점+수직선 시각화)
15. 구조화된 호버 툴팁 (항적/Loss/레이더에 다중행 정보 표시)
16. OpenSky 운항이력 자동 동기화 (OAuth2 인증, 최근 5년, SQLite 캐싱)
17. 도면/측면도 그리기 도구 (거리 축 라벨)
18. 비행 통합 (OpenSky 매칭 + gap 분리, 분석 단위를 파일→비행으로 전환)
19. 파싱 데이터 DB 영속화 (앱 재시작 시 자동 복원)
20. DB 내보내기/가져오기 (전체 데이터 이식)
21. LOS↔지도 양방향 연동 (단면도 포인트 클릭→지도 하이라이트)

## 핵심 아키텍처: 비행(Flight) 기반 분석
분석 단위가 "파싱 파일(`AnalysisResult`)"에서 "**비행(`Flight`)**"으로 전환됨.

### 데이터 흐름
1. ASS 파일 파싱 → DB `track_points`/`parsed_files` 자동 저장
2. `rawTrackPoints` 축적 → `consolidateFlights()` 실행
3. OpenSky 운항이력 매칭 (±5분 허용) + 미매칭 포인트 4시간 gap 분리
4. 각 비행에 `detectLoss()` 적용 → `flights[]` 생성
5. 모든 UI가 `flights[]` 기반으로 표시

### 앱 재시작 복원
- `useRestoreSavedData()` 훅: DB에서 파싱 데이터 + 레이더 설정 자동 복원
- 복원 후 `consolidateFlights()` 재실행하여 `flights` 재생성

## Tauri IPC 명령
| 명령 | 설명 |
|------|------|
| `parse_ass_file` | 단일 ASS 파일 파싱 |
| `analyze_tracks` | 파싱 결과로 Loss 분석 |
| `parse_and_analyze` | 파싱+분석 통합 (DB 자동 저장) |
| `parse_and_analyze_batch` | 배치 병렬 파싱 (rayon, 이벤트 스트리밍, DB 자동 저장) |
| `get_aircraft_list` | 저장된 항공기 목록 |
| `save_aircraft` | 항공기 추가/수정 |
| `delete_aircraft` | 항공기 삭제 |
| `filter_tracks_by_mode_s` | Mode-S 필터링 |
| `read_file_base64` | 파일 base64 읽기 (폰트 로딩용) |
| `write_file_base64` | base64 데이터를 파일로 저장 (PDF 저장용) |
| `fetch_flight_history` | OpenSky 운항이력 조회 (OAuth2, 1일 윈도우) |
| `load_flight_history` | SQLite에서 저장된 운항이력 로드 |
| `save_opensky_credentials` | OpenSky Client ID/Secret 저장 |
| `load_opensky_credentials` | 저장된 OpenSky 인증정보 로드 |
| `fetch_adsb_tracks` | ADS-B 항적 데이터 조회 |
| `load_saved_data` | DB에서 저장된 파싱 데이터 전체 로드 |
| `clear_saved_data` | 저장된 파싱 데이터 전체 삭제 |
| `load_setting` | Key-Value 설정 로드 |
| `save_setting` | Key-Value 설정 저장 |
| `export_database` | DB 파일을 지정 경로로 내보내기 (WAL 체크포인트 후 복사) |
| `import_database` | 외부 DB 파일로 교체 (SQLite 매직 바이트 검증 후 재연결) |

### 배치 파싱 이벤트
- `batch-parse-result`: 파일별 결과 (성공/실패)
- `batch-parse-done`: 배치 완료 통계
- `parse-points-chunk`: 5000포인트 단위 스트리밍 (메모리 관리)

### 운항이력 이벤트
- `flight-history-records`: 건별 운항이력 실시간 스트리밍
- `flight-history-progress`: 동기화 진행 상황 (current/total/icao24)

## GPU 가속
- `src-tauri/src/main.rs`에서 WebView2에 GPU 가속 강제 플래그 설정
- `--ignore-gpu-blocklist --enable-gpu --enable-gpu-rasterization` 등
- iGPU 없는 CPU(F 모델)에서도 외장 GPU 활용 보장

## NEC ASS 파일 포맷 (ASTERIX CAT048)
- NEC RDRS 녹화 파일은 ASTERIX 형식의 데이터 블록을 포함
- NEC 프레임 헤더: `[월][일][시][분]` 4바이트 + 카운터 1바이트
- ASTERIX CAT048 (0x30): 모노레이더 타겟 보고 - 좌표/고도/속도/Mode-S
- I020: Target Report Descriptor → `radar_type` (psr/ssr/combined/modes)
- I040: 극좌표 RHO/THETA → 레이더 사이트 기준 WGS-84 변환
- I090: Flight Level (고도), I140: UTC 자정 기준 초
- I200: Ground Speed + Heading, I220: 24비트 ICAO Mode-S 주소
- NEC 프레임 탐지: 월+일만 매칭 (시/분은 유효범위 검증만)
- 자정 경과 보정 (prev_tod > 70000 && curr_tod < 16000 → +86400s)
- 유효성 필터: 한국 영공 (lat 30-45°, lon 120-135°)

## Loss 탐지 알고리즘
- **구현**: Rust (서버사이드) + TypeScript (클라이언트사이드, `src/utils/lossDetection.ts`)
- **레이더 스캔 주기**: 자동 추정 (중앙값 기반, 기본 7초)
- **자동 임계값**: 스캔 주기 × 1.4 이상 gap이면 Loss로 판정
- **분류 기준**:
  - `signal_loss`: 일반 표적소실
  - `out_of_range`: 양쪽 끝점 ≥ 최대 범위의 88%, 또는 15연속 스캔 미탐지 + 한쪽 경계 이상
- **최대 레이더 범위 추정**: 전체 트랙 거리의 95% 백분위수
- **제외 조건**: 6시간 초과 gap (공항 정류 등), 0.5초 미만 gap

## 데이터 모델
### Aircraft
`id`, `name`, `registration`, `model`, `mode_s_code`, `organization`, `memo`, `active`

### TrackPoint
`timestamp`, `mode_s`, `latitude`, `longitude`, `altitude`, `speed`, `heading`, `radar_type`(ssr/combined/psr/modes), `raw_data`

### Flight (핵심 분석 단위)
`id`, `mode_s`, `aircraft_name?`, `callsign?`, `departure_airport?`, `arrival_airport?`, `start_time`, `end_time`, `track_points[]`, `loss_segments[]`, `total_loss_time`, `total_track_time`, `loss_percentage`, `max_radar_range_km`, `match_type`("opensky"|"gap")

### RadarSite
`name`, `latitude`, `longitude`, `altitude`, `antenna_height`, `range_nm`(제원상 지원범위 NM)

### LossSegment
`mode_s`, `start_time`/`end_time`, `start_lat/lon`, `end_lat/lon`, `start_altitude`, `end_altitude`, `last_altitude`, `duration_secs`, `distance_km`, `loss_type`(signal_loss/out_of_range), `start_radar_distance`, `end_radar_distance`

### LOSProfileData
`id`, `radarSiteName`, `radarLat/Lon/Height`, `targetLat/Lon`, `bearing`, `totalDistance`, `elevationProfile[]`, `losBlocked`, `maxBlockingPoint`(distance/elevation/name), `timestamp`

## 맵 렌더링 구조
- **deck.gl 레이어** (GPU 캔버스):
  - `PathLayer`: 항적 경로 (gap/radar_type 변경 시 세그먼트 분할)
  - `LineLayer`: Loss 구간 빨간 점선, LOS 미리보기선
  - `ScatterplotLayer`: Loss 시작/종료 마커, Dot 모드 포인트, LOS 항적 하이라이트
  - `IconLayer`: 레이더 아이콘
  - `LineLayer` (dot-stems): Dot 모드 수직선
- **MapLibre 네이티브 레이어** (맵 캔버스):
  - `range-ring-lines`: 동심원 (20NM 간격)
  - `range-ring-labels`: 거리 라벨
  - `radar-center-label`: 레이더 사이트명
  - `hillshade`: DEM 음영기복도
  - `terrain-dem` source: AWS Terrarium (raster-dem)
- **색상 팔레트**:
  - SSR+PSR Combined: blue, emerald, violet, cyan, indigo, teal, lime, pink
  - SSR Only: amber, orange, yellow, orange-light, amber-dark, red-light
- TrackMap은 App.tsx에서 항상 마운트 (offscreen 토글, 보고서 맵 캡처 지원)
- `window.__maplibreInstance`: 보고서에서 맵 캡처용 MapLibre 인스턴스 노출

## 호버/인터랙션
- **항적 맵 호버**: deck.gl pickable + onHover → 구조화된 다중행 툴팁 (기체명, 시각, 고도, 속도, 레이더 타입, 좌표)
- **Loss 호버**: 시작/종료 시각, 지속시간, 거리, 고도 상세 표시
- **레이더 호버**: 사이트명, 지원범위, 좌표
- **LOS 차트 크로스헤어**: SVG 마우스 추적 → 수직선 + 거리/지형고도/굴절선높이/여유고 실시간 표시
- **LOS 포인트 핀**: 클릭 시 고정, 황색 stroke, 지도 위 해당 위치 하이라이트 연동
- **소실분석 미니맵**: Leaflet Tooltip (시작/종료 마커에 시각, 고도, 좌표)
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
  5. 빨간 점: 최대 차단점 (산 이름 Overpass API 조회)
- **차단 판정**: 4/3 프레임에서 수행 (굴절 전파 기준)
- **고도 API**: open-meteo.com (150 샘플, 100개씩 배치 요청)
- **산 이름**: Overpass API (natural=peak, 반경 3km)
- **지도 연동**: 단면도 포인트 클릭 → TrackMap에 하이라이트 마커, 프로파일 로딩 완료 → 카메라 자동 정렬

## PDF 보고서 시스템
### 아키텍처
- **2단계 워크플로우**: 설정(템플릿+섹션 토글) → HTML 미리보기(인라인 편집) → PDF 내보내기
- **렌더링 파이프라인**: React 컴포넌트 → A4 HTML 미리보기 → html2canvas(scale:2) → jsPDF
- **저장**: Tauri `write_file_base64` + `@tauri-apps/plugin-dialog` 저장 다이얼로그

### 7개 섹션 (토글 가능)
1. **표지** (`ReportCoverPage`): 문서번호, 시행일자, 레이더명, 제목/부제 인라인 편집
2. **요약** (`ReportSummarySection`): KPI 그리드, 종합 판정 등급(양호/주의/경고), 편집 가능한 분석 소견
3. **항적 지도** (`ReportMapSection`): MapLibre 캡처 이미지
4. **분석 통계** (`ReportStatsSection`): 주간 보고서 시 최근 10주 추이 테이블+SVG 이중 막대 차트, 비행별 상세 테이블+가로 막대 차트
5. **소실 상세** (`ReportLossSection`): 표적소실 구간 테이블 (월간 보고서 최대 20건)
6. **LOS 분석** (`ReportLOSSection`): LOS 결과 테이블 (차단/양호 배지)
7. **기체 현황** (`ReportAircraftSection`): 비행검사기 현황 테이블

### 공통 컴포넌트
- `ReportPage`: A4 페이지 래퍼 (210×297mm, `data-page` 속성)
- `EditableText`: contentEditable 인라인 텍스트 편집
- `useReportExport`: PDF 내보내기 훅 (페이지 자동 분할, 페이지 번호 삽입)

## 비행 통합 로직 (src/utils/flightConsolidation.ts)
- **`mergeFlightRecords()`**: OpenSky 같은 날 4시간 이내 출발/도착 분리 레코드 병합
- **`consolidateFlights()`**: mode_s별 TrackPoint 그룹핑 → OpenSky 시간 매칭(±5분) → 미매칭 포인트 4시간 gap 분리
- **`flightLabel()`**: `기체명 · 콜사인 · 출발→도착` 형식 비행 라벨

## Zustand 전역 상태 (src/store/index.ts)
- **항공기**: aircraft[] (최대 10대, preset: 1호기 FL7779/71BF79, 2호기 FL7778/71BF78)
- **파일**: uploadedFiles[] (상태: pending/parsing/done/error)
- **원시 데이터**: rawTrackPoints[] (파싱된 전체 항적 포인트)
- **비행**: flights[] (통합된 비행 목록, 핵심 분석 단위)
- **파싱 통계**: parseStatsList[] (파일별 파싱 통계)
- **레이더**: radarSite (현재 활성), customRadarSites[] (프리셋 + 사용자 등록, DB 영속화)
- **필터**: selectedModeS (null=등록기체, "__ALL__"=전체, 특정코드)
- **LOS**: losResults[] (저장된 LOS 프로파일)
- **ADS-B**: adsbTracks[], adsbLoading, adsbProgress
- **운항이력**: flightHistory[], flightHistoryLoading/Progress, selectedFlight
- **OpenSky 동기화**: openskySync, openskySyncProgress, openskySyncVersion (triggerOpenskySync)
- **UI**: activePage, loading, loadingMessage

## OpenSky Network 연동
- **인증**: OAuth2 Client Credentials 필수 (익명 접근 403 차단)
- **API**: `/flights/aircraft` — ICAO24 기준 운항이력 조회
- **제한**: 최대 1일(86,400초) 윈도우 (calendar day 파티션), 레이트 리밋 적용
- **자동 동기화**: 앱 시작 시 등록 기체별 최근 5년치 운항이력 순차 조회
- **캐싱**: SQLite `opensky_query_log`로 이미 조회한 시간 윈도우 추적 → 중복 요청 방지
- **실시간 업데이트**: Tauri 이벤트로 건별 스트리밍 (`flight-history-records`)
- **설정**: 설정 페이지에서 Client ID/Secret 입력, SQLite에 영속 저장

## SQLite 데이터베이스 (src-tauri/src/db.rs)
- **flight_history**: 운항이력 레코드 (icao24, callsign, 출발/도착 공항, 시간)
- **adsb_tracks**: ADS-B 항적 데이터
- **opensky_query_log**: 조회 완료 시간 윈도우 기록 (중복 방지)
- **settings**: Key-Value 설정 저장 (OpenSky 인증정보, 레이더 사이트 설정 등)
- **parsed_files**: 파싱된 파일 메타데이터 (path, name, records, 시간범위, stats JSON)
- **track_points**: 파싱된 항적 포인트 (file_id FK CASCADE, 좌표/고도/속도/레이더타입)

## 코딩 컨벤션
- Rust: snake_case, 에러 핸들링은 Result/Option 사용
- TypeScript: camelCase, 컴포넌트는 PascalCase
- CSS: Tailwind utility-first, 다크 테마 기본
- 한글 주석 사용
- 색상 테마: #1a1a2e(배경), #16213e(카드), #0f3460(강조), #e94560(하이라이트)
