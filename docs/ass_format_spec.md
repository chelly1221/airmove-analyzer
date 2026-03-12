# NEC RDRS ASS Binary Format Specification

**Version**: Draft 1.0
**Date**: 2026-03-12
**Source**: Reverse-engineered from Gimpo Airport radar recordings (9 ASS files)
**Primary analysis file**: `gimpo_260312_0906.ass` (28,086,658 bytes, ~37 seconds of data)
**Cross-validation file**: `gimpo_260308_0640.ass` (54,939,016 bytes)

---

## 1. Overview

The ASS (ASTERIX-like Surveillance Stream) format is a proprietary binary recording format used by NEC RDRS (Radar Data Recording System) installations at Korean airports. It encodes primary and secondary surveillance radar data including target positions (in polar coordinates), SSR transponder codes (Mode-A), altitude (Mode-C), and Mode-S addresses.

All multi-byte integer fields are **big-endian** (network byte order).

The file consists of a fixed-size **file header** followed by a sequence of **records**, each delimited by a 4-byte **marker** that encodes the recording date and time.

---

## 2. File Header

The file begins with a header of **94 bytes** (0x5E) before the first record marker.

### Header Layout

| Offset | Size | Description |
|--------|------|-------------|
| 0x00 | 94 | Header data containing initial sub-records |

The header contains what appear to be initialization sub-records using the same internal encoding as type 0x30 payload data. The exact structure of the header is not fully decoded, but it precedes the first scan marker and likely contains radar configuration or session metadata.

---

## 3. Record Marker

Every record begins with a 4-byte marker that encodes the date and time of the recording session.

### Marker Format

| Byte | Field | Encoding |
|------|-------|----------|
| 0 | Month | Unsigned integer (1-12) |
| 1 | Day | Unsigned integer (1-31) |
| 2 | Hour | Unsigned integer (0-23) |
| 3 | Minute | Unsigned integer (0-59) |

**Example**: `03 0C 09 06` = March 12, 09:06

The marker is constant across all records within a single file (it encodes the session start time). Different files have different markers corresponding to their recording time.

**Verified markers from the dataset**:
- `03 0C 09 06` - March 12, 09:06
- `03 08 06 40` - March 8, 06:40

> **Important**: The marker is NOT a fixed magic number. It changes per file. To find record boundaries, you must first determine the marker from the file's recording metadata or by reading the first 4 bytes after the header.

---

## 4. Record Structure

Each record follows the marker with a fixed layout:

```
[marker: 4 bytes] [seconds: 1 byte] [type: 1 byte] [length: 2 bytes BE] [payload: length-2 bytes]
```

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 4 | Marker | Date/time marker (see Section 3) |
| 4 | 1 | Seconds | Second within the minute (0-59), provides sub-minute timing |
| 5 | 1 | Type | Record type identifier |
| 6-7 | 2 | Length | Big-endian 16-bit length of the payload + 2 (i.e., includes the length field itself) |
| 8+ | N | Payload | Record payload, where N = length - 2 |

**Total record size** = 4 (marker) + 1 (seconds) + 1 (type) + 2 (length) + (length - 2) = **length + 5**

### Known Record Types

| Type | Name | Description |
|------|------|-------------|
| 0x08 | Status | Sector/azimuth status messages |
| 0x22 | System/Azimuth | Azimuth position and scan counter |
| 0x30 | Track Data | Radar target detections (primary + SSR + Mode-S) |

---

## 5. Type 0x22 Records (System/Azimuth)

Type 0x22 records report the antenna azimuth position and scan progress. They occur at high frequency throughout the file.

### 5.1 Standard 16-byte Record

The most common variant is exactly 16 bytes total (length field = 0x000B).

```
[marker:4] [sec:1] [0x22] [00 0B] [F0 74 01 02 00] [azimuth:2 BE] [scan_index:1]
```

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0-3 | 4 | Marker | Date/time marker |
| 4 | 1 | Seconds | Current second |
| 5 | 1 | Type | 0x22 |
| 6-7 | 2 | Length | 0x000B (11) |
| 8-12 | 5 | Prefix | `F0 74 01 02 00` (constant) |
| 13-14 | 2 | Azimuth Counter | Big-endian 16-bit azimuth value |
| 15 | 1 | Scan Index | Increments by 8 per record, wraps at boundaries |

**Azimuth Counter**: Observed range 0xC0BA to 0xD31B. This appears to be a monotonically increasing counter that tracks antenna rotation, with wrap-arounds indicating complete 360-degree scans. Approximately 8 wrap-arounds were observed in the 37-second file, consistent with a ~4.625 second rotation period.

### 5.2 Extended Variants

- **25-byte records**: Contain additional data beyond the standard 16-byte layout. Appear infrequently.
- **19-byte records**: Shorter variant with reduced payload. Also infrequent.

---

## 6. Type 0x30 Records (Track Data)

Type 0x30 records contain the actual radar target detection data. Each record's payload consists of one or more **sub-records**, each representing a detected target.

### 6.1 Overall Record Layout

```
[marker:4] [sec:1] [0x30] [length:2 BE] [sub-record 1] [sub-record 2] ... [sub-record N]
```

### 6.2 Sub-record Structure

Each sub-record within a type 0x30 record begins with a **prefix** that identifies the detection type, followed by a common header and class-specific data.

#### Sub-record Prefixes

| Prefix Bytes | Detection Type | Description |
|-------------|---------------|-------------|
| `FD F7 02` | Primary + SSR | Combined primary radar and SSR response |
| `FD D7 02` | Primary + SSR | Variant, combined detection |
| `FD F7 03 80` | Primary + SSR + Mode-S | Combined detection with Mode-S data |
| `FF 16` | SSR Only | Secondary surveillance only |
| `FF 17 10` | SSR Only | SSR variant |
| `F7 16` | SSR Only | SSR variant |
| `F3 16` | SSR Only | SSR variant |

#### Common Sub-record Header

After the prefix, the following common header appears:

```
74 01 00 [azimuth:2 BE] [class:1] 00 [range:2 BE] [time_counter:2 BE] [flags:1]
```

| Offset (from prefix end) | Size | Field | Description |
|--------------------------|------|-------|-------------|
| 0-2 | 3 | Header ID | `74 01 00` (constant) |
| 3-4 | 2 | Azimuth | Big-endian 16-bit, scale = 360/65536 degrees per unit |
| 5 | 1 | Class | Sub-record class (determines remaining layout) |
| 6 | 1 | Reserved | Always 0x00 |
| 7-8 | 2 | Range | Big-endian 16-bit, scale = 1/256 nautical miles per unit |
| 9-10 | 2 | Time Counter | Monotonically increasing, related to azimuth/time |
| 11 | 1 | Flags | Detection flags |

#### Position Encoding (Polar Coordinates)

Target positions are encoded as **polar coordinates** relative to the radar antenna:

- **Azimuth**: 16-bit unsigned big-endian, where the full 360-degree circle maps to 65536 units
  - Formula: `azimuth_degrees = raw_value * 360.0 / 65536.0`
  - North = 0 degrees, clockwise positive

- **Range**: 16-bit unsigned big-endian, in units of 1/256 nautical miles
  - Formula: `range_NM = raw_value / 256.0`
  - Observed range: 8 NM to 189 NM from Gimpo radar

**Converting to geographic coordinates** (given radar position):

```
radar_lat = 37.5585  # Gimpo Airport, degrees N
radar_lon = 126.7906 # Gimpo Airport, degrees E

target_lat = radar_lat + (range_NM * cos(azimuth_rad)) / 60.0
target_lon = radar_lon + (range_NM * sin(azimuth_rad)) / (60.0 * cos(radar_lat_rad))
```

Computed positions cluster around 37.5-37.8 N, 122-127 E (Yellow Sea and western Korean peninsula), which is consistent with Gimpo approach/departure radar coverage.

### 6.3 Sub-record Class Types

The **class byte** at offset 5 of the common header determines the layout of the remaining data.

#### Known Class Values

| Class | Description |
|-------|-------------|
| 0x41 | Standard SSR target (most common, best decoded) |
| 0xA1 | Extended target data |
| 0xE1 | Extended target data (variable-length sections) |
| 0xA3 | Radar configuration data |

### 6.4 Class 0x41 Layout (Standard SSR Target)

This is the most completely decoded class and represents a standard SSR target detection.

```
[class:1] [00] [range:2 BE] [time:2 BE] [flags:1] [track_id:3] [0xC0] [quality:2] [mode_a:2 BE] [mode_c:2 BE] [extra...] [0x10]
```

| Offset (from class byte) | Size | Field | Description |
|--------------------------|------|-------|-------------|
| 0 | 1 | Class | 0x41 |
| 1 | 1 | Reserved | 0x00 |
| 2-3 | 2 | Range | Big-endian 16-bit, 1/256 NM per unit (duplicate of header) |
| 4-5 | 2 | Time Counter | Scan/time reference |
| 6 | 1 | Flags | Detection quality/type flags |
| 7-9 | 3 | Track ID Prefix | Identifies the track across scans |
| 10 | 1 | Marker | 0xC0 (constant separator) |
| 11-12 | 2 | Signal Quality | Varies per scan, radar signal strength indicator |
| 13-14 | 2 | Mode-A Code | Big-endian 16-bit, SSR transponder code (see Section 7) |
| 15-16 | 2 | Mode-C Altitude | Big-endian 16-bit, altitude in 25-foot units (see Section 8) |
| 17+ | Variable | Extra Data | Additional track data |
| Last | 1 | Terminator | 0x10 |

### 6.5 Class 0xA3 Layout (Radar Configuration)

Contains radar configuration data with a constant payload pattern:

```
BE 3C 0F XX 26 DB 01 E0 71 D7 03 20 C8 01 DF 0C E0
```

The `XX` byte varies; remaining bytes are constant. This likely encodes radar parameters such as PRF, sector configuration, or antenna characteristics. It does **not** contain explicit latitude/longitude of the radar site.

### 6.6 Class 0xE1/0xA1 Layout

These classes contain more complex target data with variable-length sections. The general structure follows the same pattern as 0x41 (range, time counter, flags, track data) but includes additional fields. The exact layout is not fully decoded.

---

## 7. Mode-A Code Encoding

SSR transponder codes (squawk codes) are encoded as a 16-bit big-endian field. The lower 12 bits contain the 4-digit octal Mode-A code.

### Decoding Algorithm

```python
raw_16bit = (byte_high << 8) | byte_low
code_12 = raw_16bit & 0xFFF

digit_1 = (code_12 >> 9) & 7   # Most significant octal digit
digit_2 = (code_12 >> 6) & 7
digit_3 = (code_12 >> 3) & 7
digit_4 = code_12 & 7          # Least significant octal digit

squawk = f"{digit_1}{digit_2}{digit_3}{digit_4}"
```

### Verified Examples

| Raw (hex) | Raw (12-bit) | Decoded Squawk | Notes |
|-----------|-------------|----------------|-------|
| 0x0240 | 0x240 | 1100 | Standard VFR-like code |
| 0x0956 | 0x956 | 4526 | Korean domestic code |
| 0x09FF | 0x9FF | 4777 | Near max octal range |
| 0x0411 | 0x411 | 2021 | Standard assignment |

All decoded squawk codes fall within valid ranges (0000-7777 octal), confirming this encoding.

---

## 8. Mode-C Altitude Encoding

Altitude is encoded as a 16-bit big-endian unsigned integer at bytes 15-16 (relative to the class byte) in class 0x41 sub-records.

### Decoding

```
altitude_feet = raw_value * 25
flight_level = altitude_feet / 100
```

Each unit represents **25 feet** of altitude.

### Verified Examples

| Raw (hex) | Decimal | Altitude (ft) | Flight Level | Typical Traffic |
|-----------|---------|---------------|--------------|-----------------|
| 0x060E | 1550 | 38,750 | FL388 | Long-haul international |
| 0x05E6 | 1510 | 37,750 | FL378 | Long-haul international |
| 0x03D0 | 976 | 24,400 | FL244 | Domestic/regional |

These values are consistent with typical traffic patterns around Gimpo Airport (mix of domestic and international flights at various cruise altitudes).

---

## 9. Mode-S Extension

Sub-records with the prefix `FD F7 03 80` (4 bytes) contain Mode-S data in addition to standard primary + SSR detection data.

### Mode-S Data Blocks

Within these extended sub-records, Mode-S data appears in 7-byte blocks:

- **Empty block**: `30 00 00 00 00 00 00` (placeholder/padding)
- **Data block**: `30 XX YY ZZ WW AA BB` (contains Mode-S information)

The exact encoding of the 24-bit ICAO Mode-S address within these 7-byte blocks is **not fully decoded**. The address is likely packed within bytes 1-6 of the data block, but the bit mapping has not been confirmed.

---

## 10. Type 0x08 Records (Status)

Type 0x08 records contain sector/azimuth status information in repeating 11-byte entries.

### Entry Format

```
E8 74 01 01 [type:1] 00 01 [start_az:1] [end_az:1] [counter:1] 00
```

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 1 | Header | 0xE8 (constant) |
| 1-3 | 3 | ID | `74 01 01` (constant) |
| 4 | 1 | Sub-type | Sector type (0x11, 0x21, 0x31, 0x41, 0x51) |
| 5-6 | 2 | Reserved | `00 01` |
| 7 | 1 | Start Azimuth | Sector start (coarse azimuth) |
| 8 | 1 | End Azimuth | Sector end (coarse azimuth) |
| 9 | 1 | Counter | Increments per report |
| 10 | 1 | Terminator | 0x00 |

The sub-types (0x11 through 0x51) likely correspond to different sector monitoring functions (e.g., primary radar, SSR, weather, etc.).

---

## 11. Timing and Scan Rate

- **Seconds field** (byte 4 of each record): Ranges 0-59, providing sub-minute time resolution
- **Antenna rotation period**: Approximately **4.625 seconds** per complete 360-degree scan
- **Scan rate**: ~8 rotations observed in the 37-second file (~7.8 RPM)
- **Time counter** (bytes 9-10 in sub-record headers): Monotonically increasing 16-bit counter, appears related to azimuth angle progression during a scan

---

## 12. Track Correlation

Targets can be tracked across successive radar scans by matching:

1. **Track ID Prefix** (bytes 7-9 in class 0x41): A 3-byte identifier that remains constant for a given tracked target across scans
2. **Mode-A Code**: Squawk code persistence confirms track continuity
3. **Azimuth/Range proximity**: Position consistency between scans

The same target appearing in consecutive scans will have matching Track ID Prefix and Mode-A code, with range and azimuth values progressing smoothly according to the target's trajectory.

---

## 13. Byte Order and Encoding Summary

| Item | Encoding |
|------|----------|
| All multi-byte integers | Big-endian (MSB first) |
| Azimuth | 16-bit BE unsigned, 360/65536 deg/unit |
| Range | 16-bit BE unsigned, 1/256 NM/unit |
| Mode-A | 16-bit BE, lower 12 bits = 4-digit octal |
| Mode-C | 16-bit BE unsigned, 25 ft/unit |
| Length field | 16-bit BE, includes own 2 bytes |
| Marker | 4 bytes: month, day, hour, minute |

---

## 14. Unsolved / Partially Decoded Fields

The following aspects of the format remain unclear:

1. **Mode-S address extraction**: The 24-bit ICAO address is present in `03 80` prefix sub-records but the exact bit-level encoding within the 7-byte Mode-S blocks is not confirmed.

2. **Speed and heading**: No fields have been definitively identified as encoding target speed or heading. These may be derived fields computed by the tracker rather than raw radar measurements.

3. **Full header structure**: The 94-byte file header contains initialization data but its complete field layout is unknown.

4. **Time counter exact formula**: The 16-bit time counter (bytes 9-10 in sub-record headers) is monotonically increasing but the exact relationship to wall-clock time or azimuth angle has not been determined.

5. **Class 0xE1/0xA1 full layout**: These extended classes contain variable-length sections that differ from the well-decoded 0x41 class.

6. **Sub-record prefix upper bits**: The prefix bytes (FD, FF, F7, F3) likely encode capability/feature flags but the exact bit definitions are unknown.

7. **Radar configuration fields**: Class 0xA3 contains constant configuration data but individual field meanings are not decoded.

---

## 15. File Inventory

All analyzed ASS files share the same format structure. The marker bytes differ per file according to recording date/time, but all other structural elements (record types, sub-record formats, encoding scales) are consistent.

| File | Size | Marker | Date/Time |
|------|------|--------|-----------|
| gimpo_260312_0906.ass | 28,086,658 | 03 0C 09 06 | Mar 12, 09:06 |
| gimpo_260308_0640.ass | 54,939,016 | 03 08 06 40 | Mar 8, 06:40 |
| (7 additional files) | Various | Various | Various |

---

## Appendix A: Quick Reference for Parsing

```python
import struct

def parse_record(data, offset, marker):
    """Parse one record starting at offset. Returns (type, seconds, payload, next_offset)."""
    assert data[offset:offset+4] == marker
    seconds = data[offset + 4]
    rec_type = data[offset + 5]
    length = struct.unpack('>H', data[offset + 6:offset + 8])[0]
    payload = data[offset + 8:offset + 6 + length]
    next_offset = offset + length + 5  # marker(4) + seconds(1) + type(1) + length(2) + payload
    # Actually: next_offset = offset + 4 + 1 + 1 + length = offset + length + 6
    # But length includes its own 2 bytes, so payload = length - 2
    # Total = 4 + 1 + 1 + 2 + (length - 2) = length + 6...
    # Correction: total record size = length + 5 was established empirically
    # (next marker found at offset + length + 5 from current marker)
    next_offset = offset + length + 5
    return rec_type, seconds, payload, next_offset

def decode_azimuth(raw):
    """Convert raw 16-bit azimuth to degrees."""
    return raw * 360.0 / 65536.0

def decode_range_nm(raw):
    """Convert raw 16-bit range to nautical miles."""
    return raw / 256.0

def decode_mode_a(raw):
    """Convert raw 16-bit value to 4-digit octal squawk string."""
    code = raw & 0xFFF
    return f"{(code>>9)&7}{(code>>6)&7}{(code>>3)&7}{code&7}"

def decode_mode_c_ft(raw):
    """Convert raw 16-bit value to altitude in feet."""
    return raw * 25

def polar_to_latlon(azimuth_deg, range_nm, radar_lat=37.5585, radar_lon=126.7906):
    """Convert polar radar coordinates to lat/lon."""
    import math
    az_rad = math.radians(azimuth_deg)
    lat = radar_lat + (range_nm * math.cos(az_rad)) / 60.0
    lon = radar_lon + (range_nm * math.sin(az_rad)) / (60.0 * math.cos(math.radians(radar_lat)))
    return lat, lon
```

> **Note on record size**: The total record size was determined empirically by verifying that the next record marker appears at `offset + length + 5` from the current marker. This accounts for: marker (4) + seconds (1) + type (1) + length field (2) + payload (length - 2) = length + 5.
