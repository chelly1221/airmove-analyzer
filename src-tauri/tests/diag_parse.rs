use airmove_analyzer_lib::parser::ass::parse_ass_file;

fn ts_to_str(ts: f64) -> String {
    // UTC date/time from unix seconds (no chrono dependency)
    let days = (ts / 86400.0).floor() as i64;
    let secs_in_day = ts - days as f64 * 86400.0;
    let h = (secs_in_day / 3600.0).floor() as i64;
    let m = ((secs_in_day - h as f64 * 3600.0) / 60.0).floor() as i64;
    // days since epoch -> y/m/d
    let mut y = 1970i64;
    let mut d = days;
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let dy = if leap { 366 } else { 365 };
        if d >= dy { d -= dy; y += 1; } else { break; }
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let mdays = [31, if leap {29} else {28}, 31,30,31,30,31,31,30,31,30,31];
    let mut mo = 0;
    while d >= mdays[mo] { d -= mdays[mo]; mo += 1; }
    format!("{:04}-{:02}-{:02} {:02}:{:02}Z", y, mo+1, d+1, h, m)
}

#[test]
fn diag() {
    let path = "C:/code/airmove-analyzer/diagdata/gimpo_260304_0415.ass";
    if !std::path::Path::new(path).exists() {
        eprintln!("skip: no file");
        return;
    }
    let parsed = parse_ass_file(path, 37.5585, 126.7908, &[], &[], &[], &[], -8.5, |_| {}).unwrap();
    let pts = &parsed.track_points;
    eprintln!("=== PARSE RESULT ===");
    eprintln!("track_points: {}", pts.len());
    if let Some(s) = &parsed.parse_stats {
        eprintln!("total_asterix_records: {}", s.total_asterix_records);
        eprintln!("discarded_psr_none: {}", s.discarded_psr_none);
        eprintln!("nec_tod_mismatch: {}", s.nec_tod_mismatch);
        eprintln!("recovered_records: {}", s.recovered_records);
        eprintln!("points_by_type [macP,macPsr,msAll,msRoll,msAllPsr,msRollPsr]: {:?}", s.points_by_type);
        eprintln!("mode3a_invalid: {}", s.mode3a_invalid);
    }
    if pts.is_empty() { eprintln!("NO POINTS"); return; }
    let first = pts.first().unwrap().timestamp;
    let last = pts.last().unwrap().timestamp;
    let mut min = f64::MAX; let mut max = f64::MIN;
    for p in pts { if p.timestamp < min { min = p.timestamp; } if p.timestamp > max { max = p.timestamp; } }
    eprintln!("first_pt ts: {}  ({})", first, ts_to_str(first));
    eprintln!("last_pt  ts: {}  ({})", last, ts_to_str(last));
    eprintln!("min ts: {}  ({})", min, ts_to_str(min));
    eprintln!("max ts: {}  ({})", max, ts_to_str(max));
    eprintln!("span (max-min) hours: {:.2}", (max-min)/3600.0);

    // Histogram by UTC day
    use std::collections::BTreeMap;
    let mut by_day: BTreeMap<i64, usize> = BTreeMap::new();
    for p in pts {
        let day = (p.timestamp / 86400.0).floor() as i64;
        *by_day.entry(day).or_insert(0) += 1;
    }
    eprintln!("--- points per UTC day ---");
    for (day, cnt) in &by_day {
        eprintln!("  day {} ({}): {}", day, ts_to_str(*day as f64 * 86400.0), cnt);
    }
    // distinct mode_s count
    use std::collections::HashSet;
    let mut ms: HashSet<&str> = HashSet::new();
    for p in pts { ms.insert(p.mode_s.as_str()); }
    eprintln!("distinct mode_s (flights): {}", ms.len());
}
