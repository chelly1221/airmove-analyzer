# AirMove Analyzer

레이더 비행검사기 분석체계 - Tauri 기반 Windows 데스크톱 애플리케이션

## 주요 기능

- **ASS 파일 파싱**: RDRS 녹화 파일(ASTERIX CAT048) 바이너리 파싱
- **항적 시각화**: Leaflet 지도 위 비행검사기 항적 표시 (재생/필터링)
- **Loss 구간 탐지**: Mode-S 코드별 항적 Loss 자동 탐지 및 분석
- **비행검사기 관리**: 최대 10대 기체 등록 (Mode-S 코드 기반)
- **PDF 보고서**: 분석 결과 자동 보고서 생성

## 기술 스택

| 구분 | 기술 |
|------|------|
| Frontend | React 19, TypeScript, Vite 7, Tailwind CSS 4 |
| Backend | Rust, Tauri v2 |
| 지도 | Leaflet (react-leaflet) |
| 상태관리 | Zustand |
| PDF | jsPDF + html2canvas |

## 빌드

```bash
# 의존성 설치
npm install

# 개발 모드
npm run tauri dev

# 프로덕션 빌드 (Windows)
npm run tauri build
```

## 프로젝트 구조

```
src/                    # React 프론트엔드
  ├── pages/            # 페이지 컴포넌트
  ├── components/       # 공통 컴포넌트
  ├── store/            # Zustand 상태 관리
  └── types/            # TypeScript 타입 정의
src-tauri/src/          # Rust 백엔드
  ├── parser/           # ASTERIX CAT048 파서
  ├── analysis/         # Loss 탐지 & 음영 분석
  └── models/           # 데이터 모델
```

## ASS 파일 포맷

RDRS 녹화 파일은 EUROCONTROL ASTERIX 형식의 데이터 블록을 포함합니다.

- **프레임 헤더**: `[월][일][시][분]` 4바이트 + 카운터 1바이트
- **ASTERIX CAT048**: 모노레이더 타겟 보고 (좌표, 고도, 속도, Mode-S)
- **좌표 변환**: 극좌표(RHO/THETA) → 김포 레이더 기준 WGS-84

## 라이선스

Private
