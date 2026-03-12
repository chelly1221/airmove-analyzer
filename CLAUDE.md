# NEC 레이더 비행검사기 분석체계 (AirMove Analyzer)

## 프로젝트 개요
Tauri 기반 Windows Portable 데스크톱 애플리케이션으로, NEC 레이더 저장자료(RDRS ASS 파일)를 파싱하여 비행검사기의 항적을 분석하고, 항적 Loss 구간을 탐지/시각화하는 특화 분석 도구.

## 기술 스택
- **Frontend**: React + TypeScript + Vite
- **Backend**: Rust (Tauri)
- **Map**: Leaflet (OpenStreetMap / Carto Dark)
- **PDF**: jspdf + html2canvas (frontend) 또는 printpdf (Rust)
- **State**: Zustand

## 프로젝트 구조
```
src/                    # React frontend
src-tauri/src/          # Rust backend
  ├── lib.rs            # Tauri entry point
  ├── parser/           # ASS file parser
  ├── analysis/         # Loss detection, shadow analysis
  └── models/           # Data models
ass/                    # Reference ASS files (not committed)
docs/                   # Documentation
```

## 핵심 기능
1. 비행검사기 관리 (최대 10대, Mode-S 코드)
2. ASS 파일 파싱 (NEC RDRS 바이너리 포맷)
3. 항적 시각화 (Leaflet 지도)
4. Loss 구간 자동 탐지
5. Loss 원인 분석 (지형 음영, 장애물)
6. 음영지역 계산 (4/3 Earth Model)
7. 기간별/기체별 비교 분석
8. PDF 보고서 자동 생성

## ASS 파일 포맷 (ASTERIX CAT048)
- NEC RDRS 녹화 파일은 ASTERIX 형식의 데이터 블록을 포함
- NEC 프레임 헤더: `[월][일][시][분]` 4바이트 + 카운터 1바이트
- ASTERIX CAT048 (0x30): 모노레이더 타겟 보고 - 좌표/고도/속도/Mode-S
- ASTERIX CAT034 (0x22): 서비스 메시지
- ASTERIX CAT008 (0x08): 기상 데이터
- 좌표: I040 (극좌표 RHO/THETA) → 김포 레이더 기준 WGS-84 변환
- 시각: I140 (UTC 자정 기준 초), 고도: I090 (FL), Mode-S: I220 (24비트 ICAO)
- 참조 파일: ass/ 폴더

## 빌드 & 실행
```bash
npm install
npm run tauri dev     # 개발 모드
npm run tauri build   # 프로덕션 빌드
```

## 코딩 컨벤션
- Rust: snake_case, 에러 핸들링은 Result/Option 사용
- TypeScript: camelCase, 컴포넌트는 PascalCase
- 한글 주석 사용
