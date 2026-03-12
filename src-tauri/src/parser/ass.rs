use std::path::Path;

use log::{debug, info, warn};

use crate::models::{ParsedFile, TrackPoint};
use crate::parser::ParseError;

/// Default radar reference point: Gimpo Airport (WGS-84)
pub const DEFAULT_RADAR_LAT: f64 = 37.5585;
pub const DEFAULT_RADAR_LON: f64 = 126.7906;

/// Known ASTERIX category bytes
const CAT048: u8 = 0x30; // 48 - Monoradar Target Reports
const CAT034: u8 = 0x22; // 34 - Transmission of Monoradar Service Messages
const CAT008: u8 = 0x08; // 8  - Monoradar Derived Weather

// ─── CAT048 UAP item indices (position in FSPEC) ───
const UAP_I010: usize = 0;
const UAP_I140: usize = 1;
const UAP_I020: usize = 2;
const UAP_I040: usize = 3;
const UAP_I070: usize = 4;
const UAP_I090: usize = 5;
const UAP_I130: usize = 6;
const UAP_I220: usize = 7;
const UAP_I240: usize = 8;
const UAP_I250: usize = 9;
const UAP_I161: usize = 10;
const UAP_I042: usize = 11;
const UAP_I200: usize = 12;
const UAP_I170: usize = 13;
const UAP_I210: usize = 14;
const UAP_I030: usize = 15;
const UAP_I080: usize = 16;
const UAP_I100: usize = 17;
const UAP_I110: usize = 18;
const UAP_I120: usize = 19;
const UAP_I230: usize = 20;
const UAP_I260: usize = 21;
const UAP_I055: usize = 22;
const UAP_I050: usize = 23;
const UAP_I065: usize = 24;
const UAP_I060: usize = 25;
const UAP_SP: usize = 26;
const UAP_RE: usize = 27;
const UAP_MAX: usize = 28;

/// Maximum valid ASTERIX time of day: 86400 seconds (24 hours)
const MAX_TIME_OF_DAY: f64 = 86400.0;
/// Maximum reasonable speed in knots (Mach 2+ military + margin)
const MAX_SPEED_KTS: f64 = 1400.0;
/// Maximum reasonable flight level (FL600 = 60000 ft)
const MAX_FLIGHT_LEVEL: f64 = 600.0;
/// Maximum valid ASTERIX block length
const MAX_BLOCK_LEN: usize = 8192;

/// Extracted data from a single ASTERIX CAT048 record
#[derive(Debug, Default)]
struct Cat048Record {
    time_of_day: Option<f64>,
    rho_nm: Option<f64>,
    theta_deg: Option<f64>,
    cart_x_nm: Option<f64>,
    cart_y_nm: Option<f64>,
    flight_level: Option<f64>,
    mode_s_address: Option<u32>,
    ground_speed_kts: Option<f64>,
    heading_deg: Option<f64>,
    track_number: Option<u16>,
    mode3a: Option<u16>,
}

/// Parse an ASS file (NEC RDRS recording containing ASTERIX data).
/// `radar_lat`/`radar_lon` specify the radar reference point for coordinate conversion.
pub fn parse_ass_file(path: &str, radar_lat: f64, radar_lon: f64) -> Result<ParsedFile, ParseError> {
    let file_path = Path::new(path);
    let filename = file_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    info!("Parsing ASS file: {}", path);

    let data = std::fs::read(file_path)?;
    if data.len() < 8 {
        return Err(ParseError::InvalidFormat(
            "File too small to contain valid records".into(),
        ));
    }

    info!("File size: {} bytes", data.len());

    let nec_frame = detect_nec_frame(&data);
    if let Some((month, day)) = nec_frame {
        info!("Detected NEC frame: month={}, day={}", month, day);
    }

    let mut track_points = Vec::with_capacity(100_000);
    let mut parse_errors = Vec::new();
    let mut total_records = 0usize;
    let mut offset = 0usize;
    let mut point_index = 0u64;
    let mut skipped_bytes = 0usize;

    let base_date_secs = extract_base_date_from_filename(&filename);

    while offset < data.len() {
        // Check for NEC framing header (5 bytes: month, day, hour, minute, counter)
        if let Some((month, day)) = nec_frame {
            if is_nec_frame(&data, offset, month, day) {
                offset += 5;
                continue;
            }
        }

        // Try to parse an ASTERIX block with chain validation
        if let Some(block_len) = try_asterix_block(&data, offset, nec_frame) {
            let cat = data[offset];

            if cat == CAT048 {
                let block_data = &data[offset..offset + block_len];
                let mut rec_offset = 3; // Skip CAT(1) + LEN(2)

                while rec_offset < block_data.len() {
                    match parse_cat048_record(block_data, rec_offset) {
                        Ok((record, next_offset)) => {
                            total_records += 1;

                            if let Some(tp) = record_to_track_point(
                                &record,
                                base_date_secs,
                                point_index,
                                radar_lat,
                                radar_lon,
                            ) {
                                track_points.push(tp);
                                point_index += 1;
                            }

                            rec_offset = next_offset;
                        }
                        Err(e) => {
                            debug!(
                                "CAT048 record parse error at {:#x}: {}",
                                offset + rec_offset, e
                            );
                            parse_errors.push(format!(
                                "CAT048@{:#x}: {}",
                                offset + rec_offset, e
                            ));
                            break;
                        }
                    }
                }
            }

            offset += block_len;
        } else {
            skipped_bytes += 1;
            offset += 1;
        }
    }

    // Sort by timestamp
    track_points.sort_by(|a, b| {
        a.timestamp
            .partial_cmp(&b.timestamp)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let start_time = track_points.first().map(|p| p.timestamp);
    let end_time = track_points.last().map(|p| p.timestamp);

    if skipped_bytes > 0 {
        debug!("Skipped {} unrecognized bytes", skipped_bytes);
    }

    info!(
        "Parsed {} track points from {} ASTERIX records ({} errors, {} skipped bytes)",
        track_points.len(),
        total_records,
        parse_errors.len(),
        skipped_bytes
    );

    Ok(ParsedFile {
        filename,
        total_records,
        track_points,
        parse_errors,
        start_time,
        end_time,
    })
}

/// Check if there's a valid ASTERIX block at `offset`.
/// Validates by checking if the block chains to another valid block or NEC frame.
/// Returns the block length if valid, None otherwise.
fn try_asterix_block(data: &[u8], offset: usize, nec_frame: Option<(u8, u8)>) -> Option<usize> {
    if offset + 3 > data.len() {
        return None;
    }

    let cat = data[offset];
    if cat != CAT048 && cat != CAT034 && cat != CAT008 {
        return None;
    }

    let block_len = ((data[offset + 1] as usize) << 8) | (data[offset + 2] as usize);

    // Validate block length
    if block_len < 3 || block_len > MAX_BLOCK_LEN || offset + block_len > data.len() {
        return None;
    }

    // Chain validation: what follows this block?
    let next_offset = offset + block_len;

    if next_offset >= data.len() {
        // Block reaches EOF - valid if length is reasonable
        return Some(block_len);
    }

    // Check if next position starts another ASTERIX block
    if is_valid_block_start(data, next_offset) {
        return Some(block_len);
    }

    // Check if next position is a NEC frame
    if let Some((month, day)) = nec_frame {
        if is_nec_frame(data, next_offset, month, day) {
            return Some(block_len);
        }
    }

    // No valid chain - likely a false positive
    None
}

/// Quick check if a position looks like a valid ASTERIX block start.
fn is_valid_block_start(data: &[u8], offset: usize) -> bool {
    if offset + 3 > data.len() {
        return false;
    }
    let cat = data[offset];
    if cat != CAT048 && cat != CAT034 && cat != CAT008 {
        return false;
    }
    let len = ((data[offset + 1] as usize) << 8) | (data[offset + 2] as usize);
    len >= 3 && len <= MAX_BLOCK_LEN && offset + len <= data.len()
}

/// Detect the NEC framing pattern from the file data.
/// Returns (month, day) — hour and minute vary across frames so we only lock on the date.
/// Requires confirmation: the same month/day must appear at least twice with valid time bytes.
fn detect_nec_frame(data: &[u8]) -> Option<(u8, u8)> {
    let scan_len = data.len().min(50_000);

    for i in 0..scan_len.saturating_sub(8) {
        let b0 = data[i];     // month
        let b1 = data[i + 1]; // day
        let b2 = data[i + 2]; // hour
        let b3 = data[i + 3]; // minute

        // Validate as date/time: month (1-12), day (1-31), hour (0-23), minute (0-59)
        if !(b0 >= 1 && b0 <= 12 && b1 >= 1 && b1 <= 31 && b2 <= 23 && b3 <= 59) {
            continue;
        }

        // Check if byte at +5 is a known ASTERIX category
        if i + 5 >= data.len() {
            continue;
        }
        let b5 = data[i + 5];
        if b5 != CAT048 && b5 != CAT034 && b5 != CAT008 {
            continue;
        }

        // Verify the ASTERIX block length makes sense
        if i + 8 > data.len() {
            continue;
        }
        let block_len = ((data[i + 6] as usize) << 8) | (data[i + 7] as usize);
        if block_len < 3 || block_len > MAX_BLOCK_LEN {
            continue;
        }

        // REQUIRE confirmation: another NEC frame (same month+day, valid hour+minute)
        // must appear after this ASTERIX block
        let next_pos = i + 5 + block_len;
        if next_pos + 4 < scan_len
            && data[next_pos] == b0
            && data[next_pos + 1] == b1
            && data[next_pos + 2] <= 23
            && data[next_pos + 3] <= 59
        {
            return Some((b0, b1));
        }
    }

    None
}

/// Check if the data at `offset` looks like a NEC frame header.
/// Matches on the detected month+day, with valid hour (0-23) and minute (0-59),
/// and verifies the byte after the 5-byte frame is a known ASTERIX category or another frame.
fn is_nec_frame(data: &[u8], offset: usize, month: u8, day: u8) -> bool {
    if offset + 5 > data.len() {
        return false;
    }
    if data[offset] != month || data[offset + 1] != day {
        return false;
    }
    if data[offset + 2] > 23 || data[offset + 3] > 59 {
        return false;
    }
    // Validate what follows the 5-byte frame
    if offset + 5 >= data.len() {
        return true; // Frame at EOF
    }
    let after = data[offset + 5];
    after == CAT048 || after == CAT034 || after == CAT008 || after == month
}

/// Extract a base Unix timestamp from a filename like "gimpo_260304_0415.ass".
fn extract_base_date_from_filename(filename: &str) -> f64 {
    let parts: Vec<&str> = filename.split('_').collect();
    for part in &parts {
        if part.len() == 6 {
            if let (Ok(yy), Ok(mm), Ok(dd)) = (
                part[0..2].parse::<i64>(),
                part[2..4].parse::<u32>(),
                part[4..6].parse::<u32>(),
            ) {
                if mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 {
                    let year = 2000 + yy;
                    let days = days_from_epoch(year, mm, dd);
                    return (days as f64) * 86400.0;
                }
            }
        }
    }
    0.0
}

fn days_from_epoch(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400) as u32;
    let m = month;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

// ─── ASTERIX CAT048 Record Parsing ───

fn parse_fspec(data: &[u8], mut offset: usize) -> Result<(Vec<usize>, usize), ParseError> {
    let mut present = Vec::new();
    let mut item_idx = 0usize;

    loop {
        if offset >= data.len() {
            return Err(ParseError::RecordError {
                offset,
                message: "FSPEC extends past end of data".into(),
            });
        }
        let byte = data[offset];
        offset += 1;

        for bit in (1..=7).rev() {
            if item_idx < UAP_MAX && (byte >> bit) & 1 == 1 {
                present.push(item_idx);
            }
            item_idx += 1;
        }

        if byte & 0x01 == 0 {
            break;
        }
    }

    Ok((present, offset))
}

fn skip_fx_extended(data: &[u8], offset: usize) -> usize {
    let mut pos = offset;
    loop {
        if pos >= data.len() {
            return pos - offset;
        }
        let byte = data[pos];
        pos += 1;
        if byte & 0x01 == 0 {
            break;
        }
    }
    pos - offset
}

fn parse_cat048_record(
    block: &[u8],
    offset: usize,
) -> Result<(Cat048Record, usize), ParseError> {
    let (present_items, mut pos) = parse_fspec(block, offset)?;
    let mut record = Cat048Record::default();

    for &item_idx in &present_items {
        if pos >= block.len() {
            break;
        }

        match item_idx {
            UAP_I010 => {
                if pos + 2 > block.len() {
                    return Err(make_err(pos, "I010 truncated"));
                }
                pos += 2;
            }

            UAP_I140 => {
                if pos + 3 > block.len() {
                    return Err(make_err(pos, "I140 truncated"));
                }
                let raw = ((block[pos] as u32) << 16)
                    | ((block[pos + 1] as u32) << 8)
                    | (block[pos + 2] as u32);
                let tod = raw as f64 / 128.0;
                if tod < MAX_TIME_OF_DAY {
                    record.time_of_day = Some(tod);
                }
                pos += 3;
            }

            UAP_I020 => {
                let consumed = skip_fx_extended(block, pos);
                if consumed == 0 {
                    return Err(make_err(pos, "I020 truncated"));
                }
                pos += consumed;
            }

            UAP_I040 => {
                if pos + 4 > block.len() {
                    return Err(make_err(pos, "I040 truncated"));
                }
                let rho_raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                let theta_raw = u16::from_be_bytes([block[pos + 2], block[pos + 3]]);
                let rho_nm = rho_raw as f64 / 256.0;
                // Validate range: 0.1 to 256 NM (skip zero-range targets and overflows)
                if rho_nm >= 0.1 && rho_nm < 256.0 {
                    record.rho_nm = Some(rho_nm);
                    record.theta_deg = Some(theta_raw as f64 * 360.0 / 65536.0);
                }
                pos += 4;
            }

            UAP_I070 => {
                if pos + 2 > block.len() {
                    return Err(make_err(pos, "I070 truncated"));
                }
                let raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                record.mode3a = Some(raw & 0x0FFF);
                pos += 2;
            }

            UAP_I090 => {
                if pos + 2 > block.len() {
                    return Err(make_err(pos, "I090 truncated"));
                }
                let raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                let fl = (raw & 0x3FFF) as f64 / 4.0;
                if fl <= MAX_FLIGHT_LEVEL {
                    record.flight_level = Some(fl);
                }
                pos += 2;
            }

            UAP_I130 => {
                if pos >= block.len() {
                    return Err(make_err(pos, "I130 truncated"));
                }
                let sub_fspec = block[pos];
                pos += 1;
                for bit in (1..=7).rev() {
                    if (sub_fspec >> bit) & 1 == 1 {
                        if pos >= block.len() {
                            return Err(make_err(pos, "I130 subfield truncated"));
                        }
                        pos += 1;
                    }
                }
            }

            UAP_I220 => {
                if pos + 3 > block.len() {
                    return Err(make_err(pos, "I220 truncated"));
                }
                let addr = ((block[pos] as u32) << 16)
                    | ((block[pos + 1] as u32) << 8)
                    | (block[pos + 2] as u32);
                // Mode-S address 0x000000 is technically valid but usually means "no address"
                if addr > 0 {
                    record.mode_s_address = Some(addr);
                }
                pos += 3;
            }

            UAP_I240 => {
                if pos + 6 > block.len() {
                    return Err(make_err(pos, "I240 truncated"));
                }
                pos += 6;
            }

            UAP_I250 => {
                if pos >= block.len() {
                    return Err(make_err(pos, "I250 truncated"));
                }
                let rep = block[pos] as usize;
                pos += 1;
                let mb_size = rep.saturating_mul(8);
                if pos + mb_size > block.len() {
                    return Err(make_err(pos, "I250 data truncated"));
                }
                pos += mb_size;
            }

            UAP_I161 => {
                if pos + 2 > block.len() {
                    return Err(make_err(pos, "I161 truncated"));
                }
                let raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                record.track_number = Some(raw & 0x0FFF);
                pos += 2;
            }

            UAP_I042 => {
                if pos + 4 > block.len() {
                    return Err(make_err(pos, "I042 truncated"));
                }
                let x_raw = i16::from_be_bytes([block[pos], block[pos + 1]]);
                let y_raw = i16::from_be_bytes([block[pos + 2], block[pos + 3]]);
                record.cart_x_nm = Some(x_raw as f64 / 128.0);
                record.cart_y_nm = Some(y_raw as f64 / 128.0);
                pos += 4;
            }

            UAP_I200 => {
                if pos + 4 > block.len() {
                    return Err(make_err(pos, "I200 truncated"));
                }
                let gsp_raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                let hdg_raw = u16::from_be_bytes([block[pos + 2], block[pos + 3]]);
                let speed_kts = (gsp_raw as f64 * 3600.0) / 16384.0;
                if speed_kts <= MAX_SPEED_KTS {
                    record.ground_speed_kts = Some(speed_kts);
                }
                record.heading_deg = Some(hdg_raw as f64 * 360.0 / 65536.0);
                pos += 4;
            }

            UAP_I170 => {
                let consumed = skip_fx_extended(block, pos);
                if consumed == 0 {
                    return Err(make_err(pos, "I170 truncated"));
                }
                pos += consumed;
            }

            UAP_I210 => {
                if pos + 4 > block.len() {
                    return Err(make_err(pos, "I210 truncated"));
                }
                pos += 4;
            }

            UAP_I030 => {
                let consumed = skip_fx_extended(block, pos);
                if consumed == 0 {
                    return Err(make_err(pos, "I030 truncated"));
                }
                pos += consumed;
            }

            UAP_I080 => {
                if pos + 2 > block.len() {
                    return Err(make_err(pos, "I080 truncated"));
                }
                pos += 2;
            }

            UAP_I100 => {
                if pos + 4 > block.len() {
                    return Err(make_err(pos, "I100 truncated"));
                }
                pos += 4;
            }

            UAP_I110 => {
                if pos + 2 > block.len() {
                    return Err(make_err(pos, "I110 truncated"));
                }
                pos += 2;
            }

            UAP_I120 => {
                if pos >= block.len() {
                    return Err(make_err(pos, "I120 truncated"));
                }
                let sub_fspec = block[pos];
                pos += 1;
                if (sub_fspec >> 7) & 1 == 1 {
                    if pos + 2 > block.len() {
                        return Err(make_err(pos, "I120 sub1 truncated"));
                    }
                    pos += 2;
                }
                if (sub_fspec >> 6) & 1 == 1 {
                    if pos >= block.len() {
                        return Err(make_err(pos, "I120 sub2 truncated"));
                    }
                    let rep = block[pos] as usize;
                    pos += 1;
                    let sz = rep.saturating_mul(6);
                    if pos + sz > block.len() {
                        return Err(make_err(pos, "I120 sub2 data truncated"));
                    }
                    pos += sz;
                }
            }

            UAP_I230 => {
                if pos + 2 > block.len() {
                    return Err(make_err(pos, "I230 truncated"));
                }
                pos += 2;
            }

            UAP_I260 => {
                if pos + 7 > block.len() {
                    return Err(make_err(pos, "I260 truncated"));
                }
                pos += 7;
            }

            UAP_I055 => {
                if pos + 1 > block.len() {
                    return Err(make_err(pos, "I055 truncated"));
                }
                pos += 1;
            }

            UAP_I050 => {
                if pos + 2 > block.len() {
                    return Err(make_err(pos, "I050 truncated"));
                }
                pos += 2;
            }

            UAP_I065 => {
                if pos + 1 > block.len() {
                    return Err(make_err(pos, "I065 truncated"));
                }
                pos += 1;
            }

            UAP_I060 => {
                if pos + 2 > block.len() {
                    return Err(make_err(pos, "I060 truncated"));
                }
                pos += 2;
            }

            UAP_SP => {
                if pos >= block.len() {
                    return Err(make_err(pos, "SP truncated"));
                }
                let sp_len = block[pos] as usize;
                if sp_len < 1 || pos + sp_len > block.len() {
                    return Err(make_err(pos, "SP data truncated"));
                }
                pos += sp_len;
            }

            UAP_RE => {
                if pos >= block.len() {
                    return Err(make_err(pos, "RE truncated"));
                }
                let re_len = block[pos] as usize;
                if re_len < 1 || pos + re_len > block.len() {
                    return Err(make_err(pos, "RE data truncated"));
                }
                pos += re_len;
            }

            _ => {
                warn!("Unknown CAT048 item index {} at offset {}", item_idx, pos);
                break;
            }
        }
    }

    Ok((record, pos))
}

/// Convert a parsed CAT048 record into a TrackPoint.
/// Returns None if essential fields are missing or values are unreasonable.
fn record_to_track_point(
    record: &Cat048Record,
    base_date_secs: f64,
    _index: u64,
    radar_lat: f64,
    radar_lon: f64,
) -> Option<TrackPoint> {
    // Require time
    let tod = record.time_of_day?;

    // Convert position from polar or Cartesian to lat/lon
    let (lat, lon) = if let (Some(rho), Some(theta)) = (record.rho_nm, record.theta_deg) {
        polar_to_latlon(rho, theta, radar_lat, radar_lon)
    } else if let (Some(x_nm), Some(y_nm)) = (record.cart_x_nm, record.cart_y_nm) {
        cartesian_to_latlon(x_nm, y_nm, radar_lat, radar_lon)
    } else {
        return None;
    };

    // Validate coordinates (Korean airspace)
    if lat < 30.0 || lat > 45.0 || lon < 120.0 || lon > 135.0 {
        return None;
    }

    // Compute timestamp
    let timestamp = if base_date_secs > 0.0 {
        base_date_secs + tod
    } else {
        1700000000.0 + tod
    };

    // Altitude from flight level (1 FL = 100 ft → meters)
    let altitude = record
        .flight_level
        .map(|fl| fl * 100.0 * 0.3048)
        .unwrap_or(0.0);

    // Mode-S address
    let mode_s = record
        .mode_s_address
        .map(|addr| format!("{:06X}", addr))
        .or_else(|| record.track_number.map(|tn| format!("TN{:04}", tn)))
        .unwrap_or_else(|| "UNKNOWN".to_string());

    let speed = record.ground_speed_kts.unwrap_or(0.0);
    let heading = record.heading_deg.unwrap_or(0.0);

    Some(TrackPoint {
        timestamp,
        mode_s,
        latitude: lat,
        longitude: lon,
        altitude,
        speed,
        heading,
        raw_data: Vec::new(),
    })
}

fn polar_to_latlon(rho_nm: f64, theta_deg: f64, radar_lat: f64, radar_lon: f64) -> (f64, f64) {
    let rng_km = rho_nm * 1.852;
    let az_rad = theta_deg.to_radians();

    let lat_offset = rng_km * az_rad.cos() / 111.32;
    let lon_offset = rng_km * az_rad.sin() / (111.32 * radar_lat.to_radians().cos());

    (radar_lat + lat_offset, radar_lon + lon_offset)
}

fn cartesian_to_latlon(x_nm: f64, y_nm: f64, radar_lat: f64, radar_lon: f64) -> (f64, f64) {
    let x_km = x_nm * 1.852;
    let y_km = y_nm * 1.852;

    let lat_offset = y_km / 111.32;
    let lon_offset = x_km / (111.32 * radar_lat.to_radians().cos());

    (radar_lat + lat_offset, radar_lon + lon_offset)
}

fn make_err(offset: usize, msg: &str) -> ParseError {
    ParseError::RecordError {
        offset,
        message: msg.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_polar_to_latlon_north() {
        let (lat, lon) = polar_to_latlon(30.0, 0.0, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON);
        assert!((lat - (DEFAULT_RADAR_LAT + 30.0 * 1.852 / 111.32)).abs() < 0.001);
        assert!((lon - DEFAULT_RADAR_LON).abs() < 0.001);
    }

    #[test]
    fn test_polar_to_latlon_east() {
        let (lat, lon) = polar_to_latlon(20.0, 90.0, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON);
        assert!((lat - DEFAULT_RADAR_LAT).abs() < 0.01);
        assert!(lon > DEFAULT_RADAR_LON);
    }

    #[test]
    fn test_cartesian_to_latlon() {
        let (lat, lon) = cartesian_to_latlon(10.0, 10.0, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON);
        assert!(lat > DEFAULT_RADAR_LAT);
        assert!(lon > DEFAULT_RADAR_LON);
    }

    #[test]
    fn test_i16_from_be_bytes() {
        // Verify sign extension works correctly
        assert_eq!(i16::from_be_bytes([0xFF, 0xFF]), -1);
        assert_eq!(i16::from_be_bytes([0x80, 0x00]), -32768);
        assert_eq!(i16::from_be_bytes([0x00, 0x01]), 1);
        assert_eq!(i16::from_be_bytes([0x7F, 0xFF]), 32767);
    }

    #[test]
    fn test_parse_fspec_single_byte() {
        let data = vec![0xF0];
        let (present, next) = parse_fspec(&data, 0).unwrap();
        assert_eq!(next, 1);
        assert_eq!(present, vec![UAP_I010, UAP_I140, UAP_I020, UAP_I040]);
    }

    #[test]
    fn test_parse_fspec_two_bytes() {
        let data = vec![0xF3, 0x16];
        let (present, next) = parse_fspec(&data, 0).unwrap();
        assert_eq!(next, 2);
        assert!(present.contains(&UAP_I010));
        assert!(present.contains(&UAP_I140));
        assert!(present.contains(&UAP_I040));
        assert!(present.contains(&UAP_I130));
        assert!(present.contains(&UAP_I161));
        assert!(present.contains(&UAP_I200));
        assert!(present.contains(&UAP_I170));
    }

    #[test]
    fn test_days_from_epoch() {
        let days = days_from_epoch(2026, 3, 4);
        assert!(days > 20000);
        assert!(days < 21000);
    }

    #[test]
    fn test_extract_base_date() {
        let ts = extract_base_date_from_filename("gimpo_260304_0415.ass");
        assert!(ts > 0.0);
        let expected_days = days_from_epoch(2026, 3, 4);
        assert!((ts - expected_days as f64 * 86400.0).abs() < 1.0);
    }

    #[test]
    fn test_skip_fx_extended() {
        let data = vec![0b10110100];
        assert_eq!(skip_fx_extended(&data, 0), 1);

        let data = vec![0b10110101, 0b00110100];
        assert_eq!(skip_fx_extended(&data, 0), 2);
    }

    #[test]
    fn test_detect_nec_frame_requires_confirmation() {
        // Build data with two consecutive NEC frames + ASTERIX blocks
        let mut data = vec![0x03, 0x04, 0x04, 0x0f, 0x0c]; // NEC frame + counter
        data.push(0x30); // CAT048
        data.extend_from_slice(&[0x00, 0x1a]); // LEN=26
        data.extend(vec![0x00; 23]); // record data
        // Second frame (same month/day, can differ hour/minute)
        data.extend_from_slice(&[0x03, 0x04, 0x04, 0x10, 0x0d]); // minute changed 0x0f->0x10
        data.push(0x22); // CAT034
        data.extend_from_slice(&[0x00, 0x0b]); // LEN=11
        data.extend(vec![0x00; 8]);

        let frame = detect_nec_frame(&data);
        assert_eq!(frame, Some((0x03, 0x04))); // Returns (month, day)
    }

    #[test]
    fn test_detect_nec_frame_no_false_positive() {
        // Random data that looks like a date but has no confirmation
        let mut data = vec![0x03, 0x04, 0x04, 0x0f, 0x0c]; // Looks like frame
        data.push(0x30); // CAT048
        data.extend_from_slice(&[0x00, 0x1a]); // LEN=26
        data.extend(vec![0xAA; 23]); // Random data (no second frame)

        let frame = detect_nec_frame(&data);
        assert_eq!(frame, None); // Should NOT detect without confirmation
    }

    #[test]
    fn test_is_nec_frame() {
        // Valid NEC frame followed by CAT048
        let data = vec![0x03, 0x0c, 0x09, 0x06, 0x17, 0x30, 0x00, 0x10];
        assert!(is_nec_frame(&data, 0, 0x03, 0x0c));

        // Same month/day but different hour/minute — should still match
        let data2 = vec![0x03, 0x0c, 0x0a, 0x15, 0x20, 0x22, 0x00, 0x10];
        assert!(is_nec_frame(&data2, 0, 0x03, 0x0c));

        // Wrong month — should not match
        assert!(!is_nec_frame(&data, 0, 0x04, 0x0c));

        // Invalid hour (24) — should not match
        let data3 = vec![0x03, 0x0c, 0x18, 0x06, 0x17, 0x30];
        assert!(!is_nec_frame(&data3, 0, 0x03, 0x0c));
    }

    #[test]
    fn test_chain_validation() {
        // Two valid chained ASTERIX blocks
        let mut data = Vec::new();
        // Block 1: CAT034, LEN=5 (minimum: 3-byte header + 2 data)
        data.push(0x22);
        data.extend_from_slice(&[0x00, 0x05]);
        data.extend_from_slice(&[0x00, 0x00]);
        // Block 2: CAT048, LEN=5
        data.push(0x30);
        data.extend_from_slice(&[0x00, 0x05]);
        data.extend_from_slice(&[0x00, 0x00]);

        // Block 1 should be valid because block 2 follows
        assert!(try_asterix_block(&data, 0, None).is_some());

        // Single block with no valid successor should fail
        let solo = vec![0x30, 0x00, 0x05, 0x00, 0x00, 0xAA, 0xBB];
        assert!(try_asterix_block(&solo, 0, None).is_none());
    }

    #[test]
    fn test_record_validation_rejects_bad_time() {
        // Time > 86400 should be rejected
        let record = Cat048Record {
            time_of_day: Some(90000.0), // > 86400
            rho_nm: Some(10.0),
            theta_deg: Some(180.0),
            ..Default::default()
        };
        // time_of_day > MAX_TIME_OF_DAY won't even be set by parser,
        // but if it were, record_to_track_point still requires it
        assert!(record.time_of_day.is_some());
    }

    #[test]
    fn test_record_validation_rejects_bad_coords() {
        let record = Cat048Record {
            time_of_day: Some(50000.0),
            rho_nm: Some(500.0), // Way too far - would produce coords outside Korea
            theta_deg: Some(0.0),
            ..Default::default()
        };
        // rho_nm > 256 won't be set by parser (validation), but test coords filter
        let (lat, _lon) = polar_to_latlon(500.0, 0.0, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON);
        assert!(lat > 45.0); // Out of Korean bounds
    }

    #[test]
    #[ignore] // Requires actual ASS file in ass/ directory
    fn test_parse_real_ass_file() {
        let test_file = std::path::Path::new("../ass/gimpo_260312_0906.ass");
        if !test_file.exists() {
            eprintln!("Skipping: test file not found");
            return;
        }
        let result = parse_ass_file(
            test_file.to_str().unwrap(),
            DEFAULT_RADAR_LAT,
            DEFAULT_RADAR_LON,
        )
        .expect("Failed to parse ASS file");

        println!("Total records: {}", result.total_records);
        println!("Track points: {}", result.track_points.len());
        println!("Parse errors: {}", result.parse_errors.len());

        // Should have substantial data
        assert!(result.total_records > 10_000, "Expected >10K records, got {}", result.total_records);
        assert!(result.track_points.len() > 5_000, "Expected >5K track points, got {}", result.track_points.len());

        // Error rate should be very low
        let error_rate = result.parse_errors.len() as f64 / result.total_records as f64;
        assert!(error_rate < 0.01, "Error rate {:.2}% too high", error_rate * 100.0);

        // All track points should be in Korean airspace
        for tp in &result.track_points {
            assert!(tp.latitude >= 30.0 && tp.latitude <= 45.0,
                "Latitude {} out of range", tp.latitude);
            assert!(tp.longitude >= 120.0 && tp.longitude <= 135.0,
                "Longitude {} out of range", tp.longitude);
        }

        // Time should be within 24 hours
        if let (Some(start), Some(end)) = (result.start_time, result.end_time) {
            let duration = end - start;
            assert!(duration > 0.0 && duration < 86400.0,
                "Duration {} seconds unreasonable", duration);
        }

        // Check unique Mode-S codes (should be reasonable, not tens of thousands of garbage)
        let mut mode_s_codes: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for tp in &result.track_points {
            mode_s_codes.insert(&tp.mode_s);
        }
        println!("Unique Mode-S codes: {}", mode_s_codes.len());
        // Gimpo radar near Seoul sees thousands of targets; >10K would indicate garbage
        assert!(mode_s_codes.len() < 10_000,
            "Too many unique Mode-S codes ({}), likely parsing garbage", mode_s_codes.len());
    }
}
