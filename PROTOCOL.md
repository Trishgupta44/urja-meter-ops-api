# Urja Meter Ops — Portal Reverse-Engineering & Protocol Reference (`PROTOCOL.md`)

This document describes how the legacy **Urja Meter Ops** portal (`https://urja-ops.flockenergy.tech`) works under the hood, how authentication and request signing operate, every internal endpoint exposed by the portal, and the 10 data/protocol quirks discovered during inspection.

> **For the complete step-by-step Chrome DevTools MCP investigation log** (including the accessibility tree snapshot, decompiled SvelteKit bundle source code, and full 22-row anomaly & cross-tabulation tables), see **[`CHROME_DEVTOOLS_MCP_DISCOVERY.md`](./CHROME_DEVTOOLS_MCP_DISCOVERY.md)**.

---

## 1. Underlying Stack & Architecture

Inspecting the live DOM, network requests, and client bundles (`/_app/immutable/entry/app.03ZTmlg3.js` and `/_app/immutable/nodes/0..7.js`) reveals that the portal is a **SvelteKit** application backed by **Better Auth**:

| Component | Implementation Detail |
| :--- | :--- |
| **Frontend / SSR Framework** | SvelteKit (`__sveltekit_uzbk0k`), using both SvelteKit Server Load (`/__data.json` with `devalue` array serialization) and internal JSON endpoints under `/portal/*`. |
| **Route Dictionary** | `/` (redirects to `/meters`), `/login`, `/(portal)/meters`, `/(portal)/meters/[id]`, `/(portal)/transformers`. |
| **Authentication Library** | **Better Auth** (`/api/auth/*`), issuing an HTTP-only signed cookie named `__Secure-better-auth.session_token`. |

---

## 2. Authentication & Session Lifecycle

There are two ways to authenticate against the portal:

### A. Better Auth JSON Endpoint (Preferred for Programmatic Clients)
- **Request**:
  ```http
  POST /api/auth/sign-in/email HTTP/1.1
  Host: urja-ops.flockenergy.tech
  Content-Type: application/json
  Origin: https://urja-ops.flockenergy.tech

  {"email":"operator@urja.local","password":"urja-ops-2026"}
  ```
- **Response (`200 OK`)**:
  - Body: `{"redirect":false,"token":"...","user":{"name":"Ops Desk","email":"operator@urja.local","id":"QQzA9lR6zhhqtbJrU2iC0Cp3rCIEYefi",...}}`
  - Header:
    ```http
    Set-Cookie: __Secure-better-auth.session_token=<token>.<hmac_sig>; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax
    ```

### B. SvelteKit Form Action (`POST /login`)
- Submitting `application/x-www-form-urlencoded` (`email=...&password=...`) with header `x-sveltekit-action: true` returns `{"type":"redirect","status":303,"location":"/meters"}` and sets the same `__Secure-better-auth.session_token` cookie.

### Session Inspection & Expiry Quirks
- **1-Hour Hard TTL (`Max-Age=3600`)**: Sessions expire 60 minutes after creation.
- **Unauthenticated Behavior Differs by Route Type**:
  - `/portal/*` JSON endpoints return `401 Unauthorized`:
    ```json
    {"error": "unauthorized", "message": "A valid session is required."}
    ```
  - SvelteKit `/__data.json` endpoints return `200 OK` with a JSON redirect instruction:
    ```json
    {"type": "redirect", "location": "/login"}
    ```
- **Session Verification**: `GET /api/auth/get-session` returns the active session metadata (`expiresAt`, `token`, `userId`) and user profile.
- **Sign Out**: `POST /api/auth/sign-out` invalidates the session.

---

## 3. Complete Portal Endpoint Inventory

All `/portal/*` endpoints require the `__Secure-better-auth.session_token` cookie.

### 3.1. Paginated Meter Search (`GET /portal/meters/search`)
- **URL**: `GET /portal/meters/search?q=<encoded_query>&page=<1..21>`
- **Behavior**: Returns 20 meters per page (`total: 403`, 21 pages). Matches `q` against `meterId` or `serialNo`.
- **Response Schema**:
  ```json
  {
    "data": [
      {
        "meterId": "J100000",
        "serialNo": "SE33962",
        "make": "HPL",
        "phaseType": "single",
        "installStatus": "Decommissioned",
        "dtCode": "DT-001"
      }
    ],
    "total": 403
  }
  ```
- **Limitation**: Omits `installType`, `build`, `hierarchy`, and `geo`.

### 3.2. Distribution Transformers (`GET /portal/dts`)
- **URL**: `GET /portal/dts?page=<1..2>`
- **Behavior**: Returns 20 Distribution Transformers per page (`total: 40`, `pageSize: 20` across 2 pages: `DT-001` through `DT-040`).
- **Response Schema**:
  ```json
  {
    "data": [
      {
        "code": "DT-001",
        "name": "Malviya Nagar DT 1",
        "feederCode": "F-001",
        "capacityKva": 100
      }
    ],
    "total": 40,
    "page": 1,
    "pageSize": 20
  }
  ```

### 3.3. Signing Key Retrieval (`GET /portal/keys`) & Bulk Export (`GET /portal/export`)
Inspecting the `/transformers` bundle (`/_app/immutable/nodes/4.2Bgc2kUI.js`) reveals how the **"Export all meters"** button works:

1. **Fetch Signing Secret**:
   ```http
   GET /portal/keys
   ```
   Returns:
   ```json
   {
     "data": {
       "signingSecret": "I3dZPPf5CgTp7JyGNMI8i6z8LFR7TmSR"
     }
   }
   ```
2. **Compute HMAC-SHA256 Signature**:
   - Construct the newline-delimited canonical string:
     ```text
     GET
     /portal/export
     page=1
     <unix_timestamp_in_seconds>
     ```
   - Compute `HMAC-SHA256(signingSecret, canonicalString)` as a lowercase hex string.
   - Send request with headers:
     - `x-timestamp: <unix_timestamp_in_seconds>`
     - `x-signature: <hex_hmac_sha256>`
   - **Timestamp Freshness Window**: Missing headers, bad signatures, or timestamps older than ~5 minutes fail with `401 {"error":"signature_invalid","message":"Missing or invalid request signature."}`.

3. **Bulk Response (`GET /portal/export?page=1`)**:
   - Despite taking a `page=1` query parameter (and even if called with `page=2` or no query string), **`/portal/export` returns all 403 meters in a single response** (`data.length === 403`, `total === 403`), enriched with fields not exposed in `/portal/meters/search`:
     ```json
     {
       "meterId": "J100000",
       "serialNo": "SE33962",
       "make": "HPL",
       "phaseType": "single",
       "installStatus": "Decommissioned",
       "installType": "Whole Current",
       "build": "legacy",
       "dtCode": "DT-001",
       "hierarchy": {
         "zone": { "name": "Jaipur Zone 1", "code": "Z-01" },
         "circle": { "name": "Circle 1", "code": "C-01" },
         "division": { "name": "Division 1", "code": "D-01" },
         "subdivision": { "name": "Subdivision 1", "code": "SD-01" },
         "substation": { "name": "Substation 1", "code": "SS-01" },
         "feeder": { "name": "Feeder 1", "code": "F-001" },
         "dt": { "name": "Malviya Nagar DT 1", "code": "DT-001" }
       },
       "geo": {
         "lat": 26.938961002479868,
         "lng": 75.83095696146852
       }
     }
     ```

### 3.4. Meter Detail SSR Load (`GET /meters/:id/__data.json`)
When viewing `/meters/:id`, SvelteKit loads `nodes[2].data` on the server. Inspecting `/_app/immutable/nodes/6.l777LXKL.js` reveals that `data.detail` comes in **two completely different formats** depending on whether the meter's `build` is `"legacy"` (238 meters) or `"v2"` (165 meters):
- **`build: "legacy"` (e.g., `J100000`)**:
  ```json
  {
    "data": [
      { "parameterName": "Meter ID", "parameterValue": "J100000" },
      { "parameterName": "Serial No", "parameterValue": "SE33962" },
      { "parameterName": "Make", "parameterValue": "HPL" },
      { "parameterName": "Phase Type", "parameterValue": "single" },
      { "parameterName": "Installation Status", "parameterValue": "Decommissioned" },
      { "parameterName": "Installation Type", "parameterValue": "Whole Current" }
    ]
  }
  ```
- **`build: "v2"` (e.g., `J100004`)**:
  ```json
  {
    "classData": "{\"installed_meter\":{\"MeterId\":\"J100004\",\"SerialNo\":\"SE65293\",\"Make\":\"Genus\",\"PhaseType\":\"single\",\"InstallationStatus\":\"Faulty\",\"InstallationType\":\"CT Operated\"}}"
  }
  ```

### 3.5. Meter Geolocation (`GET /portal/meters/:id/geo`)
- **URL**: `GET /portal/meters/:id/geo`
- **Response**: Returns coordinates as **strings** (`latitude`, `longitude`), in contrast to `/portal/export` which returns numbers (`lat`, `lng`):
  ```json
  {
    "data": {
      "latitude": "26.938961002479868",
      "longitude": "75.83095696146852"
    }
  }
  ```
- Returns `404 {"error":"not_found","message":"Meter not found"}` for unknown meter IDs.

### 3.6. Meter Energy Consumption (`GET /portal/meters/:id/energy`)
- **URL**: `GET /portal/meters/:id/energy` (supports hidden query params `?from=YYYY-MM-DD&to=YYYY-MM-DD`)
- **Default Window vs. Full Historical Dataset**:
  - Calling `/portal/meters/:id/energy` with **no query parameters** returns only the **7-day window from `23/06/2026` to `30/06/2026`**.
  - Passing **`?from=2026-06-01&to=2026-06-30`** unlocks the **entire 30-day month of June 2026** (`01/06/2026 00:00` to `30/06/2026 23:30`)!
- **Response Schema**:
  ```json
  {
    "data": [
      {
        "timestamp": "23/06/2026 23:30",
        "kwh": "48438.74",
        "kvah": "52313.84",
        "voltR": "226"
      }
    ]
  }
  ```

---

## 4. Catalog of Quirks, Bugs & Data Anomalies Discovered

### Quirk 1: Mixed Telemetry Resolution (`30m` vs. `daily`)
- **Meters `J100000`–`J100039` (40 meters)**: Report at **30-minute intervals** (`337` readings in the default 7-day window; `1,440` readings across June 2026).
- **Meters `J100040`–`J100402` (363 meters)**: Report at **daily (`00:00`) intervals** (`8` readings in the default 7-day window; `30` readings across June 2026).

### Quirk 2: Corrupted Duplicate Trailing Readings on 5 Meters
Five meters (`J100089`, `J100134`, `J100195`, `J100211`, `J100330`) return **9 rows instead of 8** in the default window (and 31 instead of 30 in the full month). Their final row is a duplicate `30/06/2026 00:00` timestamp where `kwh` and `voltR` are empty strings (`""`):
```json
[
  { "timestamp": "30/06/2026 00:00", "kwh": "12732.34", "kvah": "13750.93", "voltR": "229" },
  { "timestamp": "30/06/2026 00:00", "kwh": "",         "kvah": "13750.93", "voltR": "" }
]
```
Any naive parser converting `""` to `0` (`Number("") === 0`) will falsely compute a massive negative consumption drop (`-12,732.34 kWh`) and a `0V` blackout on June 30! Our normalizer detects and filters these corrupted rows while recording them in `data.anomalies`.

### Quirk 3: 22 Incomplete Hierarchy Nodes (Missing `code` or `name`)
Across the 403 meters, **22 hierarchy nodes** have either an empty `code: ""` or an empty `name: ""`:
- **14 Missing Codes (`code: ""`)**:
  - `circle` missing code: `J100011` (`Circle 6`), `J100074` (`Circle 5`), `J100097` (`Circle 6`), `J100116` (`Circle 1`), `J100170` (`Circle 5`), `J100265` (`Circle 2`)
  - `substation` missing code: `J100153` (`Substation 16`), `J100228` (`Substation 11`), `J100302` (`Substation 5`)
  - `feeder` missing code: `J100044` (`Feeder 5`), `J100078` (`Feeder 11`), `J100134` (`Feeder 15`), `J100210` (`Feeder 11`), `J100268` (`Feeder 1`)
- **8 Missing Names (`name: ""`)**:
  - `circle` missing name: `J100218` (`C-01`), `J100248` (`C-03`), `J100306` (`C-03`), `J100370` (`C-05`), `J100371` (`C-06`)
  - `feeder` missing name: `J100162` (`F-003`), `J100257` (`F-018`), `J100372` (`F-013`)

Because every code (`C-01..C-06`, `SS-01..SS-18`, `F-001..F-028`) maps 1-to-1 to a single canonical name across the remaining meters, our normalizer automatically heals all 22 records.

### Quirk 4: Conflicting Transformer Name & `GN` Serial Prefix on `J100400`–`J100402`
The final 3 meters on Page 21 (`J100400`, `J100401`, `J100402`) appear to have been appended from a separate batch:
1. **Conflicting DT Name**: They reference `dtCode: "DT-007"`, but their `hierarchy.dt.name` is `"Old Malviya Nagar Xfmr"`, whereas `/portal/dts` and the other 10 meters on `DT-007` name it `"Sanganer DT 7"`.
2. **Non-Standard Serial Prefix (`GN`)**: Their serial numbers are `GN31592`, `GN61501`, and `GN11062` (using `GN` for `Genus`), whereas the rest of the dataset uses `GE` (`78` meters).

### Quirk 5: Network Hierarchy Modulo Topology (Tree by Path, DAG by Code)
Each of the 40 Distribution Transformers (`DT-001`–`DT-040`) has a single, deterministic 7-level hierarchy path (`Zone › Circle › Division › Subdivision › Substation › Feeder › DT`). However, the portal's seed script assigned upstream levels to DT index `i` (`0..39`) using modulo arithmetic:
- `Zone`: `i % 3 + 1` (3 Zones: `Z-01..Z-03`)
- `Circle`: `i % 6 + 1` (6 Circles: `C-01..C-06` — since 6 is a multiple of 3, every Circle has 1 Zone parent)
- `Division`: `i % 10 + 1` (10 Divisions: `D-01..D-10` — **10 is not a multiple of 6**, so `D-01` appears under `C-01`, `C-03`, and `C-05`!)
- `Subdivision`: `i % 14 + 1` (14 Subdivisions: `SD-01..SD-14`)
- `Substation`: `i % 18 + 1` (18 Substations: `SS-01..SS-18`)
- `Feeder`: `i % 28 + 1` (28 Feeders: `F-001..F-028`)

Consequently, if you key nodes solely by `code` (e.g. `D-01`), 54 intermediate nodes have multiple parent codes (forming a Directed Acyclic Graph). If you key nodes by their full path (or anchor at the DT level), it forms a strict tree. Our `/api/v1/hierarchy` endpoint exposes both representations and documents all 54 multi-parent nodes.

### Quirk 6: Serial Prefix vs. Manufacturer (`make`) Mismatch (323 of 403 Meters)
For meters `J100000`–`J100399`, the 2-letter serial prefix (`SE`, `GE`, `AL`, `L&`, `HP`) was generated independently of the `make` column (`Secure`, `Genus`, `Allied`, `L&T`, `HPL`), matching only 77/400 times (19.25% ≈ random 1/5 chance). Only `J100400`–`J100402` (`GN` / `Genus`) are intentionally aligned.

### Quirk 7: Literal Ampersand (`&`) in 77 `L&` Serial Numbers
77 meters have serial numbers prefixed with `L&` (e.g. `L&84997` on `J100003`). Calling `/portal/meters/search?q=L&84997` without `encodeURIComponent` causes the server to parse `q=L` and `&84997=`, returning 167 meters matching `"L"` instead of the single meter `J100003`.

### Quirk 8: Upstream Rate Limiting (`HTTP 429`)
Firing more than ~110 requests within a 60-second window triggers `HTTP 429 Too Many Requests`. By bootstrapping the entire 403-meter inventory + geo + hierarchy via a **single** signed `/portal/export?page=1` request (plus 2 `/portal/dts` pages), our service reduces startup load from 800+ requests to **3 requests**!

---

## 5. Complete Dataset Anomaly Reference Tables

### 5.1. All 22 Incomplete Hierarchy Nodes (`code: ""` or `name: ""`)

| # | Meter ID | DT Code | Hierarchy Level | Raw Portal Node | Healed Node | Anomaly Category |
| :- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `J100011` | `DT-012` | `circle` | `{ code: "", name: "Circle 6" }` | `{ code: "C-06", name: "Circle 6" }` | `missing_hierarchy_code` |
| 2 | `J100044` | `DT-005` | `feeder` | `{ code: "", name: "Feeder 5" }` | `{ code: "F-005", name: "Feeder 5" }` | `missing_hierarchy_code` |
| 3 | `J100074` | `DT-035` | `circle` | `{ code: "", name: "Circle 5" }` | `{ code: "C-05", name: "Circle 5" }` | `missing_hierarchy_code` |
| 4 | `J100078` | `DT-039` | `feeder` | `{ code: "", name: "Feeder 11" }` | `{ code: "F-011", name: "Feeder 11" }` | `missing_hierarchy_code` |
| 5 | `J100097` | `DT-018` | `circle` | `{ code: "", name: "Circle 6" }` | `{ code: "C-06", name: "Circle 6" }` | `missing_hierarchy_code` |
| 6 | `J100116` | `DT-037` | `circle` | `{ code: "", name: "Circle 1" }` | `{ code: "C-01", name: "Circle 1" }` | `missing_hierarchy_code` |
| 7 | `J100134` | `DT-015` | `feeder` | `{ code: "", name: "Feeder 15" }` | `{ code: "F-015", name: "Feeder 15" }` | `missing_hierarchy_code` |
| 8 | `J100153` | `DT-034` | `substation` | `{ code: "", name: "Substation 16" }` | `{ code: "SS-16", name: "Substation 16" }` | `missing_hierarchy_code` |
| 9 | `J100162` | `DT-003` | `feeder` | `{ code: "F-003", name: "" }` | `{ code: "F-003", name: "Feeder 3" }` | `missing_hierarchy_name` |
| 10 | `J100170` | `DT-011` | `circle` | `{ code: "", name: "Circle 5" }` | `{ code: "C-05", name: "Circle 5" }` | `missing_hierarchy_code` |
| 11 | `J100210` | `DT-011` | `feeder` | `{ code: "", name: "Feeder 11" }` | `{ code: "F-011", name: "Feeder 11" }` | `missing_hierarchy_code` |
| 12 | `J100218` | `DT-019` | `circle` | `{ code: "C-01", name: "" }` | `{ code: "C-01", name: "Circle 1" }` | `missing_hierarchy_name` |
| 13 | `J100228` | `DT-029` | `substation` | `{ code: "", name: "Substation 11" }` | `{ code: "SS-11", name: "Substation 11" }` | `missing_hierarchy_code` |
| 14 | `J100248` | `DT-009` | `circle` | `{ code: "C-03", name: "" }` | `{ code: "C-03", name: "Circle 3" }` | `missing_hierarchy_name` |
| 15 | `J100257` | `DT-018` | `feeder` | `{ code: "F-018", name: "" }` | `{ code: "F-018", name: "Feeder 18" }` | `missing_hierarchy_name` |
| 16 | `J100265` | `DT-026` | `circle` | `{ code: "", name: "Circle 2" }` | `{ code: "C-02", name: "Circle 2" }` | `missing_hierarchy_code` |
| 17 | `J100268` | `DT-029` | `feeder` | `{ code: "", name: "Feeder 1" }` | `{ code: "F-001", name: "Feeder 1" }` | `missing_hierarchy_code` |
| 18 | `J100302` | `DT-023` | `substation` | `{ code: "", name: "Substation 5" }` | `{ code: "SS-05", name: "Substation 5" }` | `missing_hierarchy_code` |
| 19 | `J100306` | `DT-027` | `circle` | `{ code: "C-03", name: "" }` | `{ code: "C-03", name: "Circle 3" }` | `missing_hierarchy_name` |
| 20 | `J100370` | `DT-011` | `circle` | `{ code: "C-05", name: "" }` | `{ code: "C-05", name: "Circle 5" }` | `missing_hierarchy_name` |
| 21 | `J100371` | `DT-012` | `circle` | `{ code: "C-06", name: "" }` | `{ code: "C-06", name: "Circle 6" }` | `missing_hierarchy_name` |
| 22 | `J100372` | `DT-013` | `feeder` | `{ code: "F-013", name: "" }` | `{ code: "F-013", name: "Feeder 13" }` | `missing_hierarchy_name` |

### 5.2. All 5 Meters with Corrupted Duplicate `30/06/2026 00:00` Telemetry Rows

| Meter ID | Last Valid Row (`30/06/2026 00:00`) | Appended Corrupted Row (`30/06/2026 00:00`) |
| :--- | :--- | :--- |
| `J100089` | `{ kwh: "12732.34", kvah: "13750.93", voltR: "229" }` | `{ kwh: "", kvah: "13750.93", voltR: "" }` |
| `J100134` | `{ kwh: "46417.94", kvah: "50131.38", voltR: "235" }` | `{ kwh: "", kvah: "50131.38", voltR: "" }` |
| `J100195` | `{ kwh: "24530.81", kvah: "26493.27", voltR: "228" }` | `{ kwh: "", kvah: "26493.27", voltR: "" }` |
| `J100211` | `{ kwh: "21802.96", kvah: "23547.20", voltR: "231" }` | `{ kwh: "", kvah: "23547.20", voltR: "" }` |
| `J100330` | `{ kwh: "18120.95", kvah: "19570.63", voltR: "224" }` | `{ kwh: "", kvah: "19570.63", voltR: "" }` |

### 5.3. Serial Prefix vs. Manufacturer (`make`) Matrix Across All 403 Meters

| Serial Prefix | Expected Make | `HPL` | `L&T` | `Genus` | `Allied` | `Secure` | Total | Matches Expected Make |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`SE`** | `Secure` | 21 | 11 | 22 | 11 | **15** | 80 | 15 / 80 (18.8%) |
| **`GE`** | `Genus` | 14 | 14 | **15** | 22 | 13 | 78 | 15 / 78 (19.2%) |
| **`AL`** | `Allied` | 25 | 8 | 19 | **16** | 22 | 90 | 16 / 90 (17.8%) |
| **`L&`** | `L&T` | 17 | **18** | 11 | 9 | 22 | 77 | 18 / 77 (23.4%) |
| **`HP`** | `HPL` | **13** | 13 | 18 | 18 | 13 | 75 | 13 / 75 (17.3%) |
| **`GN`** | `Genus` | 0 | 0 | **3** | 0 | 0 | 3 | 3 / 3 (100.0%) |
| **Total** | — | **90** | **64** | **88** | **76** | **85** | **403** | **80 / 403 (19.9%)** |
