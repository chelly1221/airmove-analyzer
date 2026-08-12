//! V-World 3D 건물(XDO) 임포터 — 다운로드 → 3D Tiles(b3dm) 변환 → 로컬 서빙
//!
//! 시각화 전용 기능이다. BRA/LoS/커버리지/파노라마 등 분석 파이프라인에는 일절 관여하지 않고,
//! 결과물(`tileset.json` + `tiles/*.b3dm`)은 실측 3D 타일셋과 **동일한** Tiles3DLoader 가 소비한다.
//!
//! ## 프로토콜 (2026-08-12 실서버 검증)
//! - 타일 인덱스: `requestLayerNode?APIKey=..&Layer=facility_build&Level=15&IDX=..&IDY=..` → `.dat`
//! - 오브젝트/텍스처: `requestLayerObject?...&DataFile={파일명}` → `.xdo` / `.jpg`
//! - `Referer` 헤더 = 키 발급 시 등록한 URL 필수
//! - 응답이 `<?xml` 로 시작하면 에러 XML. `ERROR_SERVICE_FILE_NOTTHING` = 자료 없음(정상, 빈 타일)
//!
//! ## 좌표계
//! XDO 정점/AABB 는 반지름 6,378,137m **구면** 기준 전역 카티지언이며, 축은 ECEF 의 Y 를 뒤집은
//! 좌표계(X=cosφcosλ, Y=−cosφsinλ, Z=sinφ)다. `rotate_local` 로 오브젝트 대표 경위도의 국소
//! 프레임으로 회전하면 (east, −north, up+R) 이 나온다 (Java 참조 구현 rotate3d 와 동일).
//! 회전은 선형이므로 AABB 중심과 정점 오프셋을 각각 회전해 합산한다.
//!
//! ## 높이 datum
//! V-World 자체 DEM 기준 고도는 신뢰하지 않는다. 오브젝트별 기저(base)를 뽑아 앱의 융합 SRTM
//! (`SrtmReader::get_elevation` — 실측 지반고 보정 경유 유일 경로) 값으로 재배치한다(지반 스냅).
//! 앱 전역 관례대로 MSL 수치를 타원체고 자리에 그대로 사용한다(지오이드 보정 금지).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::f64::consts::PI;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────

/// XDServer3d 엔드포인트 루트
const XD_BASE: &str = "https://xdworld.vworld.kr/XDServer3d";
/// 건물 레이어 (교량 facility_bridge=Level14 는 스코프 외)
const LAYER: &str = "facility_build";
/// 건물은 레벨 15 고정
const LEVEL: u32 = 15;
/// 격자 한 칸 크기(도) = 360 / (2^15 × 10)
const UNIT: f64 = 360.0 / ((1u32 << LEVEL) as f64 * 10.0);

/// XDO 가 기준하는 월드윈드 구면 반지름(m) — 타원체가 아니다
const SPHERE_R: f64 = 6_378_137.0;
/// WGS84 장반경 / 제1이심률제곱 (ENU→ECEF 변환용)
const WGS84_A: f64 = 6_378_137.0;
const WGS84_E2: f64 = 6.694_379_990_14e-3;

/// 타일 동시 처리 수 (스펙 6~8)
const TILE_CONCURRENCY: usize = 6;
/// 타일 내부 오브젝트/텍스처 동시 요청 수
const OBJ_CONCURRENCY: usize = 3;
/// HTTP 재시도 횟수 (최초 시도 제외)
const RETRY: usize = 2;

/// 지반 스냅 판정 — |dat.altitude − ENU minZ| 가 이 값을 넘으면 minZ 를 기저로 채택
const SNAP_DIFF_LIMIT_M: f64 = 10.0;

/// 그룹 셀 한 변에 묶는 L15 타일 수 (tileset.json 3단 구조 중간 노드)
const GROUP_SPAN: u32 = 16;
/// 루트/그룹/리프 geometricError
const GE_ROOT: f64 = 512.0;
const GE_GROUP: f64 = 100.0;

/// 진행 이벤트 최소 간격(ms) — 수만 타일에서 IPC 폭주 방지
const PROGRESS_MIN_INTERVAL_MS: u128 = 150;
/// manifest 중간 저장 주기(타일 수) — 취소/크래시 시 재개 지점 보존
const MANIFEST_FLUSH_EVERY: usize = 40;

/// 파싱 방어 상한 — 손상/잘림 파일이 거대 할당을 유발하지 않도록
const MAX_OBJECTS_PER_TILE: usize = 100_000;
const MAX_VERTICES_PER_FACE: usize = 1_000_000;
const MAX_INDICES_PER_FACE: usize = 3_000_000;
const MAX_FACES: usize = 256;

// ─────────────────────────────────────────────────────────────
// 실행 상태 (취소 / 중복 실행 방지)
// ─────────────────────────────────────────────────────────────

static CANCEL: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);

/// 다운로드 종료 시 실행 플래그를 반드시 되돌리는 가드 (조기 return/에러 포함)
struct RunGuard;
impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
        CANCEL.store(false, Ordering::SeqCst);
    }
}

// ─────────────────────────────────────────────────────────────
// 타일 격자
// ─────────────────────────────────────────────────────────────

/// 경위도 → L15 타일 인덱스
pub fn lonlat_to_tile(lon: f64, lat: f64) -> (u32, u32) {
    let idx = ((lon + 180.0) / UNIT).floor().max(0.0) as u32;
    let idy = ((lat + 90.0) / UNIT).floor().max(0.0) as u32;
    (idx, idy)
}

/// 타일 경계 [west, south, east, north] (도)
pub fn tile_bounds(idx: u32, idy: u32) -> [f64; 4] {
    let w = idx as f64 * UNIT - 180.0;
    let s = idy as f64 * UNIT - 90.0;
    [w, s, w + UNIT, s + UNIT]
}

/// 타일 중심 경위도 (도) — 정점 변환 원점과 리프 transform 원점이 반드시 같아야 한다
pub fn tile_center(idx: u32, idy: u32) -> (f64, f64) {
    let b = tile_bounds(idx, idy);
    ((b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5)
}

/// 위도에서의 1도당 미터 (경도, 위도) — WGS84 국소 근사
fn deg_to_meters(lat_deg: f64) -> (f64, f64) {
    let phi = lat_deg.to_radians();
    let s = phi.sin();
    let w = (1.0 - WGS84_E2 * s * s).sqrt();
    let m_merid = WGS84_A * (1.0 - WGS84_E2) / (w * w * w);
    let n_prime = WGS84_A / w;
    (n_prime * phi.cos() * PI / 180.0, m_merid * PI / 180.0)
}

/// 중심좌표 + 반경(km) 안의 L15 타일 열거 (타일 중심이 원 안에 드는 것만)
pub fn enumerate_tiles(center_lon: f64, center_lat: f64, radius_km: f64) -> Vec<(u32, u32)> {
    let radius_m = radius_km.max(0.0) * 1000.0;
    let (mlon, mlat) = deg_to_meters(center_lat);
    if mlon <= 0.0 || mlat <= 0.0 {
        return Vec::new();
    }
    let dlon = radius_m / mlon;
    let dlat = radius_m / mlat;

    let (min_idx, min_idy) = lonlat_to_tile(center_lon - dlon, center_lat - dlat);
    let (max_idx, max_idy) = lonlat_to_tile(center_lon + dlon, center_lat + dlat);

    let mut out = Vec::new();
    for idx in min_idx..=max_idx {
        for idy in min_idy..=max_idy {
            let (clon, clat) = tile_center(idx, idy);
            let dx = (clon - center_lon) * mlon;
            let dy = (clat - center_lat) * mlat;
            if dx * dx + dy * dy <= radius_m * radius_m {
                out.push((idx, idy));
            }
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────
// 바이너리 커서 (전 필드 리틀엔디언, u8/u16 은 unsigned)
// ─────────────────────────────────────────────────────────────

struct Cur<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Cur<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, p: 0 }
    }
    fn remain(&self) -> usize {
        self.b.len().saturating_sub(self.p)
    }
    fn need(&self, n: usize) -> Result<(), String> {
        if self.remain() < n {
            Err(format!(
                "데이터 부족: offset {} 에서 {}B 필요, {}B 남음",
                self.p,
                n,
                self.remain()
            ))
        } else {
            Ok(())
        }
    }
    fn u8(&mut self) -> Result<u8, String> {
        self.need(1)?;
        let v = self.b[self.p];
        self.p += 1;
        Ok(v)
    }
    fn u16(&mut self) -> Result<u16, String> {
        self.need(2)?;
        let v = u16::from_le_bytes([self.b[self.p], self.b[self.p + 1]]);
        self.p += 2;
        Ok(v)
    }
    fn u32(&mut self) -> Result<u32, String> {
        self.need(4)?;
        let v = u32::from_le_bytes([
            self.b[self.p],
            self.b[self.p + 1],
            self.b[self.p + 2],
            self.b[self.p + 3],
        ]);
        self.p += 4;
        Ok(v)
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_bits(self.u32()?))
    }
    fn f64(&mut self) -> Result<f64, String> {
        self.need(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(&self.b[self.p..self.p + 8]);
        self.p += 8;
        Ok(f64::from_le_bytes(a))
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        self.need(n)?;
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    /// 길이 지정 문자열 — 인코딩 불명(EUC-KR 추정)이라 lossy 디코드, 식별용으로만 사용
    fn text(&mut self, n: usize) -> Result<String, String> {
        let raw = self.bytes(n)?;
        Ok(decode_kr(raw))
    }
}

fn decode_kr(raw: &[u8]) -> String {
    let (s, _, _) = encoding_rs::EUC_KR.decode(raw);
    s.trim_end_matches('\u{0}').trim().to_string()
}

// ─────────────────────────────────────────────────────────────
// .dat (requestLayerNode 응답) 파서
// ─────────────────────────────────────────────────────────────

/// .dat 의 오브젝트 1건 (= .xdo 파일 1개에 대한 인덱스 엔트리)
#[derive(Debug, Clone, Default)]
pub struct DatObject {
    /// "3.0.0.1" / "3.0.0.2" — 4번째 바이트로 XDO 파서 분기
    pub version: [u8; 4],
    pub obj_type: u8,
    pub key: String,
    /// 오브젝트 대표 경위도 (국소 프레임 회전 기준점)
    pub center_lon: f64,
    pub center_lat: f64,
    /// V-World 기준 배치 고도 (신뢰 낮음 — 지반 스냅의 기저 후보로만)
    pub altitude: f32,
    /// 전역 구면 카티지언 AABB (minX,minY,minZ,maxX,maxY,maxZ)
    pub bbox: [f64; 6],
    pub img_level: u8,
    /// requestLayerObject 의 DataFile 파라미터
    pub data_file: String,
    pub img_file_name: String,
}

/// .dat 전체
#[derive(Debug, Clone, Default)]
pub struct DatIndex {
    pub level: u32,
    pub idx: u32,
    pub idy: u32,
    pub objects: Vec<DatObject>,
}

/// .dat 파싱 — 중간에서 잘린 파일은 그때까지 읽은 오브젝트를 반환(방어적)
pub fn parse_dat(bytes: &[u8]) -> Result<DatIndex, String> {
    let mut c = Cur::new(bytes);
    let level = c.u32()?;
    let idx = c.u32()?;
    let idy = c.u32()?;
    let count = c.u32()? as usize;
    if count > MAX_OBJECTS_PER_TILE {
        return Err(format!("오브젝트 수 이상: {}", count));
    }

    let mut objects = Vec::with_capacity(count.min(4096));
    for i in 0..count {
        match parse_dat_object(&mut c) {
            Ok(o) => objects.push(o),
            Err(e) => {
                log::warn!(
                    "[VW3D] .dat 오브젝트 {}/{} 파싱 중단 ({}_{}) — {}",
                    i + 1,
                    count,
                    idx,
                    idy,
                    e
                );
                break; // 스트림이 어긋난 뒤로는 복구 불가
            }
        }
    }

    Ok(DatIndex {
        level,
        idx,
        idy,
        objects,
    })
}

fn parse_dat_object(c: &mut Cur) -> Result<DatObject, String> {
    let mut version = [0u8; 4];
    for v in version.iter_mut() {
        *v = c.u8()?;
    }
    let obj_type = c.u8()?;
    let key_len = c.u8()? as usize;
    let key = c.text(key_len)?;
    let center_lon = c.f64()?;
    let center_lat = c.f64()?;
    let altitude = c.f32()?;
    let mut bbox = [0f64; 6];
    for b in bbox.iter_mut() {
        *b = c.f64()?;
    }
    let img_level = c.u8()?;
    let data_len = c.u8()? as usize;
    let data_file = c.text(data_len)?;
    let img_len = c.u8()? as usize;
    let img_file_name = c.text(img_len)?;

    Ok(DatObject {
        version,
        obj_type,
        key,
        center_lon,
        center_lat,
        altitude,
        bbox,
        img_level,
        data_file,
        img_file_name,
    })
}

// ─────────────────────────────────────────────────────────────
// .xdo 파서
// ─────────────────────────────────────────────────────────────

/// XDO 페이스(재질 단위 메시)
#[derive(Debug, Clone, Default)]
pub struct XdoFace {
    /// 정점 (pos xyz, normal xyz, uv) — AABB 중심 기준 오프셋
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub uvs: Vec<[f32; 2]>,
    /// 삼각형 인덱스
    pub indices: Vec<u32>,
    /// ARGB
    pub color: [u8; 4],
    pub image_level: u8,
    /// 텍스처 파일명 (빈 문자열 = 텍스처 없음 → color 재질)
    pub image_name: String,
    /// 내장 저해상 썸네일 JPEG — 텍스처 다운로드 실패 시 폴백
    pub nail: Vec<u8>,
}

/// XDO 오브젝트
#[derive(Debug, Clone, Default)]
pub struct XdoObject {
    pub obj_type: u8,
    pub object_id: u32,
    pub key: String,
    /// 전역 구면 카티지언 AABB
    pub object_box: [f64; 6],
    pub altitude: f32,
    pub faces: Vec<XdoFace>,
}

impl XdoObject {
    /// AABB 중심 (전역 구면 카티지언)
    pub fn box_center(&self) -> (f64, f64, f64) {
        (
            (self.object_box[0] + self.object_box[3]) * 0.5,
            (self.object_box[1] + self.object_box[4]) * 0.5,
            (self.object_box[2] + self.object_box[5]) * 0.5,
        )
    }
}

/// .xdo 파싱. `version_minor` = .dat version 의 4번째 바이트(1 또는 2).
/// 선언된 버전으로 실패하면 반대 버전으로 1회 재시도한다(인덱스-실파일 불일치 방어).
pub fn parse_xdo(bytes: &[u8], version_minor: u8) -> Result<XdoObject, String> {
    let primary = if version_minor == 2 { 2 } else { 1 };
    match parse_xdo_with(bytes, primary) {
        Ok(o) => Ok(o),
        Err(e1) => {
            let alt = if primary == 2 { 1 } else { 2 };
            match parse_xdo_with(bytes, alt) {
                Ok(o) => {
                    log::warn!("[VW3D] .xdo 버전 폴백 3.0.0.{} → 3.0.0.{}", primary, alt);
                    Ok(o)
                }
                Err(_) => Err(e1),
            }
        }
    }
}

fn parse_xdo_with(bytes: &[u8], version_minor: u8) -> Result<XdoObject, String> {
    let mut c = Cur::new(bytes);
    let obj_type = c.u8()?;
    let object_id = c.u32()?;
    let key_len = c.u8()? as usize;
    let key = c.text(key_len)?;
    let mut object_box = [0f64; 6];
    for b in object_box.iter_mut() {
        *b = c.f64()?;
    }
    let altitude = c.f32()?;

    // 3.0.0.1 = 단일 메시, 3.0.0.2 = 멀티 페이스
    let face_num = if version_minor == 2 {
        c.u8()? as usize
    } else {
        1
    };
    if face_num == 0 || face_num > MAX_FACES {
        return Err(format!("face 수 이상: {}", face_num));
    }

    let mut faces = Vec::with_capacity(face_num);
    for _ in 0..face_num {
        faces.push(parse_xdo_face(&mut c)?);
    }

    Ok(XdoObject {
        obj_type,
        object_id,
        key,
        object_box,
        altitude,
        faces,
    })
}

fn parse_xdo_face(c: &mut Cur) -> Result<XdoFace, String> {
    let vcount = c.u32()? as usize;
    if vcount > MAX_VERTICES_PER_FACE {
        return Err(format!("정점 수 이상: {}", vcount));
    }
    // 정점당 8×f32 = 32B — 선할당 전에 잔여 길이로 검증
    c.need(vcount * 32)?;

    let mut positions = Vec::with_capacity(vcount);
    let mut normals = Vec::with_capacity(vcount);
    let mut uvs = Vec::with_capacity(vcount);
    for _ in 0..vcount {
        let px = c.f32()?;
        let py = c.f32()?;
        let pz = c.f32()?;
        let nx = c.f32()?;
        let ny = c.f32()?;
        let nz = c.f32()?;
        let u = c.f32()?;
        let v = c.f32()?;
        positions.push([px, py, pz]);
        normals.push([nx, ny, nz]);
        // XDO 의 v 는 좌상단 원점(= glTF 규약)이라 그대로 쓴다.
        // (Java 참조 구현이 1−v 로 뒤집는 것은 OBJ 가 좌하단 원점이기 때문)
        uvs.push([u, v]);
    }

    let icount = c.u32()? as usize;
    if icount > MAX_INDICES_PER_FACE {
        return Err(format!("인덱스 수 이상: {}", icount));
    }
    c.need(icount * 2)?;
    let mut indices = Vec::with_capacity(icount);
    for _ in 0..icount {
        let i = c.u16()? as u32;
        if i as usize >= vcount {
            return Err(format!("인덱스 범위 초과: {} >= {}", i, vcount));
        }
        indices.push(i);
    }
    // 삼각형 단위가 아니면 남는 꼬리를 버린다
    let tri_len = indices.len() - indices.len() % 3;
    indices.truncate(tri_len);

    let a = c.u8()?;
    let r = c.u8()?;
    let g = c.u8()?;
    let b = c.u8()?;
    let image_level = c.u8()?;
    let name_len = c.u8()? as usize;
    let image_name = c.text(name_len)?;
    let nail_size = c.u32()? as usize;
    // nail 은 반드시 소비해야 다음 face 파싱이 맞는다
    let nail = c.bytes(nail_size)?.to_vec();

    Ok(XdoFace {
        positions,
        normals,
        uvs,
        indices,
        color: [a, r, g, b],
        image_level,
        image_name,
        nail,
    })
}

// ─────────────────────────────────────────────────────────────
// 좌표 변환
// ─────────────────────────────────────────────────────────────

/// 전역 구면 카티지언 벡터 → 오브젝트 국소 프레임 (Java rotate3d 동일).
/// 반환 `(x, y, z)` 에서 east = x, north = −y, up = z − R.
pub fn rotate_local(vx: f64, vy: f64, vz: f64, lon: f64, lat: f64) -> (f64, f64, f64) {
    let p = lon.to_radians();
    let t = (90.0 - lat).to_radians();
    let (sp, cp) = p.sin_cos();
    let (st, ct) = t.sin_cos();
    let x = -(sp * vx + cp * vy);
    let y = ct * cp * vx - ct * sp * vy - st * vz;
    let z = st * cp * vx - st * sp * vy + ct * vz;
    (x, y, z)
}

/// ENU → ECEF 프레임 행렬 (Cesium eastNorthUpToFixedFrame, column-major 16)
pub fn enu_to_fixed_frame(lon_deg: f64, lat_deg: f64, height: f64) -> [f64; 16] {
    let (sl, cl) = lon_deg.to_radians().sin_cos();
    let (sp, cp) = lat_deg.to_radians().sin_cos();
    let n = WGS84_A / (1.0 - WGS84_E2 * sp * sp).sqrt();
    let x = (n + height) * cp * cl;
    let y = (n + height) * cp * sl;
    let z = (n * (1.0 - WGS84_E2) + height) * sp;
    [
        -sl, cl, 0.0, 0.0, // east
        -sp * cl, -sp * sl, cp, 0.0, // north
        cp * cl, cp * sl, sp, 0.0, // up
        x, y, z, 1.0, // origin
    ]
}

/// 변환된 페이스 1개 (타일 중심 기준 glTF y-up 좌표)
#[derive(Debug, Clone, Default)]
pub struct ConvertedFace {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub uvs: Vec<f32>,
    pub indices: Vec<u32>,
    pub color: [u8; 4],
    pub image_name: String,
}

/// 오브젝트 변환 결과
#[derive(Debug, Clone, Default)]
pub struct ConvertedObject {
    pub faces: Vec<ConvertedFace>,
    /// 타일 로컬 ENU 범위 [minE, minN, minU, maxE, maxN, maxU] (m)
    pub extent: [f64; 6],
    /// 지반 스냅 적용 여부 (DEM 미보유 시 false)
    pub snapped: bool,
}

/// XDO 오브젝트 → 타일 중심 기준 glTF 정점.
///
/// - `center_lon/center_lat`: .dat 의 오브젝트 대표 경위도 (회전 기준점)
/// - `dat_altitude`: .dat 의 배치 고도 (기저 후보)
/// - `tile_lon/tile_lat`: 타일 중심 (리프 transform 원점과 동일해야 함)
/// - `dem`: 융합 SRTM 지반고(MSL). None 이면 스냅 생략(원본 유지)
pub fn convert_object(
    obj: &XdoObject,
    center_lon: f64,
    center_lat: f64,
    dat_altitude: f32,
    tile_lon: f64,
    tile_lat: f64,
    dem: Option<f64>,
) -> ConvertedObject {
    let (bx, by, bz) = obj.box_center();
    let rc = rotate_local(bx, by, bz, center_lon, center_lat);

    // 1차: 국소 ENU (east, north, up) 산출 — up 은 구면(R) 기준 높이
    let mut enu: Vec<Vec<[f64; 3]>> = Vec::with_capacity(obj.faces.len());
    let mut min_up = f64::INFINITY;
    for face in &obj.faces {
        let mut v = Vec::with_capacity(face.positions.len());
        for p in &face.positions {
            let r = rotate_local(p[0] as f64, p[1] as f64, p[2] as f64, center_lon, center_lat);
            let e = rc.0 + r.0;
            let n = -(rc.1 + r.1);
            let u = rc.2 + r.2 - SPHERE_R;
            if u < min_up {
                min_up = u;
            }
            v.push([e, n, u]);
        }
        enu.push(v);
    }
    if !min_up.is_finite() {
        min_up = 0.0;
    }

    // 기저 결정: 기본은 .dat altitude, 메시 최저점과 10m 넘게 벌어지면 최저점 채택
    let alt = dat_altitude as f64;
    let base = if (alt - min_up).abs() > SNAP_DIFF_LIMIT_M {
        min_up
    } else {
        alt
    };
    // 지반 스냅 — DEM 이 없으면 원본 유지
    let (dz, snapped) = match dem {
        Some(g) if g.is_finite() => (g - base, true),
        _ => (0.0, false),
    };

    // 타일 중심 기준 수평 오프셋
    let (mlon, mlat) = deg_to_meters(tile_lat);
    let de = (center_lon - tile_lon) * mlon;
    let dn = (center_lat - tile_lat) * mlat;

    let mut extent = [
        f64::INFINITY,
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut faces = Vec::with_capacity(obj.faces.len());

    for (fi, face) in obj.faces.iter().enumerate() {
        if face.indices.is_empty() || face.positions.is_empty() {
            continue;
        }
        let src = &enu[fi];
        let mut positions = Vec::with_capacity(src.len() * 3);
        let mut normals = Vec::with_capacity(src.len() * 3);
        let mut uvs = Vec::with_capacity(src.len() * 2);

        for (vi, p) in src.iter().enumerate() {
            let e = p[0] + de;
            let n = p[1] + dn;
            let u = p[2] + dz;
            extent[0] = extent[0].min(e);
            extent[1] = extent[1].min(n);
            extent[2] = extent[2].min(u);
            extent[3] = extent[3].max(e);
            extent[4] = extent[4].max(n);
            extent[5] = extent[5].max(u);
            // ENU(e,n,u) → glTF y-up (e, u, −n)
            positions.push(e as f32);
            positions.push(u as f32);
            positions.push(-n as f32);

            let nv = face.normals.get(vi).copied().unwrap_or([0.0, 1.0, 0.0]);
            let rn = rotate_local(nv[0] as f64, nv[1] as f64, nv[2] as f64, center_lon, center_lat);
            // east=rn.0, north=−rn.1, up=rn.2 → glTF (east, up, −north) = (rn.0, rn.2, rn.1)
            let len = (rn.0 * rn.0 + rn.1 * rn.1 + rn.2 * rn.2).sqrt();
            let inv = if len > 1e-9 { 1.0 / len } else { 0.0 };
            normals.push((rn.0 * inv) as f32);
            normals.push((rn.2 * inv) as f32);
            normals.push((rn.1 * inv) as f32);

            let uv = face.uvs.get(vi).copied().unwrap_or([0.0, 0.0]);
            uvs.push(uv[0]);
            uvs.push(uv[1]);
        }

        faces.push(ConvertedFace {
            positions,
            normals,
            uvs,
            indices: face.indices.clone(),
            color: face.color,
            image_name: face.image_name.clone(),
        });
    }

    ConvertedObject {
        faces,
        extent,
        snapped,
    }
}

// ─────────────────────────────────────────────────────────────
// glTF 2.0 바이너리(GLB) + b3dm 라이터
// ─────────────────────────────────────────────────────────────

/// GLB 프리미티브 — 재질(텍스처 또는 단색) 하나당 하나로 병합된다
#[derive(Debug, Clone, Default)]
pub struct GlbPrimitive {
    /// 3×N (glTF y-up)
    pub positions: Vec<f32>,
    /// 3×N
    pub normals: Vec<f32>,
    /// 2×N (텍스처 없으면 비움)
    pub uvs: Vec<f32>,
    pub indices: Vec<u32>,
    /// `images` 인덱스 (없으면 None → baseColorFactor 단색)
    pub image: Option<usize>,
    /// baseColorFactor (RGBA 0..1)
    pub color: [f32; 4],
}

/// 4바이트 정렬 후 bufferView 추가
fn push_view(bin: &mut Vec<u8>, views: &mut Vec<Value>, data: &[u8], target: Option<u32>) -> usize {
    while bin.len() % 4 != 0 {
        bin.push(0);
    }
    let offset = bin.len();
    bin.extend_from_slice(data);
    let mut v = json!({
        "buffer": 0,
        "byteOffset": offset,
        "byteLength": data.len(),
    });
    if let Some(t) = target {
        v["target"] = json!(t);
    }
    views.push(v);
    views.len() - 1
}

fn f32_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// GLB 작성 — glTF 2.0 바이너리. JPEG 텍스처는 bufferView image 로 임베드한다.
pub fn build_glb(prims: &[GlbPrimitive], images: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    if prims.is_empty() {
        return Err("빈 메시 — GLB 생성 생략".to_string());
    }

    let mut bin: Vec<u8> = Vec::new();
    let mut views: Vec<Value> = Vec::new();
    let mut accessors: Vec<Value> = Vec::new();
    let mut primitives: Vec<Value> = Vec::new();
    let mut materials: Vec<Value> = Vec::new();
    let mut gltf_images: Vec<Value> = Vec::new();
    let mut textures: Vec<Value> = Vec::new();

    // 텍스처 이미지 먼저 (bufferView 임베드)
    for img in images {
        let v = push_view(&mut bin, &mut views, img, None);
        gltf_images.push(json!({"bufferView": v, "mimeType": "image/jpeg"}));
        textures.push(json!({"sampler": 0, "source": gltf_images.len() - 1}));
    }

    for prim in prims {
        let vcount = prim.positions.len() / 3;
        if vcount == 0 || prim.indices.is_empty() {
            continue;
        }

        // POSITION (min/max 필수)
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for i in 0..vcount {
            for k in 0..3 {
                let x = prim.positions[i * 3 + k];
                min[k] = min[k].min(x);
                max[k] = max[k].max(x);
            }
        }
        let pv = push_view(&mut bin, &mut views, &f32_bytes(&prim.positions), Some(34962));
        accessors.push(json!({
            "bufferView": pv, "componentType": 5126, "count": vcount, "type": "VEC3",
            "min": [min[0], min[1], min[2]], "max": [max[0], max[1], max[2]],
        }));
        let pos_acc = accessors.len() - 1;

        // NORMAL
        let mut attrs = serde_json::Map::new();
        attrs.insert("POSITION".to_string(), json!(pos_acc));
        if prim.normals.len() == vcount * 3 {
            let nv = push_view(&mut bin, &mut views, &f32_bytes(&prim.normals), Some(34962));
            accessors.push(json!({
                "bufferView": nv, "componentType": 5126, "count": vcount, "type": "VEC3",
            }));
            attrs.insert("NORMAL".to_string(), json!(accessors.len() - 1));
        }
        // TEXCOORD_0 (텍스처 재질일 때만)
        if prim.image.is_some() && prim.uvs.len() == vcount * 2 {
            let tv = push_view(&mut bin, &mut views, &f32_bytes(&prim.uvs), Some(34962));
            accessors.push(json!({
                "bufferView": tv, "componentType": 5126, "count": vcount, "type": "VEC2",
            }));
            attrs.insert("TEXCOORD_0".to_string(), json!(accessors.len() - 1));
        }

        // 인덱스 — 정점 65k 초과 시 u32
        let (idx_bytes, comp_type) = if vcount > 65_535 {
            let mut b = Vec::with_capacity(prim.indices.len() * 4);
            for i in &prim.indices {
                b.extend_from_slice(&i.to_le_bytes());
            }
            (b, 5125u32)
        } else {
            let mut b = Vec::with_capacity(prim.indices.len() * 2);
            for i in &prim.indices {
                b.extend_from_slice(&(*i as u16).to_le_bytes());
            }
            (b, 5123u32)
        };
        let iv = push_view(&mut bin, &mut views, &idx_bytes, Some(34963));
        accessors.push(json!({
            "bufferView": iv, "componentType": comp_type,
            "count": prim.indices.len(), "type": "SCALAR",
        }));
        let idx_acc = accessors.len() - 1;

        // 재질
        let mut pbr = json!({
            "baseColorFactor": [prim.color[0], prim.color[1], prim.color[2], prim.color[3]],
            "metallicFactor": 0.0,
            "roughnessFactor": 1.0,
        });
        if let Some(t) = prim.image {
            if t < textures.len() {
                pbr["baseColorTexture"] = json!({"index": t});
                pbr["baseColorFactor"] = json!([1.0, 1.0, 1.0, 1.0]);
            }
        }
        materials.push(json!({"pbrMetallicRoughness": pbr, "doubleSided": true}));

        primitives.push(json!({
            "attributes": Value::Object(attrs),
            "indices": idx_acc,
            "material": materials.len() - 1,
            "mode": 4,
        }));
    }

    if primitives.is_empty() {
        return Err("유효 프리미티브 없음".to_string());
    }

    // BIN 청크는 8바이트 배수로 패딩 (b3dm 전체 8정렬 유도) — buffer.byteLength 도 동일 값
    while bin.len() % 8 != 0 {
        bin.push(0);
    }

    let mut gltf = json!({
        "asset": {"version": "2.0", "generator": "airmove-analyzer vworld3d"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": primitives}],
        "materials": materials,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": bin.len()}],
    });
    if !gltf_images.is_empty() {
        gltf["images"] = Value::Array(gltf_images);
        gltf["textures"] = Value::Array(textures);
        gltf["samplers"] = json!([{
            "magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497
        }]);
    }

    let mut json_bytes = serde_json::to_vec(&gltf).map_err(|e| format!("glTF 직렬화 실패: {e}"))?;
    // JSON 청크는 4배수 패딩(스페이스). 전체 길이 = 28 + J + B 가 8배수가 되도록 J % 8 == 4 로 맞춘다
    while json_bytes.len() % 4 != 0 {
        json_bytes.push(b' ');
    }
    if json_bytes.len() % 8 != 4 {
        json_bytes.extend_from_slice(b"    ");
    }

    let total = 12 + 8 + json_bytes.len() + 8 + bin.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&0x4E4F_534Au32.to_le_bytes()); // "JSON"
    out.extend_from_slice(&json_bytes);
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(&0x004E_4942u32.to_le_bytes()); // "BIN\0"
    out.extend_from_slice(&bin);
    Ok(out)
}

/// b3dm 래핑 — 헤더(28B) + featureTable JSON(`BATCH_LENGTH:0`) + GLB.
/// featureTable 은 GLB 가 8바이트 경계에서 시작하도록 스페이스 패딩한다.
pub fn wrap_b3dm(glb: &[u8]) -> Vec<u8> {
    let mut ft = b"{\"BATCH_LENGTH\":0}".to_vec();
    while (28 + ft.len()) % 8 != 0 {
        ft.push(b' ');
    }
    let total = 28 + ft.len() + glb.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"b3dm");
    out.extend_from_slice(&1u32.to_le_bytes()); // version
    out.extend_from_slice(&(total as u32).to_le_bytes()); // byteLength
    out.extend_from_slice(&(ft.len() as u32).to_le_bytes()); // featureTableJSONByteLength
    out.extend_from_slice(&0u32.to_le_bytes()); // featureTableBinaryByteLength
    out.extend_from_slice(&0u32.to_le_bytes()); // batchTableJSONByteLength
    out.extend_from_slice(&0u32.to_le_bytes()); // batchTableBinaryByteLength
    out.extend_from_slice(&ft);
    out.extend_from_slice(glb);
    out
}

// ─────────────────────────────────────────────────────────────
// manifest
// ─────────────────────────────────────────────────────────────

/// 타일 1개 기록 — 재개/타일셋 재생성/현황 표시의 단일 원천
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TileRecord {
    /// 변환 성공한 오브젝트 수
    pub objects: usize,
    /// 자료 없음(ERROR_SERVICE_FILE_NOTTHING) 또는 유효 지오메트리 0
    pub empty: bool,
    /// [west, south, east, north, minH, maxH] — 경위도(도) + 높이(m)
    pub bbox: [f64; 6],
    /// 지반 스냅 적용 여부
    pub snapped: bool,
    /// 기록 시각 (epoch seconds)
    pub ts: i64,
    /// b3dm 바이트 수 (현황 합계용 — 스펙 확장 필드)
    #[serde(default)]
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionRecord {
    pub lon: f64,
    pub lat: f64,
    #[serde(rename = "radiusKm")]
    pub radius_km: f64,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    /// key = "{idx}_{idy}"
    pub tiles: BTreeMap<String, TileRecord>,
    pub regions: Vec<RegionRecord>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            version: 1,
            tiles: BTreeMap::new(),
            regions: Vec::new(),
        }
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn load_manifest(root: &Path) -> Manifest {
    match std::fs::read(root.join("manifest.json")) {
        Ok(b) => serde_json::from_slice(&b).unwrap_or_else(|e| {
            log::warn!("[VW3D] manifest 파싱 실패 — 새로 시작: {}", e);
            Manifest::default()
        }),
        Err(_) => Manifest::default(),
    }
}

fn save_manifest(root: &Path, m: &Manifest) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("디렉터리 생성 실패: {e}"))?;
    let data = serde_json::to_vec(m).map_err(|e| format!("manifest 직렬화 실패: {e}"))?;
    std::fs::write(root.join("manifest.json"), data).map_err(|e| format!("manifest 저장 실패: {e}"))
}

// ─────────────────────────────────────────────────────────────
// tileset.json 생성 (manifest 전체 → 3단 구조)
// ─────────────────────────────────────────────────────────────

fn parse_tile_key(k: &str) -> Option<(u32, u32)> {
    let (a, b) = k.split_once('_')?;
    Some((a.parse().ok()?, b.parse().ok()?))
}

/// [w,s,e,n,minH,maxH](도/m) → 3D Tiles region(라디안/m)
fn region_of(bbox: &[f64; 6]) -> Value {
    json!([
        bbox[0].to_radians(),
        bbox[1].to_radians(),
        bbox[2].to_radians(),
        bbox[3].to_radians(),
        bbox[4],
        bbox[5],
    ])
}

fn union_bbox(acc: &mut [f64; 6], b: &[f64; 6]) {
    acc[0] = acc[0].min(b[0]);
    acc[1] = acc[1].min(b[1]);
    acc[2] = acc[2].max(b[2]);
    acc[3] = acc[3].max(b[3]);
    acc[4] = acc[4].min(b[4]);
    acc[5] = acc[5].max(b[5]);
}

const EMPTY_BBOX: [f64; 6] = [
    f64::INFINITY,
    f64::INFINITY,
    f64::NEG_INFINITY,
    f64::NEG_INFINITY,
    f64::INFINITY,
    f64::NEG_INFINITY,
];

/// manifest 전체(여러 영역 누적)로 tileset.json 재생성.
/// 콘텐츠 타일이 하나도 없으면 tileset.json 을 제거한다(프로토콜 404 → 레이어 무해).
pub fn write_tileset(root: &Path, manifest: &Manifest) -> Result<usize, String> {
    let mut groups: BTreeMap<(u32, u32), Vec<(u32, u32, &TileRecord)>> = BTreeMap::new();
    for (k, rec) in &manifest.tiles {
        if rec.empty || rec.objects == 0 {
            continue;
        }
        let Some((idx, idy)) = parse_tile_key(k) else {
            continue;
        };
        if !root.join(format!("tiles/{}_{}.b3dm", idx, idy)).is_file() {
            continue; // 파일이 사라진 항목은 건너뜀
        }
        groups
            .entry((idx / GROUP_SPAN, idy / GROUP_SPAN))
            .or_default()
            .push((idx, idy, rec));
    }

    if groups.is_empty() {
        let p = root.join("tileset.json");
        if p.exists() {
            let _ = std::fs::remove_file(&p);
        }
        return Ok(0);
    }

    let mut root_bbox = EMPTY_BBOX;
    let mut children = Vec::with_capacity(groups.len());
    let mut leaf_count = 0usize;

    for (_, leaves) in groups {
        let mut gbox = EMPTY_BBOX;
        let mut gchildren = Vec::with_capacity(leaves.len());
        for (idx, idy, rec) in leaves {
            union_bbox(&mut gbox, &rec.bbox);
            let (clon, clat) = tile_center(idx, idy);
            let m = enu_to_fixed_frame(clon, clat, 0.0);
            gchildren.push(json!({
                "boundingVolume": {"region": region_of(&rec.bbox)},
                "geometricError": 0.0,
                "refine": "ADD",
                "transform": m.to_vec(),
                "content": {"uri": format!("tiles/{}_{}.b3dm", idx, idy)},
            }));
            leaf_count += 1;
        }
        union_bbox(&mut root_bbox, &gbox);
        children.push(json!({
            "boundingVolume": {"region": region_of(&gbox)},
            "geometricError": GE_GROUP,
            "refine": "ADD",
            "children": gchildren,
        }));
    }

    let tileset = json!({
        "asset": {"version": "1.0", "generator": "airmove-analyzer vworld3d"},
        "geometricError": GE_ROOT,
        "root": {
            "boundingVolume": {"region": region_of(&root_bbox)},
            "geometricError": GE_ROOT,
            "refine": "ADD",
            "children": children,
        },
    });

    std::fs::create_dir_all(root).map_err(|e| format!("디렉터리 생성 실패: {e}"))?;
    let data = serde_json::to_vec(&tileset).map_err(|e| format!("tileset 직렬화 실패: {e}"))?;
    std::fs::write(root.join("tileset.json"), data)
        .map_err(|e| format!("tileset.json 저장 실패: {e}"))?;
    Ok(leaf_count)
}

// ─────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────

#[derive(Debug)]
enum FetchError {
    /// 해당 타일/파일에 자료 없음 (ERROR_SERVICE_FILE_NOTTHING) — 정상 상황
    Empty,
    /// 서버가 반환한 에러 XML 코드
    Server(String),
    /// 네트워크/HTTP 오류
    Net(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Empty => write!(f, "자료 없음"),
            FetchError::Server(c) => write!(f, "서버 오류({c})"),
            FetchError::Net(e) => write!(f, "{e}"),
        }
    }
}

/// 에러 XML 판별 — `<?xml …><Error code="…">`. 정상 바이너리는 선두가 길이/버전이라 충돌 없음
fn xml_error_code(bytes: &[u8]) -> Option<String> {
    let head = &bytes[..bytes.len().min(1024)];
    let s = String::from_utf8_lossy(head);
    let t = s.trim_start();
    if !t.starts_with("<?xml") && !t.starts_with('<') {
        return None;
    }
    if let Some(p) = s.find("code=\"") {
        let rest = &s[p + 6..];
        if let Some(q) = rest.find('"') {
            return Some(rest[..q].to_string());
        }
    }
    Some("UNKNOWN".to_string())
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn node_url(api_key: &str, idx: u32, idy: u32) -> String {
    format!(
        "{XD_BASE}/requestLayerNode?APIKey={}&Layer={LAYER}&Level={LEVEL}&IDX={idx}&IDY={idy}",
        percent_encode(api_key)
    )
}

fn object_url(api_key: &str, idx: u32, idy: u32, data_file: &str) -> String {
    format!(
        "{XD_BASE}/requestLayerObject?APIKey={}&Layer={LAYER}&Level={LEVEL}&IDX={idx}&IDY={idy}&DataFile={}",
        percent_encode(api_key),
        percent_encode(data_file)
    )
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {e}"))
}

/// 바이너리 1건 요청 (재시도 + 지수 백오프). 에러 XML 은 코드로 분류한다.
async fn fetch_bin(
    client: &reqwest::Client,
    url: &str,
    referer: &str,
) -> Result<Vec<u8>, FetchError> {
    let mut last = String::new();
    for attempt in 0..=RETRY {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * (1 << (attempt - 1)) as u64)).await;
        }
        if CANCEL.load(Ordering::Relaxed) {
            return Err(FetchError::Net("취소됨".to_string()));
        }
        let resp = match client.get(url).header("Referer", referer).send().await {
            Ok(r) => r,
            Err(e) => {
                last = format!("요청 실패: {e}");
                continue;
            }
        };
        let status = resp.status();
        if !status.is_success() {
            last = format!("HTTP {status}");
            if status.is_client_error() {
                return Err(FetchError::Net(last)); // 4xx 는 재시도 무의미
            }
            continue;
        }
        let bytes = match resp.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => {
                last = format!("본문 수신 실패: {e}");
                continue;
            }
        };
        if let Some(code) = xml_error_code(&bytes) {
            return if code.contains("NOTTHING") {
                Err(FetchError::Empty)
            } else {
                Err(FetchError::Server(code))
            };
        }
        if bytes.is_empty() {
            last = "빈 응답".to_string();
            continue;
        }
        return Ok(bytes);
    }
    Err(FetchError::Net(last))
}

// ─────────────────────────────────────────────────────────────
// 다운로드 오케스트레이션
// ─────────────────────────────────────────────────────────────

struct Ctx {
    client: reqwest::Client,
    api_key: String,
    referer: String,
    root: PathBuf,
}

/// 타일 1개 처리 결과
struct TileOutcome {
    idx: u32,
    idy: u32,
    record: Option<TileRecord>,
    error: Option<String>,
    cancelled: bool,
}

/// 앱 데이터 디렉터리 하위 고정 루트 (`<app_data>/vworld3d`)
pub fn root_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = {
        let state = app
            .try_state::<crate::AppState>()
            .ok_or_else(|| "AppState 미초기화".to_string())?;
        let guard = state
            .app_data_dir
            .lock()
            .map_err(|e| format!("app_data_dir lock: {e}"))?;
        guard.clone()
    };
    Ok(base.join("vworld3d"))
}

/// 설정에서 API 키/리퍼러 로드 (기존 vworld_id/vworld_pw 저장 방식과 동일한 settings 테이블)
fn load_credentials(app: &tauri::AppHandle) -> Result<(String, String), String> {
    let state = app
        .try_state::<crate::AppState>()
        .ok_or_else(|| "AppState 미초기화".to_string())?;
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("db lock: {e}"))?
        .get()
        .map_err(|e| format!("DB pool: {e}"))?;
    let key = crate::db::get_setting(&conn, "vworld_apikey")
        .map_err(|e| format!("DB error: {e}"))?
        .unwrap_or_default()
        .trim()
        .to_string();
    let referer = crate::db::get_setting(&conn, "vworld_referer")
        .map_err(|e| format!("DB error: {e}"))?
        .unwrap_or_default()
        .trim()
        .to_string();
    if key.is_empty() {
        return Err("V-World API 키가 설정되지 않았습니다".to_string());
    }
    let referer = if referer.is_empty() {
        "http://localhost".to_string()
    } else {
        referer
    };
    Ok((key, referer))
}

/// 융합 SRTM 지반고 조회 (실측 보정 포함 경로). 락은 이 동기 함수 안에서만 잡는다.
fn lookup_ground(app: &tauri::AppHandle, pts: &[(f64, f64)]) -> Vec<Option<f64>> {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return vec![None; pts.len()];
    };
    let mut srtm = match state.srtm.lock() {
        Ok(g) => g,
        Err(_) => return vec![None; pts.len()],
    };
    pts.iter()
        .map(|(lon, lat)| srtm.get_elevation(*lat, *lon))
        .collect()
}

/// 대상 영역의 HGT 타일 선반입 (타일마다 25MB 로드로 워커가 멈추는 것을 방지)
fn preload_srtm(app: &tauri::AppHandle, lon: f64, lat: f64, radius_km: f64) {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    let d = radius_km / 100.0 + 0.05; // 대략적인 여유 (도)
    let Ok(mut srtm) = state.srtm.lock() else {
        return;
    };
    srtm.preload_tiles(
        (lat - d).floor() as i32,
        (lat + d).floor() as i32,
        (lon - d).floor() as i32,
        (lon + d).floor() as i32,
    );
}

fn emit_progress(app: &tauri::AppHandle, phase: &str, done: usize, total: usize, message: &str) {
    let _ = app.emit(
        "vworld3d-progress",
        json!({
            "phase": phase,
            "done": done,
            "total": total,
            "message": message,
        }),
    );
}

/// 타일 1개: .dat → .xdo/.jpg 수집 → 변환 → b3dm 기록
async fn process_tile(ctx: Arc<Ctx>, app: tauri::AppHandle, idx: u32, idy: u32) -> TileOutcome {
    let out_empty = |empty: bool| TileRecord {
        objects: 0,
        empty,
        bbox: {
            let b = tile_bounds(idx, idy);
            [b[0], b[1], b[2], b[3], 0.0, 0.0]
        },
        snapped: false,
        ts: now_secs(),
        bytes: 0,
    };

    if CANCEL.load(Ordering::Relaxed) {
        return TileOutcome {
            idx,
            idy,
            record: None,
            error: None,
            cancelled: true,
        };
    }

    // ① 타일 인덱스(.dat)
    let dat_bytes = match fetch_bin(&ctx.client, &node_url(&ctx.api_key, idx, idy), &ctx.referer).await
    {
        Ok(b) => b,
        Err(FetchError::Empty) => {
            return TileOutcome {
                idx,
                idy,
                record: Some(out_empty(true)),
                error: None,
                cancelled: false,
            }
        }
        Err(e) => {
            let cancelled = CANCEL.load(Ordering::Relaxed);
            return TileOutcome {
                idx,
                idy,
                record: None,
                error: if cancelled {
                    None
                } else {
                    Some(format!("인덱스 수신 실패: {e}"))
                },
                cancelled,
            };
        }
    };

    let dat = match parse_dat(&dat_bytes) {
        Ok(d) => d,
        Err(e) => {
            return TileOutcome {
                idx,
                idy,
                record: None,
                error: Some(format!(".dat 파싱 실패: {e}")),
                cancelled: false,
            }
        }
    };
    if dat.objects.is_empty() {
        return TileOutcome {
            idx,
            idy,
            record: Some(out_empty(true)),
            error: None,
            cancelled: false,
        };
    }

    // ② 오브젝트(.xdo) 수집 — 타일 내부 소규모 동시성
    // (URL 을 미리 소유값으로 만들어 넘긴다 — 스트림 클로저가 참조를 잡으면 HRTB 로 컴파일 불가)
    let objs: Vec<DatObject> = dat.objects;
    let obj_urls: Vec<(usize, String)> = objs
        .iter()
        .enumerate()
        .map(|(i, o)| (i, object_url(&ctx.api_key, idx, idy, &o.data_file)))
        .collect();
    let fetched: Vec<(usize, Option<Vec<u8>>)> = stream::iter(obj_urls.into_iter().map(
        |(i, url)| {
            let ctx = ctx.clone();
            async move {
                match fetch_bin(&ctx.client, &url, &ctx.referer).await {
                    Ok(b) => (i, Some(b)),
                    Err(FetchError::Empty) => (i, None),
                    Err(e) => {
                        log::warn!("[VW3D] .xdo 수신 실패 {}_{} — {}", idx, idy, e);
                        (i, None)
                    }
                }
            }
        },
    ))
    .buffer_unordered(OBJ_CONCURRENCY)
    .collect()
    .await;

    if CANCEL.load(Ordering::Relaxed) {
        return TileOutcome {
            idx,
            idy,
            record: None,
            error: None,
            cancelled: true,
        };
    }

    // ③ 파싱
    let mut parsed: Vec<(usize, XdoObject)> = Vec::new();
    let mut fetch_ok = 0usize;
    for (i, raw) in fetched {
        let Some(raw) = raw else { continue };
        fetch_ok += 1;
        match parse_xdo(&raw, objs[i].version[3]) {
            Ok(o) => parsed.push((i, o)),
            Err(e) => log::warn!(
                "[VW3D] .xdo 파싱 실패 (건너뜀) {}_{} {} — {}",
                idx,
                idy,
                objs[i].data_file,
                e
            ),
        }
    }
    parsed.sort_by_key(|(i, _)| *i);
    if fetch_ok == 0 {
        // 인덱스에는 오브젝트가 있는데 하나도 못 받았다 = 일시적 장애 가능성.
        // manifest 에 '빈 타일' 로 굳히면 재개 시 영원히 건너뛰므로 실패로 남긴다.
        return TileOutcome {
            idx,
            idy,
            record: None,
            error: Some(format!(".xdo {}건 전부 수신 실패", objs.len())),
            cancelled: CANCEL.load(Ordering::Relaxed),
        };
    }
    if parsed.is_empty() {
        return TileOutcome {
            idx,
            idy,
            record: Some(out_empty(true)),
            error: None,
            cancelled: false,
        };
    }

    // ④ 텍스처 수집 (타일 단위 dedupe — 같은 파일명도 타일이 다르면 다른 리소스)
    let mut names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (_, o) in &parsed {
        for f in &o.faces {
            if !f.image_name.is_empty() && seen.insert(f.image_name.clone()) {
                names.push(f.image_name.clone());
            }
        }
    }
    let jpgs: Vec<(String, Option<Vec<u8>>)> = stream::iter(names.into_iter().map(|n| {
        let ctx = ctx.clone();
        let url = object_url(&ctx.api_key, idx, idy, &n);
        async move {
            match fetch_bin(&ctx.client, &url, &ctx.referer).await {
                Ok(b) if b.starts_with(&[0xFF, 0xD8]) => (n, Some(b)),
                _ => (n, None),
            }
        }
    }))
    .buffer_unordered(OBJ_CONCURRENCY)
    .collect()
    .await;
    let mut jpg_map: HashMap<String, Vec<u8>> = HashMap::new();
    for (n, b) in jpgs {
        if let Some(b) = b {
            jpg_map.insert(n, b);
        }
    }
    // 다운로드 실패분은 내장 nail 로 폴백
    for (_, o) in &parsed {
        for f in &o.faces {
            if f.image_name.is_empty() || jpg_map.contains_key(&f.image_name) {
                continue;
            }
            if f.nail.starts_with(&[0xFF, 0xD8]) {
                jpg_map.insert(f.image_name.clone(), f.nail.clone());
            }
        }
    }

    if CANCEL.load(Ordering::Relaxed) {
        return TileOutcome {
            idx,
            idy,
            record: None,
            error: None,
            cancelled: true,
        };
    }

    // ⑤ 지반고 (융합 SRTM)
    let pts: Vec<(f64, f64)> = parsed
        .iter()
        .map(|(i, _)| (objs[*i].center_lon, objs[*i].center_lat))
        .collect();
    let dems = lookup_ground(&app, &pts);

    // ⑥ 변환 + 병합
    let (tile_lon, tile_lat) = tile_center(idx, idy);
    let mut images: Vec<Vec<u8>> = Vec::new();
    let mut image_idx: HashMap<String, usize> = HashMap::new();
    // 재질 키 → 프리미티브
    let mut prim_idx: HashMap<String, usize> = HashMap::new();
    let mut prims: Vec<GlbPrimitive> = Vec::new();
    let mut extent = EMPTY_BBOX;
    let mut obj_count = 0usize;
    let mut snapped_all = true;

    for (n, (i, obj)) in parsed.iter().enumerate() {
        let d = &objs[*i];
        let conv = convert_object(
            obj,
            d.center_lon,
            d.center_lat,
            d.altitude,
            tile_lon,
            tile_lat,
            dems.get(n).copied().flatten(),
        );
        if conv.faces.is_empty() {
            continue;
        }
        if !conv.snapped {
            snapped_all = false;
        }
        obj_count += 1;
        // ENU 범위 → 경위도 범위(도) 는 마지막에 한 번에 환산
        union_bbox(
            &mut extent,
            &[
                conv.extent[0],
                conv.extent[1],
                conv.extent[2],
                conv.extent[3],
                conv.extent[4],
                conv.extent[5],
            ],
        );

        for face in conv.faces {
            let img = if face.image_name.is_empty() {
                None
            } else if let Some(k) = image_idx.get(&face.image_name) {
                Some(*k)
            } else if let Some(bytes) = jpg_map.get(&face.image_name) {
                images.push(bytes.clone());
                let k = images.len() - 1;
                image_idx.insert(face.image_name.clone(), k);
                Some(k)
            } else {
                None
            };

            let key = match img {
                Some(k) => format!("t{}", k),
                None => format!(
                    "c{:02x}{:02x}{:02x}{:02x}",
                    face.color[0], face.color[1], face.color[2], face.color[3]
                ),
            };
            let pi = *prim_idx.entry(key).or_insert_with(|| {
                // ARGB(u8) → baseColorFactor. 알파 0 은 데이터 관례상 불투명으로 간주
                let a = if face.color[0] == 0 { 255 } else { face.color[0] };
                let mut c = [
                    face.color[1] as f32 / 255.0,
                    face.color[2] as f32 / 255.0,
                    face.color[3] as f32 / 255.0,
                    a as f32 / 255.0,
                ];
                if img.is_none() && c[0] == 0.0 && c[1] == 0.0 && c[2] == 0.0 {
                    c = [0.78, 0.78, 0.78, 1.0]; // 색상 미지정(전부 0) → 중간 회색
                }
                prims.push(GlbPrimitive {
                    image: img,
                    color: c,
                    ..Default::default()
                });
                prims.len() - 1
            });

            let p = &mut prims[pi];
            let base = (p.positions.len() / 3) as u32;
            p.positions.extend_from_slice(&face.positions);
            p.normals.extend_from_slice(&face.normals);
            p.uvs.extend_from_slice(&face.uvs);
            for v in &face.indices {
                p.indices.push(base + v);
            }
        }
    }

    if prims.is_empty() || obj_count == 0 {
        return TileOutcome {
            idx,
            idy,
            record: Some(out_empty(true)),
            error: None,
            cancelled: false,
        };
    }

    // ⑦ GLB → b3dm 기록
    let glb = match build_glb(&prims, &images) {
        Ok(g) => g,
        Err(e) => {
            return TileOutcome {
                idx,
                idy,
                record: None,
                error: Some(format!("GLB 생성 실패: {e}")),
                cancelled: false,
            }
        }
    };
    let b3dm = wrap_b3dm(&glb);
    let dir = ctx.root.join("tiles");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return TileOutcome {
            idx,
            idy,
            record: None,
            error: Some(format!("tiles 디렉터리 생성 실패: {e}")),
            cancelled: false,
        };
    }
    let path = dir.join(format!("{}_{}.b3dm", idx, idy));
    let bytes = b3dm.len() as u64;
    if let Err(e) = std::fs::write(&path, &b3dm) {
        return TileOutcome {
            idx,
            idy,
            record: None,
            error: Some(format!("b3dm 기록 실패: {e}")),
            cancelled: false,
        };
    }

    // ENU 범위 → 경위도 bbox (여유 없이 지오메트리를 정확히 감싼다)
    let (mlon, mlat) = deg_to_meters(tile_lat);
    let bbox = [
        tile_lon + extent[0] / mlon,
        tile_lat + extent[1] / mlat,
        tile_lon + extent[3] / mlon,
        tile_lat + extent[4] / mlat,
        extent[2],
        extent[5],
    ];

    TileOutcome {
        idx,
        idy,
        record: Some(TileRecord {
            objects: obj_count,
            empty: false,
            bbox,
            snapped: snapped_all,
            ts: now_secs(),
            bytes,
        }),
        error: None,
        cancelled: false,
    }
}

// ─────────────────────────────────────────────────────────────
// Tauri 명령
// ─────────────────────────────────────────────────────────────

/// 현황 요약 (소용량 JSON — invoke 직접 반환)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vworld3dStatus {
    /// 건물이 있는 타일 수
    pub tile_count: usize,
    pub object_count: usize,
    pub total_bytes: u64,
    pub regions: Vec<RegionRecord>,
}

/// API 키 연결 시험 — 서울시청 부근 L15 타일로 requestLayerNode 1회 호출
#[tauri::command]
pub async fn vworld3d_test_key(api_key: String, referer: String) -> Result<String, String> {
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return Err("API 키를 입력하세요".to_string());
    }
    let referer = {
        let r = referer.trim();
        if r.is_empty() {
            "http://localhost".to_string()
        } else {
            r.to_string()
        }
    };
    let client = build_client()?;
    // 서울시청 (126.9784, 37.5665)
    let (idx, idy) = lonlat_to_tile(126.9784, 37.5665);
    match fetch_bin(&client, &node_url(&key, idx, idy), &referer).await {
        Ok(bytes) => {
            let dat = parse_dat(&bytes)?;
            Ok(format!(
                "연결 성공 — 시험 타일 {}_{} 에서 오브젝트 {}개 확인",
                idx,
                idy,
                dat.objects.len()
            ))
        }
        Err(FetchError::Empty) => Ok(format!(
            "연결 성공 — 시험 타일 {}_{} 에는 자료가 없습니다",
            idx, idy
        )),
        Err(FetchError::Server(code)) => Err(format!(
            "서버 오류: {code} (API 키 또는 Referer 등록 주소를 확인하세요)"
        )),
        Err(FetchError::Net(e)) => Err(format!("연결 실패: {e}")),
    }
}

/// 취소 요청
#[tauri::command]
pub fn vworld3d_cancel() {
    if RUNNING.load(Ordering::SeqCst) {
        CANCEL.store(true, Ordering::SeqCst);
        log::info!("[VW3D] 취소 요청");
    }
}

/// 현황 조회 (manifest 요약)
#[tauri::command]
pub async fn vworld3d_status(app_handle: tauri::AppHandle) -> Result<Vworld3dStatus, String> {
    let root = root_dir(&app_handle)?;
    tauri::async_runtime::spawn_blocking(move || {
        let m = load_manifest(&root);
        let mut tile_count = 0usize;
        let mut object_count = 0usize;
        let mut total_bytes = 0u64;
        for rec in m.tiles.values() {
            if rec.empty || rec.objects == 0 {
                continue;
            }
            tile_count += 1;
            object_count += rec.objects;
            total_bytes += rec.bytes;
        }
        Ok(Vworld3dStatus {
            tile_count,
            object_count,
            total_bytes,
            regions: m.regions,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// 전체 삭제 — vworld3d 디렉터리 제거
#[tauri::command]
pub async fn vworld3d_clear(app_handle: tauri::AppHandle) -> Result<(), String> {
    if RUNNING.load(Ordering::SeqCst) {
        return Err("다운로드 진행 중에는 삭제할 수 없습니다".to_string());
    }
    let root = root_dir(&app_handle)?;
    let handle = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if root.exists() {
            std::fs::remove_dir_all(&root).map_err(|e| format!("삭제 실패: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;
    let _ = handle.emit("vworld3d-changed", ());
    Ok(())
}

/// 다운로드 — 중심좌표 + 반경(km) 안의 L15 타일을 받아 b3dm 으로 변환한다.
/// manifest 기반 재개(이미 변환된 타일 스킵), 취소, 완료 후 tileset.json 재생성.
#[tauri::command]
pub async fn vworld3d_download(
    app_handle: tauri::AppHandle,
    center_lon: f64,
    center_lat: f64,
    radius_km: f64,
) -> Result<String, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("이미 다운로드가 진행 중입니다".to_string());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let _guard = RunGuard;

    if !(center_lon.is_finite() && center_lat.is_finite()) || radius_km <= 0.0 {
        return Err("중심좌표/반경이 올바르지 않습니다".to_string());
    }

    let (api_key, referer) = load_credentials(&app_handle)?;
    let root = root_dir(&app_handle)?;
    std::fs::create_dir_all(root.join("tiles")).map_err(|e| format!("디렉터리 생성 실패: {e}"))?;

    // ① 타일 열거 + 재개 필터
    emit_progress(&app_handle, "enumerate", 0, 0, "대상 타일 계산 중...");
    let mut manifest = load_manifest(&root);
    let all = enumerate_tiles(center_lon, center_lat, radius_km);
    let total_all = all.len();
    let jobs: Vec<(u32, u32)> = all
        .into_iter()
        .filter(|(x, y)| !manifest.tiles.contains_key(&format!("{}_{}", x, y)))
        .collect();
    let skipped = total_all - jobs.len();
    emit_progress(
        &app_handle,
        "enumerate",
        skipped,
        total_all,
        &format!("대상 {}개 타일 (기존 {}개 건너뜀)", total_all, skipped),
    );
    log::info!(
        "[VW3D] 다운로드 시작 — 중심 {:.5},{:.5} 반경 {}km / 타일 {} (신규 {})",
        center_lon,
        center_lat,
        radius_km,
        total_all,
        jobs.len()
    );

    // HGT 선반입 (지반 스냅용)
    {
        let h = app_handle.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            preload_srtm(&h, center_lon, center_lat, radius_km)
        })
        .await;
    }

    // ② 타일 병렬 처리
    let ctx = Arc::new(Ctx {
        client: build_client()?,
        api_key,
        referer,
        root: root.clone(),
    });

    let mut done = skipped;
    let mut converted = 0usize;
    let mut objects = 0usize;
    let mut failed = 0usize;
    let mut cancelled = false;
    let mut since_flush = 0usize;
    let mut last_flush = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_millis(1000);

    {
        let stream = stream::iter(jobs.into_iter().map(|(x, y)| {
            let c = ctx.clone();
            let a = app_handle.clone();
            async move { process_tile(c, a, x, y).await }
        }))
        .buffer_unordered(TILE_CONCURRENCY);
        futures::pin_mut!(stream);

        while let Some(out) = stream.next().await {
            if out.cancelled {
                cancelled = true;
                break;
            }
            done += 1;
            since_flush += 1;
            if let Some(rec) = out.record {
                if rec.objects > 0 {
                    converted += 1;
                    objects += rec.objects;
                }
                manifest
                    .tiles
                    .insert(format!("{}_{}", out.idx, out.idy), rec);
            }
            if let Some(e) = out.error {
                failed += 1;
                log::warn!("[VW3D] 타일 {}_{} 실패 — {}", out.idx, out.idy, e);
            }

            // 중간 저장 — 타일 수와 경과 시간을 함께 봐서 (수만 타일이면 manifest 가 수 MB)
            // 잦은 전체 재기록으로 디스크를 갈지 않게 한다
            if since_flush >= MANIFEST_FLUSH_EVERY
                && last_flush.elapsed() >= Duration::from_secs(5)
            {
                since_flush = 0;
                last_flush = Instant::now();
                if let Err(e) = save_manifest(&root, &manifest) {
                    log::warn!("[VW3D] manifest 중간 저장 실패: {}", e);
                }
            }

            let last = done == total_all;
            if last || last_emit.elapsed().as_millis() >= PROGRESS_MIN_INTERVAL_MS {
                last_emit = Instant::now();
                emit_progress(
                    &app_handle,
                    "download",
                    done,
                    total_all,
                    &format!("타일 {}/{} · 건물 {}동", done, total_all, objects),
                );
            }
            if CANCEL.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
        }
    }

    // ③ manifest + tileset.json (부분 완료도 사용 가능하게 항상 기록)
    emit_progress(
        &app_handle,
        "tileset",
        done,
        total_all,
        "타일셋 생성 중...",
    );
    if !cancelled {
        manifest.regions.retain(|r| {
            (r.lon - center_lon).abs() > 1e-9
                || (r.lat - center_lat).abs() > 1e-9
                || (r.radius_km - radius_km).abs() > 1e-9
        });
        manifest.regions.push(RegionRecord {
            lon: center_lon,
            lat: center_lat,
            radius_km,
            ts: now_secs(),
        });
    }
    save_manifest(&root, &manifest)?;
    let leaves = {
        let r = root.clone();
        let m = manifest.clone();
        tauri::async_runtime::spawn_blocking(move || write_tileset(&r, &m))
            .await
            .map_err(|e| format!("spawn_blocking: {e}"))??
    };

    emit_progress(
        &app_handle,
        "tileset",
        total_all,
        total_all,
        if cancelled {
            "취소됨 — 여기까지 변환분 저장"
        } else {
            "완료"
        },
    );
    let _ = app_handle.emit("vworld3d-changed", ());

    let msg = format!(
        "{} — 신규 타일 {}개 변환 / 건물 {}동 / 실패 {}개 / 전체 타일셋 리프 {}개",
        if cancelled { "취소됨" } else { "완료" },
        converted,
        objects,
        failed,
        leaves
    );
    log::info!("[VW3D] {}", msg);
    Ok(msg)
}

// ─────────────────────────────────────────────────────────────
// 테스트 — 합성 바이너리 라운드트립
// ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── 합성 바이너리 빌더 ──
    #[derive(Default)]
    struct Buf(Vec<u8>);
    impl Buf {
        fn u8(&mut self, v: u8) -> &mut Self {
            self.0.push(v);
            self
        }
        fn u16(&mut self, v: u16) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn u32(&mut self, v: u32) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn f32(&mut self, v: f32) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn f64(&mut self, v: f64) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn pstr(&mut self, s: &str) -> &mut Self {
            let b = s.as_bytes();
            self.u8(b.len() as u8);
            self.0.extend_from_slice(b);
            self
        }
    }

    fn synth_dat_object(b: &mut Buf, ver4: u8, key: &str, lon: f64, lat: f64, file: &str) {
        b.u8(3).u8(0).u8(0).u8(ver4); // version 3.0.0.x
        b.u8(1); // type
        b.pstr(key);
        b.f64(lon).f64(lat);
        b.f32(12.5); // altitude
        for i in 0..6 {
            b.f64(100.0 + i as f64);
        }
        b.u8(4); // imgLevel
        b.pstr(file);
        b.pstr("tex_0.jpg");
    }

    fn synth_face(b: &mut Buf, vcount: u16, image: &str, nail: &[u8]) {
        b.u32(vcount as u32);
        for i in 0..vcount {
            let f = i as f32;
            b.f32(f).f32(f + 1.0).f32(f + 2.0); // pos
            b.f32(0.0).f32(0.0).f32(1.0); // normal
            b.f32(0.25).f32(0.75); // uv
        }
        b.u32(3);
        b.u16(0).u16(1).u16(2);
        b.u8(255).u8(10).u8(20).u8(30); // ARGB
        b.u8(2); // imageLevel
        b.pstr(image);
        b.u32(nail.len() as u32);
        b.0.extend_from_slice(nail);
    }

    fn synth_xdo(ver4: u8, faces: usize) -> Vec<u8> {
        let mut b = Buf::default();
        b.u8(7); // type
        b.u32(4242); // objectId
        b.pstr("OBJKEY");
        for i in 0..6 {
            b.f64(1000.0 * (i + 1) as f64);
        }
        b.f32(33.25); // altitude
        if ver4 == 2 {
            b.u8(faces as u8);
        }
        for i in 0..faces {
            synth_face(&mut b, 3, if i == 0 { "a.jpg" } else { "" }, &[1, 2, 3, 4]);
        }
        b.0
    }

    #[test]
    fn dat_roundtrip() {
        let mut b = Buf::default();
        b.u32(15).u32(1234).u32(5678).u32(2);
        synth_dat_object(&mut b, 1, "KEY-A", 126.98, 37.56, "a.xdo");
        synth_dat_object(&mut b, 2, "KEY-B", 126.99, 37.57, "b.xdo");

        let dat = parse_dat(&b.0).expect("파싱 성공");
        assert_eq!(dat.level, 15);
        assert_eq!(dat.idx, 1234);
        assert_eq!(dat.idy, 5678);
        assert_eq!(dat.objects.len(), 2);
        assert_eq!(dat.objects[0].key, "KEY-A");
        assert_eq!(dat.objects[0].version, [3, 0, 0, 1]);
        assert_eq!(dat.objects[1].version[3], 2);
        assert!((dat.objects[1].center_lon - 126.99).abs() < 1e-12);
        assert!((dat.objects[1].center_lat - 37.57).abs() < 1e-12);
        assert!((dat.objects[0].altitude - 12.5).abs() < 1e-6);
        assert_eq!(dat.objects[0].data_file, "a.xdo");
        assert_eq!(dat.objects[1].img_file_name, "tex_0.jpg");
        assert_eq!(dat.objects[0].bbox[5], 105.0);
    }

    #[test]
    fn dat_truncated_keeps_prefix() {
        let mut b = Buf::default();
        b.u32(15).u32(1).u32(2).u32(2);
        synth_dat_object(&mut b, 1, "KEY-A", 126.98, 37.56, "a.xdo");
        b.u8(3).u8(0).u8(0).u8(2); // 두 번째는 헤더만 남기고 잘림
        let dat = parse_dat(&b.0).expect("헤더는 유효");
        assert_eq!(dat.objects.len(), 1, "잘린 오브젝트는 버리고 앞부분만 유지");
    }

    #[test]
    fn dat_header_truncated_errors() {
        let b = vec![0u8; 6];
        assert!(parse_dat(&b).is_err());
    }

    #[test]
    fn xdo_v1_roundtrip() {
        let raw = synth_xdo(1, 1);
        let o = parse_xdo(&raw, 1).expect("v1 파싱");
        assert_eq!(o.obj_type, 7);
        assert_eq!(o.object_id, 4242);
        assert_eq!(o.key, "OBJKEY");
        assert!((o.altitude - 33.25).abs() < 1e-6);
        assert_eq!(o.object_box[0], 1000.0);
        assert_eq!(o.faces.len(), 1);
        let f = &o.faces[0];
        assert_eq!(f.positions.len(), 3);
        assert_eq!(f.indices, vec![0, 1, 2]);
        assert_eq!(f.color, [255, 10, 20, 30]);
        assert_eq!(f.image_name, "a.jpg");
        assert_eq!(f.nail, vec![1, 2, 3, 4]);
        assert_eq!(f.uvs[0], [0.25, 0.75], "UV 는 뒤집지 않는다(glTF 규약)");
        // AABB 중심
        let c = o.box_center();
        assert_eq!(c.0, (1000.0 + 4000.0) / 2.0);
    }

    #[test]
    fn xdo_v2_multiface_roundtrip() {
        let raw = synth_xdo(2, 3);
        let o = parse_xdo(&raw, 2).expect("v2 파싱");
        assert_eq!(o.faces.len(), 3, "nail 을 정확히 소비해야 다음 face 가 맞는다");
        assert_eq!(o.faces[1].image_name, "");
        assert_eq!(o.faces[2].positions.len(), 3);
    }

    #[test]
    fn xdo_version_fallback() {
        // v2 파일을 v1 이라 선언해도 폴백으로 복구된다
        let raw = synth_xdo(2, 2);
        let o = parse_xdo(&raw, 1).expect("폴백 파싱");
        assert_eq!(o.faces.len(), 2);
    }

    #[test]
    fn xdo_truncated_errors() {
        let raw = synth_xdo(1, 1);
        let cut = &raw[..raw.len() - 3];
        assert!(parse_xdo(cut, 1).is_err(), "잘린 nail 은 실패해야 한다");
    }

    #[test]
    fn tile_grid_roundtrip() {
        let (lon, lat) = (126.9784, 37.5665);
        let (idx, idy) = lonlat_to_tile(lon, lat);
        let b = tile_bounds(idx, idy);
        assert!(b[0] <= lon && lon < b[2], "경도 포함");
        assert!(b[1] <= lat && lat < b[3], "위도 포함");
        assert!((b[2] - b[0] - UNIT).abs() < 1e-12);
        let (clon, clat) = tile_center(idx, idy);
        assert_eq!(lonlat_to_tile(clon, clat), (idx, idy));
        // level 15 격자 크기
        assert!((UNIT - 0.0010986328125).abs() < 1e-15);
    }

    #[test]
    fn enumerate_tiles_within_radius() {
        let tiles = enumerate_tiles(126.9784, 37.5665, 1.0);
        assert!(!tiles.is_empty());
        let (mlon, mlat) = deg_to_meters(37.5665);
        for (x, y) in &tiles {
            let (clon, clat) = tile_center(*x, *y);
            let d = (((clon - 126.9784) * mlon).powi(2) + ((clat - 37.5665) * mlat).powi(2)).sqrt();
            assert!(d <= 1000.0 + 1e-6, "중심이 반경 안");
        }
    }

    /// 구면 프레임(F = ECEF 의 Y 부호 반전) 위 점 생성
    fn sphere_point(lon: f64, lat: f64, h: f64) -> (f64, f64, f64) {
        let p = lon.to_radians();
        let t = lat.to_radians();
        let r = SPHERE_R + h;
        (r * t.cos() * p.cos(), -r * t.cos() * p.sin(), r * t.sin())
    }

    #[test]
    fn rotate_local_gives_enu() {
        let (lon, lat) = (127.0, 37.5);
        let (x, y, z) = sphere_point(lon, lat, 50.0);
        let (rx, ry, rz) = rotate_local(x, y, z, lon, lat);
        assert!(rx.abs() < 1e-6, "east ≈ 0");
        assert!(ry.abs() < 1e-6, "north ≈ 0");
        assert!((rz - SPHERE_R - 50.0).abs() < 1e-4, "up = R + h");
    }

    #[test]
    fn convert_object_snaps_to_ground() {
        let (lon, lat) = (127.0, 37.5);
        let (cx, cy, cz) = sphere_point(lon, lat, 50.0);
        // AABB 중심이 (lon,lat,+50m), 정점 오프셋 0 → 국소 ENU (0,0,50)
        let obj = XdoObject {
            object_box: [cx, cy, cz, cx, cy, cz],
            altitude: 50.0,
            faces: vec![XdoFace {
                positions: vec![[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
                normals: vec![[0.0, 0.0, 1.0]; 3],
                uvs: vec![[0.0, 0.0]; 3],
                indices: vec![0, 1, 2],
                color: [255, 200, 200, 200],
                ..Default::default()
            }],
            ..Default::default()
        };
        // 타일 중심 = 오브젝트 중심, DEM 100m → 기저 50m 를 100m 로 이동
        let c = convert_object(&obj, lon, lat, 50.0, lon, lat, Some(100.0));
        assert!(c.snapped);
        let p = &c.faces[0].positions;
        assert!(p[0].abs() < 1e-2, "east ≈ 0");
        assert!((p[1] - 100.0).abs() < 1e-2, "up = DEM 지반고");
        assert!(p[2].abs() < 1e-2, "−north ≈ 0");
        // DEM 없으면 원본 유지
        let c2 = convert_object(&obj, lon, lat, 50.0, lon, lat, None);
        assert!(!c2.snapped);
        assert!((c2.faces[0].positions[1] - 50.0).abs() < 1e-2);
    }

    fn sample_prim(image: Option<usize>) -> GlbPrimitive {
        GlbPrimitive {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 2.0, 0.0],
            normals: vec![0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0],
            uvs: vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            indices: vec![0, 1, 2],
            image,
            color: [1.0, 1.0, 1.0, 1.0],
        }
    }

    #[test]
    fn glb_header_and_padding() {
        let glb = build_glb(&[sample_prim(None)], &[]).expect("GLB 생성");
        assert_eq!(&glb[0..4], b"glTF");
        assert_eq!(u32::from_le_bytes(glb[4..8].try_into().unwrap()), 2);
        assert_eq!(
            u32::from_le_bytes(glb[8..12].try_into().unwrap()) as usize,
            glb.len(),
            "헤더 길이 = 실제 길이"
        );
        assert_eq!(glb.len() % 8, 0, "b3dm 8정렬을 위해 GLB 전체가 8배수");

        let json_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
        assert_eq!(&glb[16..20], b"JSON");
        assert_eq!(json_len % 4, 0, "JSON 청크 4배수 패딩");
        let json_end = 20 + json_len;
        assert_eq!(glb[json_end - 1], b' ', "JSON 패딩은 스페이스");

        let bin_len = u32::from_le_bytes(glb[json_end..json_end + 4].try_into().unwrap()) as usize;
        assert_eq!(&glb[json_end + 4..json_end + 8], b"BIN\0");
        assert_eq!(bin_len % 4, 0, "BIN 청크 4배수 패딩");
        assert_eq!(json_end + 8 + bin_len, glb.len());

        let v: Value = serde_json::from_slice(&glb[20..json_end]).expect("JSON 파싱");
        assert_eq!(v["asset"]["version"], "2.0");
        assert_eq!(v["buffers"][0]["byteLength"].as_u64().unwrap() as usize, bin_len);
        assert_eq!(v["meshes"][0]["primitives"].as_array().unwrap().len(), 1);
        // 텍스처 없는 프리미티브는 TEXCOORD_0 생략
        assert!(v["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"].is_null());
        assert!(v["images"].is_null());
        // POSITION accessor 의 min/max
        let acc = &v["accessors"][0];
        assert_eq!(acc["type"], "VEC3");
        assert_eq!(acc["count"], 3);
        assert_eq!(acc["min"][1].as_f64().unwrap(), 0.0);
        assert_eq!(acc["max"][1].as_f64().unwrap(), 2.0);
        // 인덱스는 u16 (5123)
        let last = v["accessors"].as_array().unwrap().last().unwrap();
        assert_eq!(last["componentType"], 5123);
    }

    #[test]
    fn glb_with_texture_has_image_view() {
        let jpg = vec![0xFFu8, 0xD8, 0xFF, 0xE0, 1, 2, 3];
        let glb = build_glb(&[sample_prim(Some(0))], &[jpg.clone()]).expect("GLB 생성");
        let json_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
        let v: Value = serde_json::from_slice(&glb[20..20 + json_len]).expect("JSON");
        assert_eq!(v["images"][0]["mimeType"], "image/jpeg");
        assert_eq!(v["textures"][0]["source"], 0);
        assert_eq!(v["samplers"].as_array().unwrap().len(), 1);
        assert_eq!(
            v["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"],
            0
        );
        assert!(!v["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"].is_null());
        // 이미지 bufferView 바이트가 BIN 청크에 그대로 임베드됐는지
        let iv = v["images"][0]["bufferView"].as_u64().unwrap() as usize;
        let off = v["bufferViews"][iv]["byteOffset"].as_u64().unwrap() as usize;
        let len = v["bufferViews"][iv]["byteLength"].as_u64().unwrap() as usize;
        let bin_start = 20 + json_len + 8;
        assert_eq!(&glb[bin_start + off..bin_start + off + len], &jpg[..]);
    }

    #[test]
    fn glb_empty_is_error() {
        assert!(build_glb(&[], &[]).is_err());
    }

    #[test]
    fn b3dm_header_and_alignment() {
        let glb = build_glb(&[sample_prim(None)], &[]).expect("GLB");
        let b = wrap_b3dm(&glb);
        assert_eq!(&b[0..4], b"b3dm");
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 1);
        assert_eq!(
            u32::from_le_bytes(b[8..12].try_into().unwrap()) as usize,
            b.len()
        );
        let ft_json = u32::from_le_bytes(b[12..16].try_into().unwrap()) as usize;
        assert_eq!(u32::from_le_bytes(b[16..20].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(b[20..24].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(b[24..28].try_into().unwrap()), 0);
        assert_eq!((28 + ft_json) % 8, 0, "GLB 는 8바이트 경계에서 시작");
        assert_eq!(b.len() % 8, 0, "타일 전체 길이 8정렬");
        let ft: Value = serde_json::from_slice(&b[28..28 + ft_json]).expect("featureTable JSON");
        assert_eq!(ft["BATCH_LENGTH"], 0);
        assert_eq!(&b[28 + ft_json..28 + ft_json + 4], b"glTF");
        assert_eq!(&b[28 + ft_json..], &glb[..]);
    }

    #[test]
    fn enu_frame_is_column_major() {
        let m = enu_to_fixed_frame(0.0, 0.0, 0.0);
        // lon=0, lat=0 → east=+Y, north=+Z, up=+X, 원점=(a,0,0)
        assert!((m[0] - 0.0).abs() < 1e-9 && (m[1] - 1.0).abs() < 1e-9);
        assert!((m[6] - 1.0).abs() < 1e-9);
        assert!((m[8] - 1.0).abs() < 1e-9);
        assert!((m[12] - WGS84_A).abs() < 1e-3);
        assert_eq!(m[15], 1.0);
    }

    #[test]
    fn tileset_from_manifest() {
        let dir = std::env::temp_dir().join(format!("vw3d_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("tiles")).unwrap();
        std::fs::write(dir.join("tiles/100_200.b3dm"), b"x").unwrap();

        let mut m = Manifest::default();
        m.tiles.insert(
            "100_200".to_string(),
            TileRecord {
                objects: 3,
                empty: false,
                bbox: [127.0, 37.0, 127.001, 37.001, 10.0, 60.0],
                snapped: true,
                ts: 1,
                bytes: 1,
            },
        );
        // 파일 없는 항목 + 빈 타일은 리프에서 제외돼야 한다
        m.tiles.insert(
            "101_200".to_string(),
            TileRecord {
                objects: 1,
                empty: false,
                bbox: [127.0, 37.0, 127.1, 37.1, 0.0, 1.0],
                snapped: true,
                ts: 1,
                bytes: 1,
            },
        );
        m.tiles.insert("102_200".to_string(), TileRecord::default());

        let leaves = write_tileset(&dir, &m).unwrap();
        assert_eq!(leaves, 1);
        let v: Value =
            serde_json::from_slice(&std::fs::read(dir.join("tileset.json")).unwrap()).unwrap();
        assert_eq!(v["asset"]["version"], "1.0");
        assert_eq!(v["root"]["refine"], "ADD");
        let leaf = &v["root"]["children"][0]["children"][0];
        assert_eq!(leaf["content"]["uri"], "tiles/100_200.b3dm");
        assert_eq!(leaf["geometricError"], 0.0);
        assert_eq!(leaf["transform"].as_array().unwrap().len(), 16);
        let region = leaf["boundingVolume"]["region"].as_array().unwrap();
        assert!((region[0].as_f64().unwrap() - 127.0_f64.to_radians()).abs() < 1e-12);
        assert_eq!(region[4].as_f64().unwrap(), 10.0);

        // 리프가 하나도 없으면 tileset.json 제거
        let empty = Manifest::default();
        assert_eq!(write_tileset(&dir, &empty).unwrap(), 0);
        assert!(!dir.join("tileset.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn manifest_json_shape() {
        let mut m = Manifest::default();
        m.tiles.insert(
            "1_2".to_string(),
            TileRecord {
                objects: 5,
                empty: false,
                bbox: [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
                snapped: true,
                ts: 42,
                bytes: 128,
            },
        );
        m.regions.push(RegionRecord {
            lon: 126.8,
            lat: 37.5,
            radius_km: 5.0,
            ts: 42,
        });
        let v: Value = serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["tiles"]["1_2"]["objects"], 5);
        assert_eq!(v["tiles"]["1_2"]["snapped"], true);
        assert_eq!(v["regions"][0]["radiusKm"], 5.0);
        // 라운드트립
        let back: Manifest = serde_json::from_value(v).unwrap();
        assert_eq!(back.tiles["1_2"].bytes, 128);
    }

    #[test]
    fn xml_error_detection() {
        let ok = xml_error_code(b"<?xml version=\"1.0\"?><Error code=\"ERROR_SERVICE_FILE_NOTTHING\"/>");
        assert_eq!(ok.as_deref(), Some("ERROR_SERVICE_FILE_NOTTHING"));
        // 정상 .dat 선두(level=15) 는 XML 로 오인되지 않는다
        assert!(xml_error_code(&[0x0F, 0x00, 0x00, 0x00]).is_none());
    }

    #[test]
    fn percent_encoding_is_conservative() {
        assert_eq!(percent_encode("a_b-c.d~e"), "a_b-c.d~e");
        assert_eq!(percent_encode("a b&c=d"), "a%20b%26c%3Dd");
    }
}
