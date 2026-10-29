# Complete Chrome DevTools MCP Investigation & Reverse-Engineering Log (`CHROME_DEVTOOLS_MCP_DISCOVERY.md`)

This document is a comprehensive technical record of everything we discovered by attaching **Chrome DevTools MCP (`chrome-devtools-mcp --autoConnect`)** directly to the live Chrome browser session (`pageId: 18` — `https://urja-ops.flockenergy.tech/meters`), how we extracted the SvelteKit client bundles from inside the browser tab, and how every finding directly informed the architecture of `FLOCK-PROJECT`.

---

## 1. How We Connected Chrome DevTools MCP to the Live Browser

1. **Detected Chrome's Active Debugging Socket**:
   - Located `C:\Users\trish\AppData\Local\Google\Chrome\User Data\DevToolsActivePort`, which exposed port `9222` and WebSocket target `/devtools/browser/c88b3015-b979-410f-a39a-8a6c25c46076`.
2. **Configured `chrome-devtools-mcp`**:
   - Configured `~/.gemini/config/mcp_config.json` with `npx chrome-devtools-mcp@latest --autoConnect`.
3. **Enumerated Open Browser Tabs (`list_pages`)**:
   - Identified **Page 18**: `Meters (https://urja-ops.flockenergy.tech/meters)` and **Page 26**: `Flock Energy — Engineering Take-Home (Flock Energy — Software Assignment.pdf)`.

---

## 2. Step-by-Step Discovery via Chrome DevTools MCP Tools

### Step 2.1: Accessibility Tree & Full DOM Snapshot (`take_snapshot` on `pageId: 18`)

Calling `take_snapshot` on `pageId: 18` extracted the complete rendered accessibility tree (`uid=1_0` to `uid=1_165`), including elements scrolled outside the visual viewport:

- **Top Banner (`uid=1_1` to `uid=1_10`)**:
  - Brand link: `Urja Meter Ops` → `https://urja-ops.flockenergy.tech/meters`
  - Primary navigation (`uid=1_4`):
    - `Meters` → `/meters`
    - `Transformers` → `/transformers`
  - Authenticated session indicator (`uid=1_9`): `"Ops Desk"` alongside `button "Sign out"` (`uid=1_10`).
- **Main Content (`uid=1_11` to `uid=1_163`)**:
  - Heading `Meters` (`level="1"`) and count indicator `"403 total"` (`uid=1_13`).
  - Search input (`uid=1_14`): `textbox "Search by meter number or serial…"` (note the single-character Unicode ellipsis `\u2026`).
  - 6 Table Columns (`uid=1_15` to `uid=1_20`): `METER`, `SERIAL`, `MAKE`, `PHASE`, `STATUS`, `DT`.
  - 20 Meter Rows (`J100000` through `J100019`), each linking to `/meters/J1000XX` and mapped to `DT-001` through `DT-020`.
  - Pagination Controls (`uid=1_161` to `uid=1_163`): `button "Previous" (disabled)`, `"Page 1 of 21"`, `button "Next"`.
- **Hidden SvelteKit Live Announcer (`uid=1_164`)**:
  - `generic atomic live="assertive" relevant="additions text"` containing `"Meters"` (`#svelte-announcer`), our first hint that the frontend was built with **SvelteKit**.

---

### Step 2.2: Runtime Framework & Network Resource Inspection (`evaluate_script`)

Running `performance.getEntriesByType('resource')` and inspecting `<script>` tags inside `pageId: 18` revealed the exact frontend framework, bundle URLs, and background `fetch` calls:

1. **SvelteKit Bootstrap Inline Script**:
   ```javascript
   __sveltekit_uzbk0k = {
     base: new URL(".", location).pathname.slice(0, -1)
   };
   ```
2. **Loaded Immutable Client Bundles**:
   - `/_app/immutable/entry/start.Dtb6sIWb.js`
   - `/_app/immutable/entry/app.03ZTmlg3.js`
   - `/_app/immutable/assets/0.DIzN94bk.css`
   - `/_app/immutable/nodes/0.ongRscep.js` (Root layout)
   - `/_app/immutable/nodes/1.CS2K2QAf.js` (Error boundary page)
   - `/_app/immutable/nodes/2.dJQ2wm_1.js` (`/(portal)` authenticated layout)
   - `/_app/immutable/nodes/4.2Bgc2kUI.js` (`/(portal)/transformers` page)
   - `/_app/immutable/nodes/5.C4dYcCRt.js` (`/(portal)/meters` page)
   - `/_app/immutable/nodes/6.l777LXKL.js` (`/(portal)/meters/[id]` detail page)
   - `/_app/immutable/nodes/7.OkXSQ8CK.js` (`/login` page)
3. **Captured `fetch` Traffic in the Performance Buffer**:
   - `https://urja-ops.flockenergy.tech/login`
   - `https://urja-ops.flockenergy.tech/meters/__data.json?x-sveltekit-invalidated=010`
   - `https://urja-ops.flockenergy.tech/portal/meters/search?q=&page=1` (and `page=2`, `page=3`)
   - `https://urja-ops.flockenergy.tech/portal/dts?page=1` (and `page=2`)

---

## 3. Deconstructing Every SvelteKit Client Bundle (`fetch` via `evaluate_script`)

By fetching `/_app/immutable/entry/app.03ZTmlg3.js` and all node scripts (`2`, `4`, `5`, `6`, `7`) inside the browser tab, we uncovered the complete client-side source code of the portal.

### 3.1. Route Dictionary (`/_app/immutable/entry/app.03ZTmlg3.js`)
```javascript
F = [2]; // Node 2 (/(portal)/+layout.server.js) runs a server load
I = {
  "/": [-4],                       // Redirects to /meters
  "/login": [-8],                  // Node 7 (+page.server.js form action)
  "/(portal)/meters": [5, [2]],    // Node 5 inside Layout 2
  "/(portal)/meters/[id]": [-7, [2]], // Node 6 (+page.server.js load) inside Layout 2
  "/(portal)/transformers": [4, [2]]  // Node 4 inside Layout 2
};
```
*(In SvelteKit's route dictionary, negative node numbers `~n` indicate a route backed by a `+page.server.js` load/action, while positive numbers are pure client-side loads.)*

---

### 3.2. Layout & Auth Sign-Out (`/_app/immutable/nodes/2.dJQ2wm_1.js`)
Decompiled from `2.dJQ2wm_1.js`:
```javascript
async function signOut() {
  await fetch(`/api/auth/sign-out`, { method: `POST` });
  location.href = `/login`;
}
```
- **What this revealed**: The portal uses **Better Auth** mounted at `/api/auth/*`!
- Probing `/api/auth/sign-in/email` and `/api/auth/get-session` confirmed that Better Auth is the auth provider, issuing the cookie:
  ```http
  __Secure-better-auth.session_token=<token>.<hmac>; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax
  ```

---

### 3.3. The Hidden Signed Bulk Export on `/transformers` (`/_app/immutable/nodes/4.2Bgc2kUI.js`)
Decompiled directly from `4.2Bgc2kUI.js`:
```javascript
// HMAC-SHA256 Request Signer
async function C(method, path, query, secret) {
  let i = String(Math.floor(Date.now() / 1e3)),
      a = [method, path, query, i].join(`\n`),
      o = await crypto.subtle.importKey(
        `raw`,
        new TextEncoder().encode(secret),
        { name: `HMAC`, hash: `SHA-256` },
        false,
        [`sign`]
      ),
      s = await crypto.subtle.sign(`HMAC`, o, new TextEncoder().encode(a));
  return {
    timestamp: i,
    signature: [...new Uint8Array(s)].map(e => e.toString(16).padStart(2, `0`)).join(``)
  };
}

// "Export all meters" button click handler
async function F() {
  let secret = (await (await fetch(`/portal/keys`)).json()).data.signingSecret;
  let query = `page=1`;
  let { timestamp, signature } = await C(`GET`, `/portal/export`, query, secret);
  let res = await fetch(`/portal/export?${query}`, {
    headers: { "x-timestamp": timestamp, "x-signature": signature }
  });
  let body = await res.json();
  // Downloads body.data as meter-export.json
}
```
- **Why this was the single biggest discovery in the assessment**:
  1. The take-home prompt hints: *"The full dataset. There may be more than one way to get data out of the portal. If a bulk path exists, using it well is a nice touch."*
  2. Calling `GET /portal/keys` returns `{"data": {"signingSecret": "I3dZPPf5CgTp7JyGNMI8i6z8LFR7TmSR"}}`.
  3. Signing `GET\n/portal/export\npage=1\n<unix_seconds>` with HMAC-SHA256 and passing `x-timestamp` and `x-signature` headers returns **all 403 meters in a single HTTP response** (`total: 403`, `data.length: 403`).
  4. Even better, `/portal/export` includes four critical fields that `/portal/meters/search` strips out:
     - `installType`: `"Whole Current"` | `"CT Operated"`
     - `build`: `"legacy"` | `"v2"`
     - `hierarchy`: Full 7-level object (`zone`, `circle`, `division`, `subdivision`, `substation`, `feeder`, `dt` with `{ name, code }`)
     - `geo`: Numeric `{ lat, lng }` coordinates for every meter!

---

### 3.4. Meters Search & Pagination (`/_app/immutable/nodes/5.C4dYcCRt.js`)
Decompiled from `5.C4dYcCRt.js`:
```javascript
async function I() {
  let e = await (
    await fetch(`/portal/meters/search?q=${encodeURIComponent(u(k))}&page=${u(A)}`)
  ).json();
  // Sets rows = e.data, total = e.total (20 per page, 250ms input debounce)
}
```
- **What we tested & verified**:
  - 77 meters have serial numbers beginning with `L&` (e.g., `L&84997` on `J100003`).
  - Calling `/portal/meters/search?q=L&84997&page=1` without `encodeURIComponent` causes the server to parse `q=L` and `&84997=`, returning **167 meters** matching `"L"` (`J100002` first) instead of the 1 matching meter (`J100003`).

---

### 3.5. Meter Detail Page: Dual Schema & Telemetry (`/_app/immutable/nodes/6.l777LXKL.js`)
Decompiled from `6.l777LXKL.js`:
```javascript
// Client-side mount hook fetching Geo and Energy in parallel:
_(async () => {
  let [e, t] = await Promise.all([
    fetch(`/portal/meters/${N.data.meterId}/geo`),
    fetch(`/portal/meters/${N.data.meterId}/energy`)
  ]);
  e.ok && S(P, (await e.json()).data, true);
  t.ok && S(F, (await t.json()).data, true);
});

// Nameplate parser R(e) handling TWO different SSR schemas:
function R(e) {
  if (`classData` in e) {
    try {
      let t = JSON.parse(e.classData).installed_meter ?? {};
      return Object.entries(t).map(([e, t]) => ({ label: e, value: String(t) }));
    } catch {
      return [];
    }
  }
  return e.data.map(e => ({ label: e.parameterName, value: e.parameterValue }));
}

// Hierarchy breadcrumb builder:
B = l(() =>
  [`Zone`, `Circle`, `Division`, `Subdivision`, `Sub Station`, `Feeder`, `DT`]
    .map(e => N.data.hierarchy[e])
    .filter(e => !!(e && e.length > 0))
);
```
- **What this revealed**:
  1. **Two Incompatible SSR Nameplate Formats (`legacy` vs. `v2`)**:
     - Across the 403 meters, **238 are `build: "legacy"`** (returning `{ data: [{ parameterName, parameterValue }, ...] }` on `/meters/:id/__data.json`) and **165 are `build: "v2"`** (returning `{ classData: "{\"installed_meter\":{\"MeterId\":...}}" }`).
  2. **Empty State Hint (`"No readings in the default window."`)**:
     - The empty-state template in `6.l777LXKL.js` explicitly says: `<p class="text-sm text-slate-400">No readings in the default window.</p>`.
     - That wording (`"in the default window"`) clued us in to probe query parameters on `/portal/meters/:id/energy`!
     - Testing `?from=2026-06-01&to=2026-06-30` revealed that while the default unparameterized call only returns the last 7 days of June 2026 (`23/06/2026`–`30/06/2026`), passing `from` and `to` unlocks the **entire 30-day month of June 2026** (`1,440` half-hourly readings for `J100000`–`J100039`, and `30` daily readings for `J100040`–`J100402`)!

---

## 4. Complete Statistical & Anomaly Audit of the 403-Meter Dataset

Using the signed `/portal/export?page=1` and `/portal/dts?page=1..2` endpoints inside Chrome DevTools MCP, we audited every single record across all 403 meters and 40 Distribution Transformers.

### 4.1. Fleet Distributions ($N = 403$ Meters, $40$ Transformers)

| Dimension | Breakdown Across All 403 Meters |
| :--- | :--- |
| **Installation Status (`installStatus`)** | `Installed`: **238** (59.1%) · `Faulty`: **90** (22.3%) · `Decommissioned`: **75** (18.6%) |
| **Manufacturer (`make`)** | `HPL`: **90** · `Genus`: **88** · `Secure`: **85** · `Allied`: **76** · `L&T`: **64** |
| **Phase Type (`phaseType`)** | `single`: **277** (68.7%) · `three`: **126** (31.3%) |
| **Installation Type (`installType`)** | `Whole Current`: **205** (50.9%) · `CT Operated`: **198** (49.1%) |
| **Portal Schema Build (`build`)** | `legacy`: **238** (59.1%) · `v2`: **165** (40.9%) |
| **Telemetry Resolution** | `30m` (Half-hourly, `J100000`–`J100039`): **40** · `daily` (`00:00`, `J100040`–`J100402`): **363** |
| **Geographic Bounding Box** | Latitude `26.8200°N` to `26.9999°N` · Longitude `75.7100°E` to `75.9199°E` (Jaipur, Rajasthan) |

---

### 4.2. All 22 Incomplete Hierarchy Nodes (`code: ""` or `name: ""`)

Twenty-two meters in `/portal/export` have an empty string for either `code` or `name` in one of their hierarchy levels. Because every code (`C-01..C-06`, `SS-01..SS-18`, `F-001..F-028`) has an unambiguous 1-to-1 name across the rest of the dataset, [`src/normalizer.js`](./src/normalizer.js) heals all 22 automatically:

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

---

### 4.3. Tail Batch Anomaly (`J100400`–`J100402`): `DT-007` Alias Conflict & `GN` Serial Prefix

Meters `J100000`–`J100399` (400 meters) are distributed evenly across `DT-001`–`DT-040` (10 meters per DT, where `dtIndex = meterIndex % 40`). The final 3 meters (`J100400`, `J100401`, `J100402`) are special:

| Meter ID | Serial No | Make | Phase | Install Type | DT Code | Raw `hierarchy.dt.name` | Canonical `/portal/dts` Name |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `J100400` | `GN31592` | `Genus` | `three` | `CT Operated` | `DT-007` | `"Old Malviya Nagar Xfmr"` | `"Sanganer DT 7"` |
| `J100401` | `GN61501` | `Genus` | `three` | `CT Operated` | `DT-007` | `"Old Malviya Nagar Xfmr"` | `"Sanganer DT 7"` |
| `J100402` | `GN11062` | `Genus` | `three` | `CT Operated` | `DT-007` | `"Old Malviya Nagar Xfmr"` | `"Sanganer DT 7"` |

- All 3 are attached to `DT-007` (giving `DT-007` 13 meters total vs. 10 on every other DT).
- All 3 use the `GN` serial prefix for `Genus` instead of `GE`.
- All 3 name `DT-007` `"Old Malviya Nagar Xfmr"`, whereas `/portal/dts` and the other 10 meters on `DT-007` (`J100006`, `J100046`, ..., `J100366`) name it `"Sanganer DT 7"`.

---

### 4.4. Corrupted Duplicate Trailing Telemetry Rows (`J100089`, `J100134`, `J100195`, `J100211`, `J100330`)

Scanning `/portal/meters/:id/energy` across all 403 meters revealed that exactly 5 meters have an extra corrupted row appended at the end of their time series (`timestamp: "30/06/2026 00:00"` repeated twice, with `kwh: ""` and `voltR: ""` on the duplicate row):

| Meter ID | Last Valid Row (`30/06/2026 00:00`) | Appended Corrupted Row (`30/06/2026 00:00`) |
| :--- | :--- | :--- |
| `J100089` | `{ kwh: "12732.34", kvah: "13750.93", voltR: "229" }` | `{ kwh: "", kvah: "13750.93", voltR: "" }` |
| `J100134` | `{ kwh: "46417.94", kvah: "50131.38", voltR: "235" }` | `{ kwh: "", kvah: "50131.38", voltR: "" }` |
| `J100195` | `{ kwh: "24530.81", kvah: "26493.27", voltR: "228" }` | `{ kwh: "", kvah: "26493.27", voltR: "" }` |
| `J100211` | `{ kwh: "21802.96", kvah: "23547.20", voltR: "231" }` | `{ kwh: "", kvah: "23547.20", voltR: "" }` |
| `J100330` | `{ kwh: "18120.95", kvah: "19570.63", voltR: "224" }` | `{ kwh: "", kvah: "19570.63", voltR: "" }` |

---

### 4.5. Serial Prefix vs. Manufacturer (`make`) Cross-Tabulation

Across all 403 meters, here is the exact cross-tabulation of 2-character serial prefixes against the `make` field:

| Serial Prefix | Expected Make | `HPL` | `L&T` | `Genus` | `Allied` | `Secure` | Total | Matches Expected Make |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`SE`** | `Secure` | 21 | 11 | 22 | 11 | **15** | 80 | 15 / 80 (18.8%) |
| **`GE`** | `Genus` | 14 | 14 | **15** | 22 | 13 | 78 | 15 / 78 (19.2%) |
| **`AL`** | `Allied` | 25 | 8 | 19 | **16** | 22 | 90 | 16 / 90 (17.8%) |
| **`L&`** | `L&T` | 17 | **18** | 11 | 9 | 22 | 77 | 18 / 77 (23.4%) |
| **`HP`** | `HPL` | **13** | 13 | 18 | 18 | 13 | 75 | 13 / 75 (17.3%) |
| **`GN`** | `Genus` | 0 | 0 | **3** | 0 | 0 | 3 | 3 / 3 (100.0%) |
| **Total** | — | **90** | **64** | **88** | **76** | **85** | **403** | **80 / 403 (19.9%)** |

---

## 5. How Every Chrome DevTools MCP Discovery Mapped to Code in `FLOCK-PROJECT`

| Discovery via Chrome DevTools MCP | Where It Is Handled in `FLOCK-PROJECT` |
| :--- | :--- |
| Better Auth `/api/auth/sign-in/email` & 1-hour cookie TTL (`Max-Age=3600`) | [`src/portalClient.js`](./src/portalClient.js) (`login()`, `hasValidSession()`, auto-reauth on `401`) |
| HMAC-SHA256 signing of `GET\n/portal/export\npage=1\n<ts>` via `/portal/keys` | [`src/portalClient.js`](./src/portalClient.js) (`signPortalRequest()`, `fetchAllMetersBulk()`) |
| `HTTP 429` rate limit after ~110 rapid requests | [`src/portalClient.js`](./src/portalClient.js) (exponential backoff + jitter) & [`src/store.js`](./src/store.js) (bulk sync + TTL caching) |
| Dual SSR detail format (`legacy` parameter array vs. `v2` `classData` JSON string) | [`src/normalizer.js`](./src/normalizer.js) (`normalizeSsrDetailPayload()`) & [`src/portalClient.js`](./src/portalClient.js) (`decodeSvelteKitDataNode()`) |
| 22 missing hierarchy `code`/`name` values + `DT-007` `"Old Malviya Nagar Xfmr"` conflict | [`src/normalizer.js`](./src/normalizer.js) (`reconcileDataset()`) & exposed at `GET /api/v1/anomalies` |
| Modulo DAG multi-parent hierarchy (`54` intermediate codes with multiple parents) | [`src/normalizer.js`](./src/normalizer.js) (`buildNestedHierarchyTree()` + `dtPaths` + `multiParentNodes`) & exposed at `GET /api/v1/hierarchy` |
| Hidden `?from=2026-06-01&to=2026-06-30` full-month telemetry window & `30m` vs `daily` resolution | [`src/store.js`](./src/store.js) (`getMeterConsumption()`) & [`src/public/index.html`](./src/public/index.html) (7d / 30d toggle in telemetry drawer) |
| Corrupted duplicate `30/06/2026 00:00` rows with `kwh: ""` on 5 meters | [`src/normalizer.js`](./src/normalizer.js) (`normalizeEnergyReadings()`) |
| Literal `&` in 77 `L&` serial numbers | [`src/portalClient.js`](./src/portalClient.js) (`encodeURIComponent`) & [`src/store.js`](./src/store.js) (in-memory substring index) |
