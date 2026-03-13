# NEC ASTERIX 비행검사기 항적분석체계

## 프로젝트 개요
Tauri 기반 **Windows Portable** 데스크톱 애플리케이션으로, NEC 레이더 저장자료(NEC ASS 파일)를 파싱하여 비행검사기의 항적을 분석하고, 항적 Loss 구간을 탐지/시각화하는 특화 분석 도구.

## 배포 형태
- **Windows Portable EXE** (설치 불필요, 단일 실행파일)
- 빌드 결과물: `src-tauri/target/release/airmove-analyzer.exe`
- 설치파일(NSIS) 생성하지 않음 — bundle targets: []

## 기술 스택
- **Frontend**: React + TypeScript + Vite
- **Backend**: Rust (Tauri v2)
- **Map**: deck.gl + react-map-gl (GPU 가속), MapLibre GL JS (좌표 선택용, 동심원/라벨)
- **PDF**: jspdf + html2canvas
- **State**: Zustand

## 프로젝트 구조
```
src/                    # React frontend
  ├── pages/            # 페이지 컴포넌트 (Dashboard, FileUpload, TrackMap, TrackList, ReportGeneration)
  ├── components/       # 공통 컴포넌트 (Layout, Map)
  ├── store/            # Zustand 전역 상태
  └── types/            # TypeScript 인터페이스
src-tauri/src/          # Rust backend
  ├── lib.rs            # Tauri entry point + IPC commands
  ├── parser/           # NEC ASS file parser (ASTERIX CAT048)
  │   └── ass.rs        # ASTERIX 파싱 핵심 로직 (I020/I040/I090/I140/I200/I220 등)
  ├── analysis/         # Loss detection, Line of Sight
  │   ├── loss.rs       # Loss 구간 탐지 + 레이더 범위 추정
  │   └── los.rs        # Line of Sight 계산 (4/3 Earth radius model)
  └── models/           # Data models (TrackPoint, LossSegment, AnalysisResult)
public/                 # 정적 자산
  ├── radar-icon.png    # 레이더 아이콘 (맵 표시용)
  └── favicon.svg       # 파비콘
ass/                    # Reference ASS files (not committed)
```

## 핵심 기능
1. 비행검사기 관리 (최대 10대, Mode-S 코드)
2. NEC ASS 파일 파싱 (ASTERIX CAT048 바이너리 포맷)
3. 항적 시각화 (deck.gl GPU 렌더링, SSR+PSR/SSR Only 색상 분리)
4. Loss 구간 자동 탐지 (Signal Loss만 표시, 범위이탈 미표시)
5. 레이더 사이트 관리 (좌표/고도/안테나높이/지원범위NM, 지도 클릭 등록)
6. 레이더 동심원 표시 (20NM 간격, 200NM까지, MapLibre 네이티브)
7. 레이더 아이콘 표시 (deck.gl IconLayer, billboard 모드)
8. 검색 가능한 Mode-S 드롭다운 필터
9. 비정상 항적 자동 제거 (포인트 10개 미만)
10. 기간별/기체별 비교 분석
11. PDF 보고서 자동 생성

## NEC ASS 파일 포맷 (ASTERIX CAT048)
- NEC RDRS 녹화 파일은 ASTERIX 형식의 데이터 블록을 포함
- NEC 프레임 헤더: `[월][일][시][분]` 4바이트 + 카운터 1바이트
- ASTERIX CAT048 (0x30): 모노레이더 타겟 보고 - 좌표/고도/속도/Mode-S
- ASTERIX CAT034 (0x22): 서비스 메시지
- ASTERIX CAT008 (0x08): 기상 데이터
- I020: Target Report Descriptor → `radar_type` (psr/ssr/combined/modes)
- I040: 극좌표 RHO/THETA → 레이더 사이트 기준 WGS-84 변환
- I090: Flight Level (고도), I140: UTC 자정 기준 초
- I200: Ground Speed + Heading, I220: 24비트 ICAO Mode-S 주소
- NEC 프레임 탐지: 월+일만 매칭 (시/분은 유효범위 검증만)
- 참조 파일: ass/ 폴더

## 데이터 모델
### TrackPoint
`timestamp`, `mode_s`, `latitude`, `longitude`, `altitude`, `speed`, `heading`, `radar_type`(ssr/combined/psr/modes), `raw_data`

### RadarSite
`name`, `latitude`, `longitude`, `altitude`, `antenna_height`, `range_nm`(제원상 지원범위 NM)

### LossSegment
`mode_s`, `start_time`/`end_time`, 좌표, `duration_secs`, `distance_km`, `loss_type`(signal_loss/out_of_range)

## 맵 렌더링 구조
- **deck.gl 레이어** (GPU 캔버스, 상위): PathLayer(항적), LineLayer(Loss), ScatterplotLayer(Loss점), IconLayer(레이더아이콘)
- **MapLibre 네이티브 레이어** (맵 캔버스, 하위): range-ring-lines(동심원), range-ring-labels(거리라벨), radar-center-label(사이트명)
- SSR+PSR Combined: 파란 계열 팔레트 (blue, emerald, violet, cyan...)
- SSR Only: 따뜻한 계열 팔레트 (amber, orange, yellow...)
- 동심원: 20NM 간격, 200NM까지, `rgba(100,200,255,0.4)`

## 빌드 & 실행
```bash
npm install
npm run tauri dev       # 개발 모드
npm run tauri build     # 프로덕션 빌드 (Windows Portable EXE)
```
빌드 결과: `src-tauri/target/release/airmove-analyzer.exe`
- WSL에서 빌드 시: `cmd.exe /c "set PATH=%USERPROFILE%\.cargo\bin;%PATH% && cd /d C:\code\airmove-analyzer && npm run tauri build"`

## 코딩 컨벤션
- Rust: snake_case, 에러 핸들링은 Result/Option 사용
- TypeScript: camelCase, 컴포넌트는 PascalCase
- 한글 주석 사용
