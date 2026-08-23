//! PSR(1차 레이더) 채널 분석 — 추적기 트랙(I161) 단위로 PSR 탐지/소실을 SSR 과 독립 평가.
//!
//! 입력은 ASTERIX 통계 상세 스캔(`parser::ass::asterix_detail_scan`)이 **필터를 통과한 레코드**에서
//! 모아 준 경량 표적보고(`PsrScanReport`)다. 좌표는 위경도가 아니라 극좌표 평면
//! (x = ρ·sinθ, y = ρ·cosθ, 단위 **NM**)에서 직접 계산한다 — 레이더 원점 기준 상대 기하만
//! 쓰므로 레이더 위경도·자편각이 필요 없다.
//!
//! 알고리즘 원본 = 2026-08-23 TS 워커 `analyzePsr`(김포 260602 실측으로 상수 보정)를 그대로 이식.
//! 전수 처리(다운샘플링·상한 없음) — 상한은 표 **전송** 단계에만 둔다.
//! 폴백 금지: 스캔주기 추정 불가·PSR 탐지 0건은 `analysis_skipped_reason` 으로 드러내고
//! 소실 분석을 생략한다(임의 기본 주기로 대체하지 않는다).

use serde::Serialize;
use std::cmp::Ordering;

// ─── 상수 (TS 워커와 1:1, 단위만 km→NM) ────────────────────────────────────

/// 같은 트랙번호라도 이 이상 끊기면 번호 재사용으로 간주해 분할 (초)
const TRACK_SPLIT_GAP_S: f64 = 60.0;
/// 연속 보고 간 암시속도(거리/Δt) 초과 시 분할 (NM/s — 0.35km/s ≈ 0.189NM/s ≈ 680kt)
const SPLIT_SPEED_NM_PER_S: f64 = 0.189;
/// 분할 게이트의 거리 비례 방위 잡음 허용치 (rad, ≈0.6° = 방위 측정오차 ~0.3° 의 2σ).
/// 허용 이동거리 = 속도항(0.189·Δt NM) + 잡음항(0.0105·레이더거리 NM). 2026-08-23 김포 260602 실측:
/// 속도항만 쓰면 원거리(150NM+) 항적의 방위 지터가 같은 Mode-S 인데도 9,127건 오분할됐고,
/// 이 항을 더하면 오분할 10건·다른 Mode-S 실분할 203건(206건 중)이 유지된다.
const SPLIT_AZ_NOISE_RAD: f64 = 0.0105;
/// 같은 트랙 내 dt 미만 보고는 동일 스캔으로 병합 (초, 대표는 PSR 포함 typ 우선)
const SAME_SCAN_S: f64 = 1.0;
/// 스캔주기 추정에 쓰는 트랙 최소 스캔 수 / dt 유효 범위 (기존 estimateScanInterval 과 동일 기준)
const MIN_SCANS_FOR_PERIOD: usize = 5;
const SCAN_DT_MIN_S: f64 = 0.5;
const SCAN_DT_MAX_S: f64 = 30.0;
/// 순수 gap 의 속도편차 게이트 (기존 Loss 알고리즘 analysis/loss.rs 와 동일 비율)
const SPEED_DEVIATION_RATIO: f64 = 0.5;
/// PSR 탐지 typ 비트마스크 — typ ∈ {1,3,6,7} (1=PSR단독, 3=SSR+PSR, 6=올콜+PSR, 7=롤콜+PSR)
const PSR_TYP_MASK: u8 = 0b1100_1010;
/// SSR 단독 typ 비트마스크 — typ ∈ {2,4,5}. "트랙은 살아있는데 PSR 이 못 봤다"는 증거
const SSR_ONLY_TYP_MASK: u8 = 0b0011_0100;

/// 소실 판정 기본 임계 (초) — `AsterixDetailFilter.psrLossThresholdSecs` 미지정 시 사용
pub const DEFAULT_LOSS_THRESHOLD_S: f64 = 7.0;

/// 거리 빈 폭(NM)/개수 — 상세 스캔 PPI 격자(RANGE_GRID_BINS)와 동일 격자여야 한다
pub const RANGE_BIN_NM: f64 = 5.0;
pub const RANGE_BINS: usize = 52;
/// 방위 빈 폭(도)/개수 — 상세 스캔 PPI 격자(AZ_GRID_SECTORS)와 동일 격자여야 한다
pub const AZ_BIN_DEG: f64 = 5.0;
pub const AZ_BINS: usize = 72;

/// 트랙/소실 표 전송 상한 (집계 자체는 전수)
const TRACKS_MAX: usize = 2000;
const LOSSES_MAX: usize = 2000;

/// `PsrScanReport.mode3a` 없음 센티널 (Mode 3/A 는 12bit 라 0xFFFF 와 충돌 없음)
pub const NO_MODE3A: u16 = 0xFFFF;

/// 소실 구간 종류 — 직렬화 문자열 (프런트 계약)
const KIND_INTERIOR: &str = "interior";
const KIND_HEAD: &str = "head";
const KIND_TAIL: &str = "tail";

/// 분석 생략 사유 (폴백 대신 명시)
const REASON_NO_REPORTS: &str = "PSR 채널 표적보고 없음 — 트랙번호·극좌표·시각을 갖춘 CAT048 레코드가 없습니다";
const REASON_NO_SCAN_PERIOD: &str = "스캔주기 추정 불가 — 표본 부족";
const REASON_NO_PSR: &str = "PSR 탐지 보고 없음";

// ─── 입력 ────────────────────────────────────────────────────────────────

/// 상세 스캔이 모아 주는 경량 표적보고 (10M+ 규모 전제 — 32바이트/건).
#[derive(Clone, Copy, Debug)]
pub struct PsrScanReport {
    /// 절대 Unix 초 (I140 abs_time)
    pub abs_time: f64,
    /// I040 ρ (NM)
    pub rho_nm: f32,
    /// I040 θ (도, 0~360)
    pub theta_deg: f32,
    /// I200 대지속도 (kt) — 없으면 0
    pub speed_kts: f32,
    /// I161 트랙번호
    pub track_number: u16,
    /// I020 TYP 1..=7
    pub typ: u8,
    /// I220 Mode-S 주소 — 0 = 없음
    pub mode_s: u32,
    /// I070 Mode 3/A — `NO_MODE3A`(0xFFFF) = 없음
    pub mode3a: u16,
}

// ─── 출력 (프런트 `src/types/asterixDetail.ts` 와 1:1, serde snake_case) ──────

/// 거리 구간(5NM) 집계
#[derive(Serialize, Clone, Debug)]
pub struct PsrRangeBin {
    pub from_nm: f64,
    pub to_nm: f64,
    /// 전 트랙 스캔 전수
    pub reports: u64,
    pub psr: u64,
    /// 이 구간(런 최소 ρ 기준)에 귀속된 signal_loss 시간
    pub loss_time_s: f64,
}

/// 방위 구간(5°) 집계 — reports/psr 은 **PSR 최대범위(p95) 이내 스캔만**
#[derive(Serialize, Clone, Debug)]
pub struct PsrAzBin {
    pub from_deg: f64,
    pub to_deg: f64,
    pub reports: u64,
    pub psr: u64,
    /// 이 구간(런 중점 방위 기준)에 귀속된 signal_loss 시간
    pub loss_time_s: f64,
}

/// 트랙 1건 (loss_time_s 내림차순, 상한 `TRACKS_MAX`)
#[derive(Serialize, Clone, Debug)]
pub struct PsrTrackRow {
    pub track_number: u16,
    /// 최빈 Mode-S (hex 6자리)
    pub mode_s: Option<String>,
    /// 최빈 Mode 3/A (옥탈 4자리)
    pub mode3a: Option<String>,
    pub start_ts: f64,
    pub end_ts: f64,
    /// 스캔 수 (동일 스캔 병합 후)
    pub report_count: u32,
    pub psr_count: u32,
    pub psr_only_count: u32,
    pub ssr_only_count: u32,
    pub min_range_nm: f64,
    pub max_range_nm: f64,
    /// psr_count / report_count
    pub psr_rate: f64,
    pub loss_count: u32,
    pub loss_time_s: f64,
    pub never_psr: bool,
    /// 전 스캔이 typ==1 (PSR 단독)
    pub psr_exclusive: bool,
}

/// 소실 런 1건 — signal_loss 만 수록 (duration_s 내림차순, 상한 `LOSSES_MAX`)
#[derive(Serialize, Clone, Debug)]
pub struct PsrLossRow {
    pub track_number: u16,
    pub mode_s: Option<String>,
    /// "interior" | "head" | "tail"
    pub kind: String,
    pub start_ts: f64,
    pub end_ts: f64,
    pub duration_s: f64,
    pub missed_scans: u32,
    /// 런 구간(양끝 포함)의 SSR 단독 스캔 수 = 트랙 생존 증거
    pub ssr_reports_inside: u32,
    pub start_range_nm: f64,
    pub end_range_nm: f64,
    pub min_range_nm: f64,
    pub mid_azimuth_deg: f64,
}

/// PSR 채널 집계 (`AsterixDetailStats.psr_channel`)
#[derive(Serialize, Clone, Debug)]
pub struct PsrChannelStats {
    /// 스캔(동일 스캔 병합 후) 수
    pub reports_total: u64,
    pub reports_psr: u64,
    pub reports_psr_only: u64,
    pub reports_ssr_only: u64,
    /// 동일 스캔으로 병합돼 사라진 보고 수
    pub same_scan_merged: u64,
    pub tracks_total: u64,
    pub tracks_with_psr: u64,
    pub tracks_never_psr: u64,
    /// 전 스캔이 typ==1 인 트랙 수
    pub tracks_psr_exclusive: u64,
    pub tracks_split_gap: u64,
    pub tracks_split_mode_s: u64,
    pub tracks_split_speed: u64,
    /// 스캔주기 추정치 (초) — 표본 부족 시 None(폴백 금지)
    pub scan_period_s: Option<f64>,
    /// PSR 탐지 스캔 ρ 의 p95 (NM, 클램프 없음)
    pub psr_max_range_nm: f64,
    pub loss_threshold_s: f64,
    /// PSR 있는 트랙의 추적시간 합
    pub total_track_time_s: f64,
    /// signal_loss 런 시간 합
    pub total_loss_time_s: f64,
    pub loss_rate: f64,
    pub loss_runs_signal: u64,
    pub loss_runs_out_of_range: u64,
    /// Σin_range_psr / Σin_range_report (PSR 있는 트랙 한정)
    pub psr_detect_rate_in_range: f64,
    pub range_bins: Vec<PsrRangeBin>,
    pub az_bins: Vec<PsrAzBin>,
    /// PPI 격자 — idx = az*RANGE_BINS + r, 전 스캔 (탐지율 = ppi_psr/ppi_reports)
    pub ppi_reports: Vec<u64>,
    pub ppi_psr: Vec<u64>,
    pub tracks: Vec<PsrTrackRow>,
    pub tracks_truncated: bool,
    pub losses: Vec<PsrLossRow>,
    pub losses_truncated: bool,
    /// 소실 분석 생략 사유 (폴백 금지 — 있으면 소실 관련 수치는 미산출)
    pub analysis_skipped_reason: Option<String>,
}

impl PsrChannelStats {
    /// 빈 격자를 갖춘 초기 상태 (생략 경로에서도 프런트가 같은 구조를 받도록)
    fn new(loss_threshold_s: f64) -> Self {
        Self {
            reports_total: 0,
            reports_psr: 0,
            reports_psr_only: 0,
            reports_ssr_only: 0,
            same_scan_merged: 0,
            tracks_total: 0,
            tracks_with_psr: 0,
            tracks_never_psr: 0,
            tracks_psr_exclusive: 0,
            tracks_split_gap: 0,
            tracks_split_mode_s: 0,
            tracks_split_speed: 0,
            scan_period_s: None,
            psr_max_range_nm: 0.0,
            loss_threshold_s,
            total_track_time_s: 0.0,
            total_loss_time_s: 0.0,
            loss_rate: 0.0,
            loss_runs_signal: 0,
            loss_runs_out_of_range: 0,
            psr_detect_rate_in_range: 0.0,
            range_bins: new_range_bins(),
            az_bins: new_az_bins(),
            ppi_reports: vec![0u64; AZ_BINS * RANGE_BINS],
            ppi_psr: vec![0u64; AZ_BINS * RANGE_BINS],
            tracks: Vec::new(),
            tracks_truncated: false,
            losses: Vec::new(),
            losses_truncated: false,
            analysis_skipped_reason: None,
        }
    }
}

// ─── 소도구 ──────────────────────────────────────────────────────────────

fn new_range_bins() -> Vec<PsrRangeBin> {
    (0..RANGE_BINS)
        .map(|b| PsrRangeBin {
            from_nm: b as f64 * RANGE_BIN_NM,
            to_nm: (b + 1) as f64 * RANGE_BIN_NM,
            reports: 0,
            psr: 0,
            loss_time_s: 0.0,
        })
        .collect()
}

fn new_az_bins() -> Vec<PsrAzBin> {
    (0..AZ_BINS)
        .map(|b| PsrAzBin {
            from_deg: b as f64 * AZ_BIN_DEG,
            to_deg: (b + 1) as f64 * AZ_BIN_DEG,
            reports: 0,
            psr: 0,
            loss_time_s: 0.0,
        })
        .collect()
}

/// typ 이 PSR 탐지(1,3,6,7)인가
#[inline]
fn is_psr_typ(t: u8) -> bool {
    t <= 7 && (PSR_TYP_MASK >> t) & 1 == 1
}

/// typ 이 SSR 단독(2,4,5)인가 — 트랙 생존 증거
#[inline]
fn is_ssr_only_typ(t: u8) -> bool {
    t <= 7 && (SSR_ONLY_TYP_MASK >> t) & 1 == 1
}

/// 극좌표 평면 좌표 (NM) — x=동(ρ·sinθ), y=북(ρ·cosθ)
#[inline]
fn polar_xy(r: &PsrScanReport) -> (f64, f64) {
    let rho = r.rho_nm as f64;
    let th = (r.theta_deg as f64).to_radians();
    (rho * th.sin(), rho * th.cos())
}

/// 마지막 빈에 합산(빈 밖 폐기 금지 — 탐지율 분모 보존)
#[inline]
fn range_bin_of(nm: f64) -> usize {
    ((nm / RANGE_BIN_NM) as usize).min(RANGE_BINS - 1)
}

#[inline]
fn az_bin_of(deg: f64) -> usize {
    ((deg.rem_euclid(360.0) / AZ_BIN_DEG) as usize).min(AZ_BINS - 1)
}

fn median_of_sorted(v: &[f64]) -> f64 {
    let n = v.len();
    if n % 2 == 1 {
        v[(n - 1) / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

fn sort_f64(v: &mut [f64]) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
}

/// 등장 순서를 보존하는 소형 빈도표 (트랙당 고유값은 통상 1~2개)
#[inline]
fn bump<K: PartialEq + Copy>(v: &mut Vec<(K, u32)>, key: K) {
    for e in v.iter_mut() {
        if e.0 == key {
            e.1 += 1;
            return;
        }
    }
    v.push((key, 1));
}

/// 최빈값 (동률이면 먼저 만난 값 — TS Map 순회와 동일한 안정 규칙)
fn most_frequent<K: Copy>(v: &[(K, u32)]) -> Option<K> {
    let mut best: Option<(K, u32)> = None;
    for &(k, c) in v {
        let replace = match best {
            None => true,
            Some((_, bc)) => c > bc,
        };
        if replace {
            best = Some((k, c));
        }
    }
    best.map(|(k, _)| k)
}

/// 분할 전 원시 트랙 — scan_ref 상의 연속 슬라이스
struct RawTrack {
    tn: u16,
    first: usize,
    count: usize,
}

// ─── 본체 ────────────────────────────────────────────────────────────────

/// PSR 채널 분석. `reports` 는 (트랙번호, 시각)으로 제자리 정렬된다.
pub fn analyze(reports: &mut Vec<PsrScanReport>, threshold_s: f64) -> PsrChannelStats {
    let mut stats = PsrChannelStats::new(threshold_s);
    if reports.is_empty() {
        stats.analysis_skipped_reason = Some(REASON_NO_REPORTS.to_string());
        return stats;
    }

    // ── 1. (트랙번호, 시각) 정렬 ─────────────────────────────────────────
    //    안정 정렬(sort_by)로 동률(같은 트랙·같은 시각)은 원본 수집 순서를 보존한다 —
    //    동일 스캔 병합 대표 선택·최빈값 동률 처리의 결정성을 TS 참조 구현과 맞춘다.
    reports.sort_by(|a, b| {
        a.track_number.cmp(&b.track_number).then_with(|| {
            a.abs_time
                .partial_cmp(&b.abs_time)
                .unwrap_or(Ordering::Equal)
        })
    });
    let rep: &[PsrScanReport] = reports.as_slice();
    let n = rep.len();

    // ── 2·3. 트랙 분할 + 동일 스캔 병합 ────────────────────────────────
    //    scan_ref = 트랙 생성 순으로 이어붙인 "스캔 대표 보고"의 인덱스.
    //    트랙별로 연속 슬라이스이므로 그대로 RawTrack{first,count} 레이아웃이 된다.
    let mut scan_ref: Vec<u32> = Vec::with_capacity(n);
    let mut raw_tracks: Vec<RawTrack> = Vec::new();
    let mut i = 0usize;
    while i < n {
        let tn = rep[i].track_number;
        let mut end = i;
        while end < n && rep[end].track_number == tn {
            end += 1;
        }

        let mut track_start = scan_ref.len();
        let mut prev_report: Option<usize> = None;
        let mut cur_scan_pos: Option<usize> = None;

        for k in i..end {
            if let Some(p) = prev_report {
                let dt = rep[k].abs_time - rep[p].abs_time;
                let mut split = false;
                if dt > TRACK_SPLIT_GAP_S {
                    stats.tracks_split_gap += 1;
                    split = true;
                } else if rep[k].mode_s > 0
                    && rep[p].mode_s > 0
                    && rep[k].mode_s != rep[p].mode_s
                {
                    stats.tracks_split_mode_s += 1;
                    split = true;
                } else if dt >= SAME_SCAN_S {
                    // 속도 게이트는 동일 스캔 후보(dt < SAME_SCAN_S)엔 적용하지 않는다 —
                    // 같은 회전의 PSR/SSR 보고가 수백 m 어긋나면 Δt 가 작아 암시속도가 폭발해 허위 분할된다
                    let (x0, y0) = polar_xy(&rep[p]);
                    let (x1, y1) = polar_xy(&rep[k]);
                    let d = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
                    // 허용 이동거리 = 속도항 + 거리 비례 방위 잡음항 (원거리 지터 오분할 방지)
                    let range_nm = (rep[p].rho_nm.max(rep[k].rho_nm)) as f64;
                    let allowed = SPLIT_SPEED_NM_PER_S * dt + SPLIT_AZ_NOISE_RAD * range_nm;
                    if d > allowed {
                        stats.tracks_split_speed += 1;
                        split = true;
                    }
                }
                if split {
                    raw_tracks.push(RawTrack {
                        tn,
                        first: track_start,
                        count: scan_ref.len() - track_start,
                    });
                    track_start = scan_ref.len();
                    cur_scan_pos = None;
                }
            }

            let same_scan = match (cur_scan_pos, prev_report) {
                (Some(_), Some(p)) => rep[k].abs_time - rep[p].abs_time < SAME_SCAN_S,
                _ => false,
            };
            if same_scan {
                // 동일 스캔 — 대표는 PSR 포함 typ 우선(같은 회전의 SSR 보고와 PSR 보고가 나뉘어 온 경우)
                stats.same_scan_merged += 1;
                let pos = cur_scan_pos.expect("same_scan 은 cur_scan_pos 존재를 함의");
                let cur = scan_ref[pos] as usize;
                if !is_psr_typ(rep[cur].typ) && is_psr_typ(rep[k].typ) {
                    scan_ref[pos] = k as u32;
                }
            } else {
                cur_scan_pos = Some(scan_ref.len());
                scan_ref.push(k as u32);
            }
            prev_report = Some(k);
        }

        if scan_ref.len() > track_start {
            raw_tracks.push(RawTrack {
                tn,
                first: track_start,
                count: scan_ref.len() - track_start,
            });
        }
        i = end;
    }

    stats.reports_total = scan_ref.len() as u64;
    stats.tracks_total = raw_tracks.len() as u64;

    // ── 4. 스캔 단위 집계 (거리 빈·PPI 격자는 p95 와 무관하므로 선행) ──────
    //    거리 빈은 전 트랙(never_psr 포함) 스캔 전수 — OM PSR율과 같은 분모 철학
    let mut psr_ranges: Vec<f64> = Vec::new();
    for &s in &scan_ref {
        let r = &rep[s as usize];
        let nm = r.rho_nm as f64;
        let psr = is_psr_typ(r.typ);
        if psr {
            stats.reports_psr += 1;
            psr_ranges.push(nm);
        }
        if r.typ == 1 {
            stats.reports_psr_only += 1;
        }
        if is_ssr_only_typ(r.typ) {
            stats.reports_ssr_only += 1;
        }
        let rb = range_bin_of(nm);
        stats.range_bins[rb].reports += 1;
        let ab = az_bin_of(r.theta_deg as f64);
        stats.ppi_reports[ab * RANGE_BINS + rb] += 1;
        if psr {
            stats.range_bins[rb].psr += 1;
            stats.ppi_psr[ab * RANGE_BINS + rb] += 1;
        }
    }

    // ── 5. 스캔주기 T — 트랙별 dt 중앙값들의 중앙값 (기본값 폴백 금지) ─────
    let mut track_medians: Vec<f64> = Vec::new();
    let mut dts: Vec<f64> = Vec::new();
    for tr in &raw_tracks {
        if tr.count < MIN_SCANS_FOR_PERIOD {
            continue;
        }
        dts.clear();
        for j in (tr.first + 1)..(tr.first + tr.count) {
            let dt = rep[scan_ref[j] as usize].abs_time - rep[scan_ref[j - 1] as usize].abs_time;
            if dt > SCAN_DT_MIN_S && dt < SCAN_DT_MAX_S {
                dts.push(dt);
            }
        }
        if dts.is_empty() {
            continue;
        }
        sort_f64(&mut dts);
        track_medians.push(median_of_sorted(&dts));
    }
    if track_medians.is_empty() {
        stats.analysis_skipped_reason = Some(REASON_NO_SCAN_PERIOD.to_string());
        return stats;
    }
    sort_f64(&mut track_medians);
    let scan_period = median_of_sorted(&track_medians);
    stats.scan_period_s = Some(scan_period);

    // ── 6. PSR 최대범위 = PSR 탐지 스캔 ρ 의 p95 (하한 클램프 없음 — 실측값 그대로) ──
    if psr_ranges.is_empty() {
        stats.analysis_skipped_reason = Some(REASON_NO_PSR.to_string());
        return stats;
    }
    sort_f64(&mut psr_ranges);
    let p95_idx = ((psr_ranges.len() as f64 * 0.95).floor() as usize).min(psr_ranges.len() - 1);
    let psr_max_range_nm = psr_ranges[p95_idx];
    stats.psr_max_range_nm = psr_max_range_nm;
    drop(psr_ranges);

    // ── 7. 방위 빈 — PSR 최대범위(p95) 이내 스캔만.
    //    방위별 차단/음영 비교가 목적이라 범위 밖 원거리 통행량이 섹터별 탐지율을 뒤섞지 않게 한다
    //    (거리 빈은 거리 자체로 분해되므로 전수 그대로 둔다).
    for &s in &scan_ref {
        let r = &rep[s as usize];
        if (r.rho_nm as f64) < psr_max_range_nm {
            let ab = az_bin_of(r.theta_deg as f64);
            stats.az_bins[ab].reports += 1;
            if is_psr_typ(r.typ) {
                stats.az_bins[ab].psr += 1;
            }
        }
    }

    // ── 8. 트랙별 통계 + 소실 런 ────────────────────────────────────────
    let mut track_rows: Vec<PsrTrackRow> = Vec::with_capacity(raw_tracks.len());
    let mut loss_rows: Vec<PsrLossRow> = Vec::new();
    let mut in_range_report_sum: u64 = 0;
    let mut in_range_psr_sum: u64 = 0;

    let mut ms_freq: Vec<(u32, u32)> = Vec::new();
    let mut m3_freq: Vec<(u16, u32)> = Vec::new();
    let mut psr_pos: Vec<usize> = Vec::new();
    let mut runs: Vec<(&'static str, usize, usize)> = Vec::new();

    for tr in &raw_tracks {
        let base = tr.first;
        let cnt = tr.count;

        ms_freq.clear();
        m3_freq.clear();
        let mut psr_count = 0u32;
        let mut psr_only = 0u32;
        let mut ssr_only = 0u32;
        let mut min_range = f64::INFINITY;
        let mut max_range = f64::NEG_INFINITY;
        let mut in_range_reports = 0u32;
        let mut in_range_psr = 0u32;

        for j in 0..cnt {
            let r = &rep[scan_ref[base + j] as usize];
            let nm = r.rho_nm as f64;
            let psr = is_psr_typ(r.typ);
            if psr {
                psr_count += 1;
            }
            if r.typ == 1 {
                psr_only += 1;
            }
            if is_ssr_only_typ(r.typ) {
                ssr_only += 1;
            }
            if nm < min_range {
                min_range = nm;
            }
            if nm > max_range {
                max_range = nm;
            }
            if nm < psr_max_range_nm {
                in_range_reports += 1;
                if psr {
                    in_range_psr += 1;
                }
            }
            if r.mode_s > 0 {
                bump(&mut ms_freq, r.mode_s);
            }
            if r.mode3a != NO_MODE3A {
                bump(&mut m3_freq, r.mode3a);
            }
        }

        let start_ts = rep[scan_ref[base] as usize].abs_time;
        let end_ts = rep[scan_ref[base + cnt - 1] as usize].abs_time;
        let never_psr = psr_count == 0;
        // SSR 0건 트랙 = 모든 스캔이 typ==1 (typ 3/6/7 은 SSR 성분을 포함한다)
        let psr_exclusive = psr_only as usize == cnt;
        if psr_exclusive {
            stats.tracks_psr_exclusive += 1;
        }

        let mut row = PsrTrackRow {
            track_number: tr.tn,
            mode_s: most_frequent(&ms_freq).map(|m| format!("{:06X}", m)),
            mode3a: most_frequent(&m3_freq).map(|c| format!("{:04o}", c)),
            start_ts,
            end_ts,
            report_count: cnt as u32,
            psr_count,
            psr_only_count: psr_only,
            ssr_only_count: ssr_only,
            min_range_nm: min_range,
            max_range_nm: max_range,
            psr_rate: if cnt > 0 {
                psr_count as f64 / cnt as f64
            } else {
                0.0
            },
            loss_count: 0,
            loss_time_s: 0.0,
            never_psr,
            psr_exclusive,
        };

        if never_psr {
            // PSR 탐지 0건 — 런을 만들지 않고 시간 합산에서도 제외한다(분모 오염 방지)
            stats.tracks_never_psr += 1;
        } else {
            stats.tracks_with_psr += 1;
            stats.total_track_time_s += end_ts - start_ts;
            in_range_report_sum += in_range_reports as u64;
            in_range_psr_sum += in_range_psr as u64;

            // PSR 탐지 스캔 위치 (트랙 내 상대 인덱스)
            psr_pos.clear();
            for j in 0..cnt {
                if is_psr_typ(rep[scan_ref[base + j] as usize].typ) {
                    psr_pos.push(j);
                }
            }
            let time_at = |j: usize| rep[scan_ref[base + j] as usize].abs_time;
            let in_range_at = |j: usize| {
                (rep[scan_ref[base + j] as usize].rho_nm as f64) < psr_max_range_nm
            };

            runs.clear();
            // head — PSR 최대범위 안에 들어온 첫 스캔 ~ 첫 PSR 탐지.
            // 트랙 시작점이 아니라 **범위 내 첫 스캔**부터 잰다: 원거리에서 SSR 로만 보이다
            // 범위 안으로 접근해 PSR 이 잡히기까지의 구간은 PSR 의 탐지 실패가 아니다.
            let p0 = psr_pos[0];
            let mut h0 = 0usize;
            while h0 < p0 && !in_range_at(h0) {
                h0 += 1;
            }
            if h0 < p0 && time_at(p0) - time_at(h0) > threshold_s {
                runs.push((KIND_HEAD, h0, p0));
            }
            // interior — 연속 PSR 탐지 사이의 임계 초과 공백
            for q in 0..psr_pos.len().saturating_sub(1) {
                let a = psr_pos[q];
                let b = psr_pos[q + 1];
                if time_at(b) - time_at(a) > threshold_s {
                    runs.push((KIND_INTERIOR, a, b));
                }
            }
            // tail — 마지막 PSR 탐지 ~ 범위 안에 있던 마지막 스캔 (head 와 대칭)
            let pk = psr_pos[psr_pos.len() - 1];
            let mut t_last = cnt - 1;
            while t_last > pk && !in_range_at(t_last) {
                t_last -= 1;
            }
            if t_last > pk && time_at(t_last) - time_at(pk) > threshold_s {
                runs.push((KIND_TAIL, pk, t_last));
            }

            for &(kind, a_rel, b_rel) in runs.iter() {
                let a = &rep[scan_ref[base + a_rel] as usize];
                let b = &rep[scan_ref[base + b_rel] as usize];
                let t0 = a.abs_time;
                let t1 = b.abs_time;
                let duration = t1 - t0;

                // ssr_reports_inside 는 이 구간(양끝 포함)의 SSR 단독 스캔 수:
                // interior 는 양끝이 PSR 스캔이라 "양끝 제외" 정의와 값이 같고,
                // head/tail 은 비-PSR 끝점(= 트랙 생존 증거)이 포함된다.
                let mut ssr_inside = 0u32;
                let mut run_min_range = f64::INFINITY;
                for j in a_rel..=b_rel {
                    let r = &rep[scan_ref[base + j] as usize];
                    if is_ssr_only_typ(r.typ) {
                        ssr_inside += 1;
                    }
                    let nm = r.rho_nm as f64;
                    if nm < run_min_range {
                        run_min_range = nm;
                    }
                }

                let (xa, ya) = polar_xy(a);
                let (xb, yb) = polar_xy(b);
                let signal_loss = if run_min_range >= psr_max_range_nm {
                    // 런 전 구간이 PSR 최대범위 밖 — 탐지 실패가 아니라 범위 밖
                    false
                } else if kind == KIND_INTERIOR && ssr_inside == 0 {
                    // 순수 gap(트랙 생존 증거 없음)에 한해 기존 Loss 알고리즘의 속도편차 게이트를 적용
                    let prev_speed = a.speed_kts as f64;
                    let gap_dist_nm = ((xb - xa).powi(2) + (yb - ya).powi(2)).sqrt();
                    let implied_kts = if duration > 0.0 {
                        gap_dist_nm / duration * 3600.0
                    } else {
                        0.0
                    };
                    let deviation = if prev_speed > 10.0 {
                        (implied_kts - prev_speed).abs() / prev_speed
                    } else {
                        0.0
                    };
                    deviation <= SPEED_DEVIATION_RATIO
                } else {
                    true
                };

                let missed = if kind == KIND_INTERIOR {
                    ((duration / scan_period).round() as i64 - 1).max(1) as u32
                } else {
                    ((duration / scan_period).round() as i64).max(1) as u32
                };
                // 런 중점 방위 = 시작·끝 극좌표 평면 좌표의 평균
                let mid_az = ((xa + xb) / 2.0)
                    .atan2((ya + yb) / 2.0)
                    .to_degrees()
                    .rem_euclid(360.0);

                if signal_loss {
                    stats.loss_runs_signal += 1;
                    stats.total_loss_time_s += duration;
                    row.loss_count += 1;
                    row.loss_time_s += duration;
                    stats.range_bins[range_bin_of(run_min_range)].loss_time_s += duration;
                    stats.az_bins[az_bin_of(mid_az)].loss_time_s += duration;
                    loss_rows.push(PsrLossRow {
                        track_number: tr.tn,
                        mode_s: row.mode_s.clone(),
                        kind: kind.to_string(),
                        start_ts: t0,
                        end_ts: t1,
                        duration_s: duration,
                        missed_scans: missed,
                        ssr_reports_inside: ssr_inside,
                        start_range_nm: a.rho_nm as f64,
                        end_range_nm: b.rho_nm as f64,
                        min_range_nm: run_min_range,
                        mid_azimuth_deg: mid_az,
                    });
                } else {
                    // out_of_range 런은 건수만 — 목록 제외
                    stats.loss_runs_out_of_range += 1;
                }
            }
        }

        track_rows.push(row);
    }

    stats.loss_rate = if stats.total_track_time_s > 0.0 {
        stats.total_loss_time_s / stats.total_track_time_s
    } else {
        0.0
    };
    stats.psr_detect_rate_in_range = if in_range_report_sum > 0 {
        in_range_psr_sum as f64 / in_range_report_sum as f64
    } else {
        0.0
    };

    // 트랙 표 — 소실시간 내림차순 (동률은 시작시각·트랙번호로 결정적 정렬)
    track_rows.sort_by(|a, b| {
        b.loss_time_s
            .partial_cmp(&a.loss_time_s)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                a.start_ts
                    .partial_cmp(&b.start_ts)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| a.track_number.cmp(&b.track_number))
    });
    stats.tracks_truncated = track_rows.len() > TRACKS_MAX;
    track_rows.truncate(TRACKS_MAX);
    stats.tracks = track_rows;

    // 소실 표 — 지속시간 내림차순 (동률은 시작시각)
    loss_rows.sort_by(|a, b| {
        b.duration_s
            .partial_cmp(&a.duration_s)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                a.start_ts
                    .partial_cmp(&b.start_ts)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| a.track_number.cmp(&b.track_number))
    });
    stats.losses_truncated = loss_rows.len() > LOSSES_MAX;
    loss_rows.truncate(LOSSES_MAX);
    stats.losses = loss_rows;

    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(t: f64, tn: u16, typ: u8, rho: f32, theta: f32) -> PsrScanReport {
        PsrScanReport {
            abs_time: t,
            rho_nm: rho,
            theta_deg: theta,
            speed_kts: 0.0,
            track_number: tn,
            typ,
            mode_s: 0,
            mode3a: NO_MODE3A,
        }
    }

    /// 합성 자료로 §1 규칙 전수 검증:
    /// 트랙1 = 무손실 PSR 전용, 트랙2 = head/interior/tail 소실, 트랙3 = 범위 밖(out_of_range),
    /// 트랙4/5/6 = 분할 3사유(공백·Mode-S·속도), 트랙7 = 동일 스캔 병합.
    #[test]
    fn test_psr_channel_synthetic() {
        let mut v: Vec<PsrScanReport> = Vec::new();

        // 트랙1 — 20스캔, 4초 주기, 전부 typ=1(PSR 단독), ρ=8NM
        for k in 0..20 {
            v.push(mk(k as f64 * 4.0, 1, 1, 8.0, 0.0));
        }
        // 트랙2 — ρ=20NM, θ=90°. SSR(2)/PSR(1) 배치로 head·interior·tail 생성
        //   t: 0,4,8 = SSR / 12 = PSR / 16,20,24 = SSR / 28 = PSR / 32,36,40 = SSR
        for (k, typ) in [2u8, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2].iter().enumerate() {
            v.push(mk(k as f64 * 4.0, 2, *typ, 20.0, 90.0));
        }
        // 트랙3 — ρ=200NM(전 구간 p95 밖), 양끝 PSR + 내부 SSR → interior 이지만 out_of_range
        for (k, typ) in [1u8, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1].iter().enumerate() {
            v.push(mk(k as f64 * 4.0, 3, *typ, 200.0, 180.0));
        }
        // 트랙4 — 공백 분할 (Δt=100s > 60s)
        v.push(mk(0.0, 4, 2, 10.0, 0.0));
        v.push(mk(100.0, 4, 2, 10.0, 0.0));
        // 트랙5 — Mode-S 분할 (양쪽 존재·상이)
        let mut a = mk(0.0, 5, 2, 10.0, 0.0);
        a.mode_s = 0xABCDEF;
        let mut b = mk(4.0, 5, 2, 10.0, 0.0);
        b.mode_s = 0x123456;
        v.push(a);
        v.push(b);
        // 트랙6 — 속도 분할 (Δt=4s, 이동 14.1NM > 허용 0.189*4 + 0.0105*10 = 0.861NM)
        v.push(mk(0.0, 6, 2, 10.0, 0.0));
        v.push(mk(4.0, 6, 2, 10.0, 90.0));
        // 트랙7 — 동일 스캔 병합 (t=0 SSR, t=0.5 PSR → 대표는 PSR), 이후 t=4 SSR
        v.push(mk(0.0, 7, 2, 10.0, 45.0));
        v.push(mk(0.5, 7, 1, 10.0, 45.0));
        v.push(mk(4.0, 7, 2, 10.0, 45.0));

        let s = analyze(&mut v, 7.0);
        assert!(s.analysis_skipped_reason.is_none(), "{:?}", s.analysis_skipped_reason);

        // 스캔주기 / p95 (PSR 스캔 24건: 8NM×20, 20NM×2, 200NM×2 → idx floor(22.8)=22 → 200)
        assert_eq!(s.scan_period_s, Some(4.0));
        assert_eq!(s.psr_max_range_nm, 200.0);
        assert_eq!(s.loss_threshold_s, 7.0);

        // 스캔·보고 집계
        assert_eq!(s.same_scan_merged, 1);
        assert_eq!(s.reports_total, 50);
        assert_eq!(s.reports_psr, 25);
        assert_eq!(s.reports_psr_only, 25);
        assert_eq!(s.reports_ssr_only, 25);

        // 트랙 분할 3사유
        assert_eq!(s.tracks_split_gap, 1);
        assert_eq!(s.tracks_split_mode_s, 1);
        assert_eq!(s.tracks_split_speed, 1);
        assert_eq!(s.tracks_total, 10);
        assert_eq!(s.tracks_with_psr, 4);
        assert_eq!(s.tracks_never_psr, 6);
        assert_eq!(s.tracks_psr_exclusive, 1);

        // 소실 런 — 트랙2 의 head/interior/tail 3건 + 트랙3 의 out_of_range 1건
        assert_eq!(s.loss_runs_signal, 3);
        assert_eq!(s.loss_runs_out_of_range, 1);
        assert!((s.total_loss_time_s - 40.0).abs() < 1e-9);
        assert!((s.total_track_time_s - 159.5).abs() < 1e-9);
        assert!((s.loss_rate - 40.0 / 159.5).abs() < 1e-12);

        // 범위 내 탐지율 — 트랙1 20/20, 트랙2 2/11, 트랙3 0/0(전부 범위 밖), 트랙7 1/2
        assert!((s.psr_detect_rate_in_range - 23.0 / 33.0).abs() < 1e-12);

        // 소실 목록 = signal_loss 만, 지속 내림차순
        assert_eq!(s.losses.len(), 3);
        assert_eq!(s.losses[0].kind, "interior");
        assert!((s.losses[0].duration_s - 16.0).abs() < 1e-9);
        assert_eq!(s.losses[0].missed_scans, 3); // round(16/4)-1
        assert_eq!(s.losses[0].ssr_reports_inside, 3);
        assert!((s.losses[0].mid_azimuth_deg - 90.0).abs() < 1e-6);
        assert_eq!(s.losses[1].kind, "head");
        assert!((s.losses[1].duration_s - 12.0).abs() < 1e-9);
        assert_eq!(s.losses[1].missed_scans, 3); // round(12/4)
        assert_eq!(s.losses[2].kind, "tail");
        assert!((s.losses[2].duration_s - 12.0).abs() < 1e-9);

        // 빈 귀속 — 트랙2 런 최소 ρ=20NM → 거리빈 4(20–25NM), 중점 방위 90° → 방위빈 18
        assert!((s.range_bins[4].loss_time_s - 40.0).abs() < 1e-9);
        assert!((s.az_bins[18].loss_time_s - 40.0).abs() < 1e-9);
        // 거리 빈 reports 합 = 전 스캔 수 (폐기 없음)
        let rb_sum: u64 = s.range_bins.iter().map(|b| b.reports).sum();
        assert_eq!(rb_sum, 50);
        // 방위 빈 reports 합 = 범위 내(ρ<200NM) 스캔 수 = 50 − 트랙3 11스캔
        let ab_sum: u64 = s.az_bins.iter().map(|b| b.reports).sum();
        assert_eq!(ab_sum, 39);
        // PPI 격자 합 = 전 스캔 수
        let ppi_sum: u64 = s.ppi_reports.iter().sum();
        assert_eq!(ppi_sum, 50);
        assert_eq!(s.ppi_reports.len(), AZ_BINS * RANGE_BINS);

        // 트랙 표 — 소실시간 내림차순 1위 = 트랙2
        assert_eq!(s.tracks.len(), 10);
        assert_eq!(s.tracks[0].track_number, 2);
        assert_eq!(s.tracks[0].loss_count, 3);
        assert!((s.tracks[0].loss_time_s - 40.0).abs() < 1e-9);
        assert_eq!(s.tracks[0].report_count, 11);
        assert_eq!(s.tracks[0].psr_count, 2);
        assert!(!s.tracks_truncated);
        assert!(!s.losses_truncated);
    }

    /// 입력 0건 / 스캔주기 표본 부족 — 폴백 없이 사유를 드러내야 한다.
    #[test]
    fn test_psr_channel_skip_reasons() {
        let mut empty: Vec<PsrScanReport> = Vec::new();
        let s = analyze(&mut empty, 7.0);
        assert!(s.analysis_skipped_reason.is_some());
        assert_eq!(s.scan_period_s, None);
        assert_eq!(s.range_bins.len(), RANGE_BINS);
        assert_eq!(s.az_bins.len(), AZ_BINS);

        // 스캔 4건짜리 트랙 하나 → MIN_SCANS_FOR_PERIOD(5) 미만 → 주기 추정 불가
        let mut few: Vec<PsrScanReport> = (0..4).map(|k| mk(k as f64 * 4.0, 1, 1, 10.0, 0.0)).collect();
        let s2 = analyze(&mut few, 7.0);
        assert_eq!(s2.analysis_skipped_reason.as_deref(), Some("스캔주기 추정 불가 — 표본 부족"));
        assert_eq!(s2.scan_period_s, None);
        // 생략돼도 스캔 단위 집계는 채워진다
        assert_eq!(s2.reports_total, 4);
        assert_eq!(s2.reports_psr, 4);

        // PSR 탐지 0건 (전부 SSR 단독) → 주기는 나오지만 PSR 채널 분석 생략
        let mut ssr: Vec<PsrScanReport> = (0..8).map(|k| mk(k as f64 * 4.0, 1, 2, 10.0, 0.0)).collect();
        let s3 = analyze(&mut ssr, 7.0);
        assert_eq!(s3.analysis_skipped_reason.as_deref(), Some("PSR 탐지 보고 없음"));
        assert_eq!(s3.scan_period_s, Some(4.0));
        assert_eq!(s3.reports_ssr_only, 8);
    }

    /// 실측 파일 회귀 — 김포 260602. 2026-08-23 TS 구현 실측: 4.93s / 57.0NM / 43,389건 / 92.0%.
    #[test]
    fn test_psr_channel_gimpo_260602_real_file() {
        let path = r"C:\shots_data\gimpo_260602_0943.ass";
        if !std::path::Path::new(path).exists() {
            eprintln!("skip: 데이터 파일 없음: {}", path);
            return;
        }
        let filter = crate::parser::ass::AsterixDetailFilter::default();
        let detail = crate::parser::ass::asterix_detail_scan(
            &[path.to_string()],
            &filter,
            |_, _, _| {},
        )
        .expect("상세 스캔 성공");
        let p = &detail.psr_channel;

        eprintln!("── PSR 채널 (김포 260602 실측) ──────────────");
        eprintln!("analysis_skipped_reason  = {:?}", p.analysis_skipped_reason);
        eprintln!("scan_period_s            = {:?}", p.scan_period_s);
        eprintln!("psr_max_range_nm (p95)   = {:.2} NM", p.psr_max_range_nm);
        eprintln!("loss_threshold_s         = {}", p.loss_threshold_s);
        eprintln!(
            "reports_total={} psr={} psr_only={} ssr_only={} same_scan_merged={}",
            p.reports_total, p.reports_psr, p.reports_psr_only, p.reports_ssr_only, p.same_scan_merged
        );
        eprintln!(
            "tracks_total={} with_psr={} never_psr={} psr_exclusive={}",
            p.tracks_total, p.tracks_with_psr, p.tracks_never_psr, p.tracks_psr_exclusive
        );
        eprintln!(
            "split: gap={} mode_s={} speed={}",
            p.tracks_split_gap, p.tracks_split_mode_s, p.tracks_split_speed
        );
        eprintln!(
            "psr_detect_rate_in_range = {:.4}  loss_rate = {:.6}",
            p.psr_detect_rate_in_range, p.loss_rate
        );
        eprintln!(
            "total_track_time_s={:.1} total_loss_time_s={:.1} runs signal={} out_of_range={}",
            p.total_track_time_s, p.total_loss_time_s, p.loss_runs_signal, p.loss_runs_out_of_range
        );
        eprintln!(
            "tracks rows={} (truncated={}) losses rows={} (truncated={})",
            p.tracks.len(), p.tracks_truncated, p.losses.len(), p.losses_truncated
        );

        assert!(p.analysis_skipped_reason.is_none());
        let period = p.scan_period_s.expect("스캔주기");
        assert!(
            (period - 4.93).abs() <= 0.1,
            "스캔주기 4.93±0.1 이어야 함, got {}",
            period
        );
        assert!(
            (55.0..=60.0).contains(&p.psr_max_range_nm),
            "PSR 최대범위(p95) 55~60NM 이어야 함, got {}",
            p.psr_max_range_nm
        );
        assert!(
            (40_000..=46_000).contains(&p.reports_psr_only),
            "TYP=1 스캔 수가 40k~46k 여야 함, got {}",
            p.reports_psr_only
        );
        assert!(
            (0.85..=0.97).contains(&p.psr_detect_rate_in_range),
            "범위 내 PSR 탐지율 0.85~0.97 이어야 함, got {}",
            p.psr_detect_rate_in_range
        );
        // 격자 계약
        assert_eq!(p.range_bins.len(), RANGE_BINS);
        assert_eq!(p.az_bins.len(), AZ_BINS);
        assert_eq!(p.ppi_reports.len(), AZ_BINS * RANGE_BINS);
        assert_eq!(p.ppi_psr.len(), AZ_BINS * RANGE_BINS);
        let rb_sum: u64 = p.range_bins.iter().map(|b| b.reports).sum();
        assert_eq!(rb_sum, p.reports_total, "거리 빈 합 = 전 스캔 수(폐기 금지)");
        let ppi_sum: u64 = p.ppi_reports.iter().sum();
        assert_eq!(ppi_sum, p.reports_total, "PPI 격자 합 = 전 스캔 수");
    }
}
