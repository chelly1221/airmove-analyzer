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
- **GIS**: shapefile 크레이트 (SHP 파싱), EPSG:5186→WGS84 좌표 변환

## 프로젝트 구조
```
src/                    # React frontend
  ├── App.tsx           # 라우터 + TrackMap 항상 마운트 + 앱 시작 시 DB 복원
  ├── main.tsx          # React entry point
  ├── index.css         # 전역 CSS (다크 테마, Leaflet/MapLibre 오버라이드)
  ├── pages/
  │   ├── AircraftManagement.tsx  # 비행검사기 관리 (최대 10대)
  │   ├── Dashboard.tsx           # 홈 대시보드 (비행 기반 통계 카드)
  │   ├── Drawing.tsx             # 그리기 도구 + 수동 건물 등록 도형
  │   ├── FileUpload.tsx          # NEC ASS 파일 업로드/파싱 (배치 지원)
  │   ├── LossAnalysis.tsx        # 표적소실 분석 (테이블/비행별/비교 뷰, 파노라마 상세는 사이드바로 이동)
  │   ├── ReportGeneration.tsx    # PDF 보고서 (설정→미리보기 2단계, 9개 섹션 토글)
  │   ├── Settings.tsx            # 설정 + DB 내보내기/가져오기 + GIS건물 임포트 + SRTM 다운로드
  │   └── TrackMap.tsx            # 항적 지도 (deck.gl GPU 렌더링, 커버리지/구름 오버레이)
  ├── components/
  │   ├── Layout/
  │   │   ├── Sidebar.tsx         # 사이드바 네비게이션 (w-60, 공항명 한글 변환, 비행 병합, 파노라마 패널)
  │   │   └── Titlebar.tsx        # Tauri 커스텀 타이틀바 (드래그/창 컨트롤)
  │   ├── Map/
  │   │   ├── DeckGLOverlay.tsx   # deck.gl ↔ MapLibre 통합 (MapboxOverlay)
  │   │   ├── LOSProfilePanel.tsx # LOS 단면도 (SVG 차트, 크로스헤어+포인트 핀+건물 클릭/호버+상세보기 모달, 맵/차트 스크린샷 캡처)
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
  │   │   ├── ReportPanoramaSection.tsx  # 360° 파노라마 장애물 분석 (SVG 차트+8방위 요약+건물 목록)
  │   │   ├── ReportStatsSection.tsx  # 분석 통계 (추이 차트+비행별 막대 차트)
  │   │   ├── ReportSummarySection.tsx # 요약 (KPI 그리드, 종합 판정, 분석 소견)
  │   │   ├── ReportWeatherSection.tsx # 기상 조건 분석 (기상 테이블, 덕팅 위험)
  │   │   └── useReportExport.ts      # PDF 내보내기 훅 (html2canvas→jsPDF)
  │   └── common/
  │       ├── Card.tsx            # 통계 카드 + SimpleCard
  │       ├── DataTable.tsx       # 범용 데이터 테이블 (정렬, 선택 행 강조)
  │       └── Modal.tsx           # 모달 컴포넌트
  ├── utils/
  │   ├── altitudeCorrection.ts   # 이상고도 보정 (수직속도 기반 + 선형 보간)
  │   ├── flightConsolidation.ts  # 비행 통합 (OpenSky 매칭 + gap 분리 + 수동 병합)
  │   ├── lossDetection.ts       # Loss 탐지 (TypeScript 구현, 개별 LossPoint 생성)
  │   ├── radarCoverage.ts       # 레이더 커버리지 맵 (다중 고도 레이어, 지형 프로파일 캐시, 이진 탐색 최적화)
  │   └── weatherFetch.ts        # 기상 데이터 조회 (Open-Meteo Archive, 구름 그리드, 덕팅 위험)
  ├── store/
  │   └── index.ts      # Zustand 전역 상태 (항공기/파일/비행/레이더/LOS/커버리지/기상/UI)
  └── types/
      └── index.ts      # TypeScript 인터페이스 정의
src-tauri/src/          # Rust backend
  ├── lib.rs            # Tauri entry point + IPC commands (34개)
  ├── main.rs           # WebView2 GPU 가속 강제 플래그 설정
  ├── db.rs             # SQLite 데이터베이스 (운항이력/파싱데이터/설정/건물/기상캐시 영속화)
  ├── building.rs       # GIS건물통합정보 SHP 임포트 + LOS 경로 건물 쿼리 + 수동 건물 CRUD
  ├── coord.rs          # EPSG:5186(Korea 2000) → WGS84 좌표 변환
  ├── srtm.rs           # SRTM HGT 1-arcsecond (30m) 타일 읽기 + 바이리니어 보간
  ├── parser/
  │   ├── mod.rs
  │   └── ass.rs        # ASTERIX CAT048 파싱 (NEC 프레임 + FSPEC + 유령표적 제거)
  ├── analysis/
  │   ├── mod.rs
  │   ├── loss.rs       # Loss 탐지 (자동 임계값 + signal_loss/out_of_range + LossPoint)
  │   ├── los.rs        # Line of Sight (4/3 유효지구반경 모델)
  │   └── panorama.rs   # 360° LoS 파노라마 (지형+건물 통합 스캔)
  └── models/
      └── mod.rs        # 데이터 모델 (serde 직렬화)
src-tauri/icons/        # 앱 아이콘 (icon.ico, icon.png, 각종 크기)
public/                 # 정적 자산
  ├── radar-icon.png    # 레이더 아이콘 (맵 표시용)
  ├── building-icon.png # 건물 아이콘 (LOS 건물 하이라이트용)
  └── favicon.svg       # 파비콘
```

## 핵심 기능
1. 비행검사기 관리 (최대 10대, Mode-S 코드, 등록번호, aircraft.json 영속화)
2. NEC ASS 파일 파싱 (ASTERIX CAT048 바이너리, 배치 병렬 파싱 with rayon, 유령표적 자동 제거)
3. 항적 시각화 (deck.gl GPU 렌더링, 탐지 유형별 색상 분리)
4. Loss 구간 자동 탐지 (Signal Loss만 표시, 범위이탈 분리 분류, 개별 LossPoint 추적)
5. 레이더 사이트 관리 (좌표/고도/안테나높이/지원범위NM, 설정 DB 영속화)
6. 레이더 동심원 표시 (20NM 간격, 200NM까지, MapLibre 네이티브 레이어)
7. 검색 가능한 Mode-S 드롭다운 필터 + UNKNOWN/소수 항적 자동 제외
8. LOS 분석 (SVG 단면도: 지형+건물+실제지구곡률+4/3굴절 모델+산 이름, 크로스헤어+포인트 핀)
9. 항적 지도 상태 유지 (App.tsx에서 항상 마운트, offscreen 토글)
10. GPU 상태 뱃지 (실제 WebGL 렌더러 감지, HW/SW 표시)
11. PDF 보고서 (HTML 미리보기→캡처→PDF, 9개 섹션 토글, 인라인 텍스트 편집, 추이 차트)
12. 재생/구간 컨트롤 (실시간 배속 재생, 구간 선택 드래그)
13. 3D 지형 (AWS Terrarium DEM, 음영기복도, 고도 배율 조절)
14. Dot 모드 (개별 표적 점+수직선 시각화)
15. 구조화된 호버 툴팁 (항적/Loss/레이더에 다중행 정보 표시)
16. OpenSky 운항이력 자동 동기화 (OAuth2 인증, 최근 5년, SQLite 캐싱)
17. 도면/측면도 그리기 도구 (거리 축 라벨, 수동 건물 도형 등록, 타원 지오메트리 지원, 타임라인 스크롤 줌)
18. 비행 통합 (OpenSky 매칭 + gap 분리 + 수동 병합, 분석 단위를 파일→비행으로 전환)
19. 파싱 데이터 DB 영속화 (앱 재시작 시 자동 복원)
20. DB 내보내기/가져오기 (전체 데이터 이식)
21. LOS↔지도 양방향 연동 (단면도 포인트 클릭→지도 하이라이트)
22. 레이더 커버리지 맵 (다중 고도 레이어, 지형 프로파일 캐시 기반 빠른 계산, Cone of Silence)
23. 기상 데이터 분석 (Open-Meteo Archive API, 시간별 기상, 덕팅 위험 평가)
24. 구름 그리드 오버레이 (레이더 주변 격자 구름 분포, 시간별 애니메이션)
25. LOS 스크린샷 캡처 (맵 JPEG + 차트 PNG, DB 영속화, 보고서 재활용)
26. GIS 건물통합정보 임포트 (vWorld SHP ZIP, EPSG:5186→WGS84, LOS 경로 건물 쿼리)
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
46. 건물 그룹 관리 (그룹 CRUD, 색상/메모, 수동 건물 그룹 배정, 그룹별 필터/접기)
47. 건물 데이터 일괄 임포트 (다중 ZIP 선택, 파일명 행정구역코드 자동 감지, 순차 임포트)
48. GIS 건물 높이 교차검증 (층수 기반 높이 선택, 이웃 비교 이상치 자동 제거)
49. 비동기 항적 렌더링 (대량 포인트 처리 시 UI 양보, 1M+ 포인트 비동기 전환)
50. 파노라마 차트 지형/건물 분리 렌더링 (지형 실루엣 + 건물 세로선 + 통합 외곽선 3레이어)

## 핵심 아키텍처: 비행(Flight) 기반 분석
분석 단위가 "파싱 파일(`AnalysisResult`)"에서 "**비행(`Flight`)**"으로 전환됨.

### 데이터 흐름
1. ASS 파일 파싱 → DB `track_points`/`parsed_files` 자동 저장 + 포인트에 `radar_name` 태깅
2. `rawTrackPoints` 축적 → `consolidateFlights()` 실행 (mode_s + radar_name 별 그룹핑)
3. OpenSky 운항이력 매칭 (±5분 허용) + 미매칭 포인트 4시간 gap 분리
4. 각 비행에 `detectLoss()` 적용 → `flights[]` 생성 (LossPoint 포함, `radar_name` 전파)
5. 각 페이지에서 `radarSite.name`으로 필터링하여 선택 레이더 데이터만 표시

### 앱 재시작 복원
- `useRestoreSavedData()` 훅: DB에서 파싱 데이터 + 레이더 설정 자동 복원
- **스트리밍 복원**: `load_saved_file_metas` (메타만) → `load_file_track_points` (파일별 분할 로드)
- 복원 시 좌표 매칭으로 `radar_name` 태깅 후 `consolidateFlights()` 재실행

## Tauri IPC 명령
| 명령 | 설명 |
|------|------|
| **파싱/분석** | |
| `parse_ass_file` | 단일 ASS 파일 파싱 |
| `analyze_tracks` | 파싱 결과로 Loss 분석 |
| `parse_and_analyze` | 파싱+분석 통합 (DB 자동 저장) |
| `parse_and_analyze_batch` | 배치 병렬 파싱 (rayon, 이벤트 스트리밍, DB 자동 저장) |
| **항공기** | |
| `get_aircraft_list` | 저장된 항공기 목록 |
| `save_aircraft` | 항공기 추가/수정 |
| `delete_aircraft` | 항공기 삭제 |
| `filter_tracks_by_mode_s` | Mode-S 필터링 |
| **파일 I/O** | |
| `read_file_base64` | 파일 base64 읽기 (폰트 로딩용) |
| `write_file_base64` | base64 데이터를 파일로 저장 (PDF 저장용) |
| **OpenSky/운항이력** | |
| `fetch_flight_history` | OpenSky 운항이력 조회 (OAuth2, 1일 윈도우) |
| `load_flight_history` | SQLite에서 저장된 운항이력 로드 |
| `save_opensky_credentials` | OpenSky Client ID/Secret 저장 |
| `load_opensky_credentials` | 저장된 OpenSky 인증정보 로드 |
| `fetch_adsb_tracks` | ADS-B 항적 데이터 조회 |
| **데이터 관리** | |
| `load_saved_data` | DB에서 저장된 파싱 데이터 전체 로드 (레거시) |
| `load_saved_file_metas` | 파일 메타데이터만 로드 (포인트 제외, 스트리밍 복원 1단계) |
| `load_file_track_points` | 특정 파일의 track_points 로드 (파일 단위 분할 복원) |
| `clear_saved_data` | 저장된 파싱 데이터 전체 삭제 |
| `load_setting` | Key-Value 설정 로드 |
| `save_setting` | Key-Value 설정 저장 |
| `export_database` | DB 파일을 지정 경로로 내보내기 (WAL 체크포인트 후 복사) |
| `import_database` | 외부 DB 파일로 교체 (SQLite 매직 바이트 검증 후 재연결) |
| **기상 데이터** | |
| `save_weather_day` | 시간별 기상 데이터 일 단위 캐시 저장 |
| `get_weather_cached_dates` | 캐시된 날짜 목록 조회 |
| `load_weather_cache` | DB에서 캐시된 기상 데이터 로드 |
| `save_cloud_grid_day` | 구름 그리드 일 단위 캐시 저장 |
| `load_cloud_grid_cache` | 구름 그리드 캐시 로드 |
| **지형/고도** | |
| `fetch_elevation` | SRTM 타일 기반 배치 고도 조회 |
| `download_srtm_korea` | 한국 영역 SRTM 타일 다운로드 |
| `calculate_los_panorama` | 360° LoS 파노라마 계산 (지형+건물) |
| `load_panorama_cache` | 캐시된 파노라마 데이터 로드 (보고서용) |
| **GIS 건물** | |
| `import_building_data` | vWorld SHP ZIP 임포트 (진행률 이벤트) |
| `query_buildings_along_path` | LOS 경로 상 건물 조회 |
| `get_building_import_status` | 임포트 상태 조회 |
| `clear_building_data` | 건물 데이터 삭제 |
| **건물 그룹** | |
| `list_building_groups` | 건물 그룹 목록 |
| `add_building_group` | 건물 그룹 추가 |
| `update_building_group` | 건물 그룹 수정 |
| `delete_building_group` | 건물 그룹 삭제 (소속 건물 group_id 자동 NULL) |
| **수동 건물** | |
| `list_manual_buildings` | 수동 건물 목록 |
| `add_manual_building` | 수동 건물 추가 |
| `update_manual_building` | 수동 건물 수정 |
| `delete_manual_building` | 수동 건물 삭제 |
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
- I020: Target Report Descriptor → `radar_type` (psr/ssr/combined/modes) + 유령표적(sidelobe/multipath) 감지→제거
- I040: 극좌표 RHO/THETA → 레이더 사이트 기준 WGS-84 변환
- I090: Flight Level (고도), I140: UTC 자정 기준 초
- I200: Ground Speed + Heading, I220: 24비트 ICAO Mode-S 주소
- NEC 프레임 탐지: 월+일만 매칭 (시/분은 유효범위 검증만)
- 자정 경과 보정 (prev_tod > 70000 && curr_tod < 16000 → +86400s)
- 유효성 필터: 동아시아 확장 범위 (lat 25-50°, lon 115-145°) — 국제선 진입/이탈 구간 포함

## Loss 탐지 알고리즘
- **구현**: Rust (서버사이드) + TypeScript (클라이언트사이드, `src/utils/lossDetection.ts`)
- **레이더 스캔 주기**: 자동 추정 (중앙값 기반, 기본 7초)
- **자동 임계값**: 스캔 주기 × 1.4 이상 gap이면 Loss로 판정
- **분류 기준**:
  - `signal_loss`: 일반 표적소실
  - `out_of_range`: 양쪽 끝점 ≥ 최대 범위의 88%, 또는 15연속 스캔 미탐지 + 한쪽 경계 이상
- **최대 레이더 범위 추정**: 전체 트랙 거리의 95% 백분위수
- **제외 조건**: 6시간 초과 gap (공항 정류 등), 0.5초 미만 gap
- **LossPoint**: 개별 미탐지 스캔 추적 (gap_start/end_time, gap_duration_secs, total_missed_scans, scan_index)

## 레이더 커버리지 맵
- **아키텍처**: 지형 프로파일 캐시 기반 2단계 계산
  - Phase 1: SRTM + 건물 고도 조회 (무거운 계산, 1회 수행) → `CoverageTerrainProfile`
  - Phase 2: 고도별 레이어 계산 (캐시 재사용, 이진 탐색 O(log N)) → `CoverageLayer`
- **건물 필터**: 10km 이내 10m+, 10-30km 30m+, 30km+ 60m+ 높이만 반영
- **다중 고도**: 100ft 단위 200층 사전 계산 → 슬라이더로 실시간 전환
- **Cone of Silence**: `heightAboveRadar / tan(maxElevDeg)` → 반경 계산
- **GeoJSON 변환**: MapLibre fill-extrusion 레이어로 시각화
- **동심 링 시각화**: 다중 고도 범위 시 안쪽 레이어를 홀(hole)로 뚫어 겹침 없는 스펙트럼 링 생성

## 기상 데이터 분석
- **API**: Open-Meteo Archive (무료, 제한 없음)
- **데이터**: 시간별 기온, 강수, 운량(4층), 시정, 풍속/풍향, 기압, 이슬점
- **캐싱**: SQLite `weather_cache` 일 단위 + 레이더 좌표 기준
- **덕팅 위험**: T-Td < 2°C && pressure > 1020hPa → "high" (전파 굴절 이상 조건)
- **구름 그리드**: 레이더 주변 격자점 구름 분포, 시간별 프레임, 배치 요청(10포인트)

## GIS 건물 & SRTM
### GIS 건물통합정보
- **소스**: vWorld GIS건물통합정보 SHP (EPSG:5186, EUC-KR)
- **임포트**: ZIP 선택 → `import_building_data` → 진행률 이벤트 → SQLite `buildings` 테이블
- **일괄 임포트**: 다중 ZIP 선택 → 파일명 행정구역코드(`_11_`=서울, `_28_`=인천, `_41_`=경기) 자동 감지 → 순차 처리
- **높이 검증**: 다중 필드 수집 → 층수 교차검증(2.5~6.0m/층) → 이웃 비교 이상치 제거(150m 반경, 평균 대비 2배+30m)
- **LOS 쿼리**: `query_buildings_along_path()` — 경로 복도 내 건물 필터링
- **좌표 변환**: `coord.rs` — GRS80 타원체 Transverse Mercator 역변환

### 수동 건물
- **그룹 관리**: `building_groups` 테이블 (name, color, memo), 건물에 `group_id` FK (ON DELETE SET NULL)
- **도형 유형**: point, rectangle, circle/ellipse, line (`GeometryType`)
- **타원 지오메트리**: `{center, semi_major_m, semi_minor_m, rotation_deg}` (레거시 `radius_m` 호환)
- **CRUD**: `manual_buildings` 테이블, Drawing.tsx에서 도형 그리기 (도형 확정 후 자동 맵핏)
- **LOS 반영**: GIS 건물과 함께 경로 분석에 통합 (도형별 샘플 포인트 생성으로 공간 쿼리)

### SRTM 고도 데이터
- **해상도**: 1-arcsecond (~30m), 3601×3601 big-endian i16
- **저장**: SQLite `srtm_tiles` BLOB 우선 → 파일 폴백 (자동 마이그레이션)
- **읽기**: `SrtmReader` — DB/파일 듀얼 소스 + 메모리 캐시 + 바이리니어 보간
- **다운로드**: `download_srtm_korea` — 한국 영역 타일 자동 다운로드 (DB + 파일 동시 저장)

## 360° LoS 파노라마
- **모듈**: `src-tauri/src/analysis/panorama.rs`
- **원리**: 레이더 안테나에서 0°~360° 방위별 ray → 지형(SRTM) + GIS/수동 건물 중 최대 앙각 장애물
- **건물 높이 필터**: MAX_BUILDING_HEIGHT_M = 1000m (비현실적 높이 제외)
- **수동 건물 지오메트리 확장**: rectangle(9점), circle/ellipse(13점), line(전체점), point(중심점) 샘플링
- **출력**: `PanoramaPoint[]` — 방위, 거리, 높이, 앙각, 장애물 유형/이름/주소/용도
- **캐싱**: `load_panorama_cache(radarLat, radarLon)` — 계산 결과 DB 영속화, 보고서 재활용
- **4/3 유효지구 모델**: 앙각 계산에 굴절 모델 적용

## 데이터 모델
### Aircraft
`id`, `name`, `registration`, `model`, `mode_s_code`, `organization`, `memo`, `active`

### TrackPoint
`timestamp`, `mode_s`, `latitude`, `longitude`, `altitude`, `speed`, `heading`, `radar_type`(ssr/combined/psr/modes), `raw_data`, `radar_name?`(파싱 시 레이더 사이트명)

### Flight (핵심 분석 단위)
`id`, `mode_s`, `aircraft_name?`, `callsign?`, `departure_airport?`, `arrival_airport?`, `start_time`, `end_time`, `track_points[]`, `loss_segments[]`, `loss_points[]`, `total_loss_time`, `total_track_time`, `loss_percentage`, `max_radar_range_km`, `match_type`("opensky"|"gap"|"manual"), `radar_name?`(파싱 시 레이더 사이트명)

### RadarSite
`name`, `latitude`, `longitude`, `altitude`, `antenna_height`, `range_nm`(제원상 지원범위 NM)

### LossSegment
`mode_s`, `start_time`/`end_time`, `start_lat/lon`, `end_lat/lon`, `start_altitude`, `end_altitude`, `last_altitude`, `duration_secs`, `distance_km`, `loss_type`(signal_loss/out_of_range), `start_radar_distance`, `end_radar_distance`

### LossPoint
`gap_start_time`, `gap_end_time`, `gap_duration_secs`, `total_missed_scans`, `scan_index`

### LOSProfileData
`id`, `radarSiteName`, `radarLat/Lon/Height`, `targetLat/Lon`, `bearing`, `totalDistance`, `elevationProfile[]`, `losBlocked`, `maxBlockingPoint`(distance/elevation/name), `mapScreenshot?`(base64 JPEG), `chartScreenshot?`(base64 PNG), `timestamp`

### WeatherHourly / WeatherSnapshot
시간별 기상 (기온, 강수, 운량 4층, 시정, 풍속/풍향, 기압, 이슬점)

### CloudGridCell / CloudGridFrame / CloudGridData
격자 셀 좌표 + 운량 4종, 시간별 프레임 타임시리즈

### BuildingGroup
건물 그룹 (name, color, memo)

### BuildingOnPath / ManualBuilding
LOS 경로 상 건물 (높이, 주소, 용도), 수동 건물 (도형 JSON: rectangle `[[lat,lon]x4]` (4꼭짓점, 레거시: `[[minLat,minLon],[maxLat,maxLon]]`), circle/ellipse `{center,semi_major_m,semi_minor_m,rotation_deg}`, line `[[lat,lon],...]`, point `[lat,lon]`, group_id FK)

### PanoramaPoint
방위별 최대 앙각 장애물 (거리, 높이, 유형, 이름, 주소, 용도)

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
  - 구름 그리드 fill 레이어 (시간별)
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
  6. 건물 블록: LOS 경로 상 GIS/수동 건물 (높이, 주소, 용도)
- **차단 판정**: 4/3 프레임에서 수행 (굴절 전파 기준)
- **고도 소스**: SRTM HGT 타일 (로컬) 또는 open-meteo.com (폴백, 150 샘플, 100개씩 배치)
- **산 이름**: Overpass API (natural=peak, 반경 3km)
- **지도 연동**: 단면도 포인트 클릭 → TrackMap에 하이라이트 마커, 프로파일 로딩 완료 → 카메라 자동 정렬

## PDF 보고서 시스템
### 아키텍처
- **2단계 워크플로우**: 설정(템플릿+섹션 토글) → HTML 미리보기(인라인 편집) → PDF 내보내기
- **렌더링 파이프라인**: React 컴포넌트 → A4 HTML 미리보기 → html2canvas(scale:2) → jsPDF
- **저장**: Tauri `write_file_base64` + `@tauri-apps/plugin-dialog` 저장 다이얼로그

### 9개 섹션 (토글 가능)
1. **표지** (`ReportCoverPage`): 문서번호, 시행일자, 레이더명, 제목/부제 인라인 편집
2. **요약** (`ReportSummarySection`): KPI 그리드, 종합 판정 등급(양호/주의/경고), 편집 가능한 분석 소견
3. **항적 지도** (`ReportMapSection`): MapLibre 캡처 이미지
4. **분석 통계** (`ReportStatsSection`): 주간 보고서 시 최근 10주 추이 테이블+SVG 이중 막대 차트, 비행별 상세 테이블+가로 막대 차트
5. **소실 상세** (`ReportLossSection`): 표적소실 구간 테이블 (월간 보고서 최대 20건)
6. **LOS 분석** (`ReportLOSSection`): LOS 결과 테이블 (차단/양호 배지)
7. **장애물 분석** (`ReportPanoramaSection`): 360° 파노라마 SVG 차트, 8방위 요약 테이블, 상위 15건 건물 목록
8. **기상 조건** (`ReportWeatherSection`): 시간별 기상 테이블, 덕팅 위험
9. **기체 현황** (`ReportAircraftSection`): 비행검사기 현황 테이블

### 공통 컴포넌트
- `ReportPage`: A4 페이지 래퍼 (210×297mm, `data-page` 속성)
- `EditableText`: contentEditable 인라인 텍스트 편집
- `useReportExport`: PDF 내보내기 훅 (페이지 자동 분할, 페이지 번호 삽입)

## 비행 통합 로직 (src/utils/flightConsolidation.ts)
- **`mergeFlightRecords()`**: OpenSky 같은 날 4시간 이내 출발/도착 분리 레코드 병합
- **`consolidateFlights()`**: mode_s+radar_name별 TrackPoint 그룹핑 → OpenSky 시간 매칭(±5분) → 미매칭 포인트 4시간 gap 분리
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
- **원시 데이터**: rawTrackPoints[] (파싱된 전체 항적 포인트)
- **비행**: flights[] (통합된 비행 목록, 핵심 분석 단위), mergeFlights(ids)
- **파싱 통계**: parseStatsList[] (파일별 파싱 통계)
- **레이더**: radarSite (현재 활성), customRadarSites[] (프리셋 + 사용자 등록, DB 영속화)
- **필터**: selectedModeS (null=등록기체, "__ALL__"=전체, 특정코드)
- **LOS**: losResults[] (저장된 LOS 프로파일)
- **ADS-B**: adsbTracks[], adsbLoading, adsbProgress
- **운항이력**: flightHistory[], flightHistoryLoading/Progress, selectedFlight
- **OpenSky 동기화**: openskySync, openskySyncProgress, openskySyncVersion (triggerOpenskySync)
- **커버리지**: coverageData, coverageVisible, coverageLoading, coverageProgress
- **기상**: weatherData, weatherLoading
- **구름 그리드**: cloudGrid, cloudGridVisible, cloudGridLoading, cloudGridProgress
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
- **weather_cache**: 일 단위 기상 캐시 (date, radar_lat, radar_lon, hourly_json)
- **cloud_grid_cache**: 구름 그리드 캐시 (grid_spacing_km 포함)
- **buildings**: GIS 건물 (region, centroid, bbox, height, address, usage)
- **building_import_log**: 임포트 로그 (region, file_date, record_count)
- **building_groups**: 건물 그룹 (name, color, memo)
- **manual_buildings**: 수동 건물 (geometry_type, geometry_json, group_id FK→building_groups)
- **srtm_tiles**: SRTM HGT 타일 BLOB (name PK, ~25MB/타일, 파일 폴백 호환)
- **elevation_cache**: 고도 캐시 (open-meteo 결과)

## 코딩 컨벤션
- Rust: snake_case, 에러 핸들링은 Result/Option 사용
- TypeScript: camelCase, 컴포넌트는 PascalCase
- CSS: Tailwind utility-first, 다크 테마 기본
- 한글 주석 사용
- 색상 테마: #1a1a2e(배경), #16213e(카드), #0f3460(강조), #e94560(하이라이트)
