# CoreUI light-theme UI rebuild

Date: 2026-09-01
Status: approved design, awaiting implementation plan

## Goal

Replace the hand-styled dark single-page UI in `public/index.html` with a
light-theme CoreUI 5 / Bootstrap 5 admin layout: a sidebar with real views
(Devices, Settings, Logs), a header with fleet-wide actions, and Bootstrap
modals for per-device actions. The server API does not change.

## Non-goals

- No dark theme or theme toggle.
- No build step, bundler, or frontend framework.
- No changes to any `/api` route, response shape, or server behaviour beyond
  two new static mounts.
- No new fleet features beyond what is needed to present the existing data
  well (stat cards, search/filter are presentation of existing data).

## Stack and delivery

- `@coreui/coreui` (v5) and `@coreui/icons` added to `package.json`
  dependencies. The installer already runs `npm install`, so the Pi stays
  offline-capable and versions are pinned via the lockfile.
- Express serves them from `node_modules`:
  - `/vendor/coreui/` -> `node_modules/@coreui/coreui/dist/`
  - `/vendor/icons/`  -> `node_modules/@coreui/icons/`
- CoreUI's `coreui.bundle.min.js` includes Popper, so a single CSS file and a
  single JS file cover CoreUI and Bootstrap components (modals, dropdowns,
  toasts, sidebar).
- Icons via the CoreUI SVG sprite (`sprites/free.svg`) with `<svg><use>`.
- No CDN references anywhere. Verified by checking the network tab.

## Files

| file | purpose |
|---|---|
| `public/index.html` | static markup: sidebar, header, three view containers, modals, toast container |
| `public/app.css` | small custom layer: badge colours for watchdog states, monospace log panel, minor spacing |
| `public/app.js` | all logic: api helper, hash router, render functions per view, modal handlers |
| `server.js` | add the two `express.static` vendor mounts (before the basic-auth gate is fine, but placing them after keeps assets behind auth like today; keep them after) |
| `package.json` | new dependencies |
| `README.md` | one line noting the UI stack |

The existing single 390-line file is split because logic, markup, and style
each now have enough content to stand alone.

## Layout

### Sidebar
- CoreUI `sidebar sidebar-fixed` with brand block ("PoE watchdog fleet" +
  short subtitle), then nav items: Devices, Settings, Logs, each with an icon.
- Active item follows the hash route.
- Uses CoreUI's built-in narrow/collapse behaviour on small screens with a
  toggler in the header.

### Header
- Left: sidebar toggler (small screens) and current view title.
- Right, in order: last-sync timestamp as muted text; SSH auth button showing
  a badge (green "key auth" / green username / red "login required"); Sync
  from UISP; Check all; Deploy all (primary).
- Fleet actions disable themselves and show a Bootstrap spinner while
  running. On completion a toast reports the result, listing failed device
  names if any.

### Devices view (`#/devices`, default)
- Stat card row (4 cards): Total, Online, In sync, Needs attention.
  "Needs attention" = drift + not installed + unreachable. Cards are computed
  from the same device list the table renders; they are not extra API calls.
- Card containing a toolbar (search input filtering on name/IP/site; status
  select: all / in sync / drift / not installed / unreachable / never checked)
  and the device table.
- Table columns: Device (name + site as muted subline, online dot), IP, Model,
  Watchdog (badge + timestamp subline), Last deploy, Actions.
- Watchdog badge mapping (same logic as current `syncLed`):
  - never checked -> secondary
  - unreachable -> danger, with error text as title/tooltip
  - not installed -> danger
  - drift detected -> warning
  - in sync, no scheduler -> warning
  - in sync + scheduled -> success
- Actions: a `btn-group btn-group-sm` with Check and Deploy visible, plus a
  dropdown containing Status, Overrides, Script, and Rescue. Rescue only
  appears when the last check errored, labelled "Rescue" or "Disarm rescue"
  based on `/api/rescues`.
- Empty state: centred muted message prompting a UISP sync.

### Settings view (`#/settings`)
- Card 1 "Fleet defaults": one form row per key in `/api/settings` defaults,
  monospace labels, text inputs.
- Card 2 "Drift auto-check": AUTO_CHECK_MINUTES input with help text
  (0 = off, needs SSH auth).
- Save button; success shows an alert/toast: "Saved. Check drift on all,
  then Deploy to apply." Saving refreshes the cached defaults used as
  placeholders in the overrides modal.

### Logs view (`#/logs`)
- Card with toolbar: level filter (all / info / warn / error) and Refresh.
- Body is a monospace, scrollable panel rendered from `/api/logs`, one line
  per entry in the existing `time LEVEL msg k=v` format, auto-scrolled to the
  bottom after each load.

### Modals (Bootstrap)
- **Watchdog status**: title "<device> — watchdog status"; shows connecting
  spinner, then two `<pre>` blocks (status, recent log lines). Errors render
  in a danger alert with a pointer to the Logs view.
- **Overrides**: one input per fleet default key, placeholder = fleet value,
  value = override or blank; help text explains blank inherits; Save calls
  `PUT /api/devices/:key/overrides` then toasts and reloads.
- **SSH login**: username/password fields, "Use these credentials", "Forget
  credentials", divider, key-auth explanation and "Set up key auth on all
  devices" with a results list (check/cross per device). Same flows as
  today, Enter in password submits.
- Script preview keeps opening `/api/devices/:key/preview` in a new tab.

### Toasts
- Bootstrap toast container fixed bottom-right. Helper `toast(msg, {variant,
  ms})`; default neutral, `danger` for errors, longer duration for the
  rescue-armed message as today.

## Behaviour

- Hash router: `#/devices` (default when hash empty or unknown), `#/settings`,
  `#/logs`. `hashchange` swaps the visible view container, updates the
  header title, and marks the sidebar item active. Settings and Logs fetch on
  entry.
- Device list reloads after check, deploy, rescue, sync, fleet actions, and
  overrides save, exactly as today.
- Search and status filter are client-side over the last loaded list and
  persist while the view is open (not across reloads).
- All user-supplied strings pass through the existing `esc()` helper before
  insertion into innerHTML.

## Error handling

- `api()` helper unchanged in contract: throws `Error(j.error || statusText)`.
- Per-device action errors: toast with device name and message, danger
  variant. Status modal additionally shows the error inline.
- Fleet action errors: toast, danger variant; buttons re-enable.
- Vendor asset load failure would leave an unstyled page; there is nothing to
  do at runtime, so the guard is the verification step below.

## Testing / verification

Manual, in the browser against a locally running server:

1. `npm install`, `node server.js`, open the portal. Network tab shows all
   CSS/JS from `/vendor/...` and `/app.*`, no external hosts.
2. Devices view: stat cards match the table; search and status filter narrow
   rows; each row action works (Check, Deploy, Status modal, Overrides modal
   save, Script new tab, Rescue toggle when applicable).
3. Header: SSH button states (missing / password / key), SSH modal flows,
   Sync, Check all, Deploy all with spinner and result toast.
4. Settings view: load, edit, save, confirm placeholders in Overrides modal
   update.
5. Logs view: renders entries, level filter, refresh, auto-scroll.
6. Hash routing: reload on each route lands on that view; back button works.
7. Resize to phone width: sidebar collapses, toggler opens it, table scrolls
   horizontally inside its card.

No automated frontend test harness exists in this repo and adding one is out
of scope; server code changes are limited to two static mounts.
