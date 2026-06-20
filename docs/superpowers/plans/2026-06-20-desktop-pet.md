# 桌宠(阿尼亚)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-contained desktop companion pet (Anya-style) — a transparent floating overlay that idles (blink), looks toward the cursor, reacts to a click (petted + speech bubble), can be dragged, and whose sprite art is swappable by dropping PNGs into the app data dir.

**Architecture:** Clone the proven result-overlay window skeleton (`resultWindow.ts` / `result.json`): a borderless transparent draggable window, geometry persisted by the main window (sole settings.json writer). The pet is pure-frontend (timer + pointer driven, no audio/system events). Backend is minimal — only a `PetSettings` model, two fire-and-forget window commands (lock / always-on-top), one asset-dir command, and a tray toggle. Pose art is loaded from `${appDataDir}/pet/{pose}.png` via `convertFileSrc` (asset protocol scope in `tauri.conf.json`), with an inline SVG placeholder fallback so the feature is fully testable before real art exists.

**Tech Stack:** Tauri v2 (Rust), React 19, TypeScript, Vite. No new frontend deps; no new Rust crates. Rust not in PATH — prepend `export PATH="$HOME/.cargo/bin:$PATH"` before any `cargo`/`tauri` command.

**Spec:** `docs/superpowers/specs/2026-06-20-desktop-pet-design.md`

**Branch:** `feat/desktop-pet` (already created from `main`; work here).

**Deviation from spec (v1 scope):** The spec listed 5 poses (idle/blink/happy/drag/surprise). v1 ships **idle / blink / happy** — every shipped pose has a real trigger and reliably reverts. The `drag` pose is dropped because Tauri's `startDragging()` lets the OS consume the pointer-up, so reverting from a drag pose needs a focus-listener (out of scope); `surprise` had no trigger. The asset-slot convention (`{idle,blink,happy}.png`) is the v1 contract; drag/surprise can be added later by extending the reducer + slots.

---

## File Structure

**Backend (Rust) — modify only:**
- `src-tauri/src/settings.rs` — add `PetSettings` struct + `Default` + serde default fn; add field to `AppSettings`; add unit tests.
- `src-tauri/src/lib.rs` — add `Emitter` import; add 3 commands (`pet_set_locked`, `pet_set_always_on_top`, `pet_assets_dir`); add tray `CheckMenuItem "桌宠"`; register commands in `invoke_handler`.

**Tauri config / capabilities — modify + create:**
- `src-tauri/tauri.conf.json` — enable `assetProtocol` + scope `$APPDATA/pet/**` (csp stays `null`).
- `src-tauri/capabilities/pet.json` — **create** (clone `result.json` + event perms).
- `src-tauri/capabilities/settings.json` — add `opener:default` (for the "open folder" button).

**Frontend — create + modify:**
- `src/features/settings/settingsTypes.ts` — add `PetSettings` interface + `DEFAULT_PET`; wire into `AppSettings` / `DEFAULT_SETTINGS` / `SettingsPatch`.
- `src/features/pet/petWindow.ts` — **create** (clone of `resultWindow.ts`, label `pet`, 150×200, bottom-right default placement).
- `src/components/PetWindow.tsx` + `src/components/PetWindow.css` — **create** (renderer: pose state machine, asset loader + SVG fallback, click/drag disambiguation, hover-look, speech bubbles, idle timers).
- `src/App.tsx` — add `pet` window route.
- `src/components/CommandCard.tsx` — wire pet show/hide + always_on_top/locked + geometry persist + `settings:updated` merge + `settings://changed` reload.
- `src/components/SettingsPanel.tsx` — add "桌宠" section (toggles, scale, intervals, speech-lines editor, reset position, open-folder).

---

## Task 1: `PetSettings` Rust model (TDD)

**Files:**
- Modify: `src-tauri/src/settings.rs` (insert struct before `AppSettings`; add field + tests)

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/settings.rs`, append at the very end of the file (after `clear_api_key`):

```rust
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pet_settings_default_is_sensible() {
        let p = PetSettings::default();
        assert!(!p.enabled);
        assert!(p.always_on_top); // pet should be visible by default
        assert!(!p.locked); // interactive by default
        assert!((p.scale - 1.0).abs() < 1e-6);
        assert_eq!(p.x, -1);
        assert_eq!(p.y, -1); // -1 sentinel = never placed
        assert!(!p.speech_lines.is_empty());
    }

    #[test]
    fn legacy_settings_without_pet_section_still_loads() {
        // A settings.json written before this feature lacks the `pet` section.
        // It MUST still deserialize (pet falls back to default) instead of
        // wiping the user's saved appearance/system.
        let legacy = serde_json::json!({
            "appearance": {
                "bg_r": 10, "bg_g": 20, "bg_b": 30, "bg_a": 0.5,
                "blur": 1.0, "radius": 2.0, "font_scale": 1.0
            },
            "system": { "autostart": false }
        });
        let parsed: AppSettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.appearance.bg_r, 10); // preserved
        assert!(!parsed.system.autostart); // preserved
        assert!(!parsed.pet.enabled); // pet defaulted
        assert!(parsed.pet.always_on_top);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `src-tauri/`):
```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --lib settings::tests
```
Expected: FAIL — `PetSettings` / `pet` field not found (compile error: cannot find type/field).

- [ ] **Step 3: Add the `PetSettings` struct + default fn**

In `src-tauri/src/settings.rs`, insert this block immediately **before** the `#[derive(Serialize, Deserialize, Clone, Debug, Default)] pub struct AppSettings` definition (i.e., right after the `SystemSettings` / `default_autostart` block ends):

```rust
/// Desktop pet (Anya companion) settings. A self-contained floating overlay that
/// idles (blink), looks toward the cursor, reacts to a click (petted + speech
/// bubble), and can be dragged. Decoupled from Bugzia's other features — no
/// audio / system events. The whole section is `#[serde(default)]` on
/// `AppSettings`, so a legacy settings.json (which predates this feature) loads
/// the defaults below instead of wiping. Manual `Default` keeps a fresh install
/// visually correct rather than collapsing to 0/false.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PetSettings {
    /// Master on/off for the overlay.
    pub enabled: bool,
    /// Pin above all other windows (the pet should be visible by default).
    pub always_on_top: bool,
    /// Lock = mouse click-through (pointer reaches the desktop; the pet's own
    /// click/drag handlers stop firing — the expected behavior of "lock").
    pub locked: bool,
    /// Overall sprite scale multiplier (1.0 = native image size).
    pub scale: f32,
    /// Idle blink interval, ms.
    pub blink_interval_ms: u32,
    /// Whether the pet shows speech bubbles at all.
    pub speech_enabled: bool,
    /// Idle random-speech interval, ms.
    pub speech_interval_ms: u32,
    /// Speech-bubble lines (one chosen at random). User-editable in Settings.
    #[serde(default = "default_pet_speech_lines")]
    pub speech_lines: Vec<String>,
    /// Overlay window position, LOGICAL px. `-1` sentinel = never placed by the
    /// user; show then defaults to lower-right of the screen.
    pub x: i32,
    pub y: i32,
    /// Overlay window size, LOGICAL px.
    pub w: u32,
    pub h: u32,
}

fn default_pet_speech_lines() -> Vec<String> {
    ["哇酷哇酷", "好厉害!", "嘿嘿", "喜欢!", "诶嘿~"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

impl Default for PetSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            always_on_top: true,
            locked: false,
            scale: 1.0,
            blink_interval_ms: 4000,
            speech_enabled: true,
            speech_interval_ms: 20000,
            speech_lines: default_pet_speech_lines(),
            x: -1,
            y: -1,
            w: 150,
            h: 200,
        }
    }
}
```

- [ ] **Step 4: Add the field to `AppSettings`**

In `src-tauri/src/settings.rs`, change the `AppSettings` struct to append the `pet` field:

```rust
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub result: ResultAppearanceSettings,
    #[serde(default)]
    pub window: WindowSettings,
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub search: SearchSettings,
    #[serde(default)]
    pub system: SystemSettings,
    #[serde(default)]
    pub pet: PetSettings,
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `src-tauri/`):
```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --lib settings::tests
```
Expected: PASS — both `pet_settings_default_is_sensible` and `legacy_settings_without_pet_section_still_loads`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat(pet): add PetSettings model with serde backward-compat + tests"
```

---

## Task 2: Backend window commands + asset dir + tray toggle

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `fs` + `PathBuf` + `Emitter` imports**

In `src-tauri/src/lib.rs`, replace the import block:

```rust
mod ai;
mod file_search;
mod settings;
mod weather;

use ai::{ask_once, ask_once_stream, chat, clear_context, get_messages, stop_chat, test_ai_connection};
use file_search::{open_file, reveal_file, search_files};
use settings::{clear_api_key, load_api_key, load_settings, save_api_key, save_settings};

use std::fs;
use std::path::PathBuf;

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_autostart::{AutoLaunchManager, MacosLauncher};
```

- [ ] **Step 2: Add the three pet commands**

In `src-tauri/src/lib.rs`, insert immediately **after** the existing `set_result_always_on_top` command (before `sync_autostart`):

```rust
/// Lock the pet overlay = click-through (pointer reaches the desktop). Backend
/// command (not frontend) because the pet window's capability lacks
/// `allow-set-ignore-cursor-events`. Fire-and-forget like `set_result_always_on_top`.
#[tauri::command]
fn pet_set_locked(app: AppHandle, locked: bool) {
    if let Some(win) = app.get_webview_window("pet") {
        let _ = win.set_ignore_cursor_events(locked);
    }
}

/// Pin (or unpin) the pet overlay above every other window. Same ACL rationale
/// as `pet_set_locked` / `set_result_always_on_top`.
#[tauri::command]
fn pet_set_always_on_top(app: AppHandle, top: bool) {
    if let Some(win) = app.get_webview_window("pet") {
        let _ = win.set_always_on_top(top);
    }
}

/// Resolve (and create if missing) the pet sprite directory under appDataDir,
/// returning its absolute path. The frontend uses this both to know where to
/// load pose PNGs from (via `convertFileSrc`) and to open in the file manager
/// from Settings. Creating it here means `openPath` never targets a missing dir.
#[tauri::command]
fn pet_assets_dir(app: AppHandle) -> Result<String, String> {
    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?
        .join("pet");
    fs::create_dir_all(&dir).map_err(|e| format!("create pet dir: {e}"))?;
    dir.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "pet dir path is not valid UTF-8".to_string())
}
```

- [ ] **Step 3: Add the tray `CheckMenuItem` + handler arm**

In `build_tray`, replace the block that loads `want_autostart` + builds the menu + handler. The full replacement of `build_tray`:

```rust
/// Build the system tray: show / autostart toggle / pet toggle / quit. The
/// autostart item starts checked to match the synced intent and re-syncs on every
/// toggle. The pet item mirrors `settings.pet.enabled`; toggling it only persists
/// the intent and emits `settings://changed` — the MAIN window does the actual
/// overlay create/show (frontend ACL), not Rust.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let want_autostart = load_settings(app.clone())
        .map(|s| s.system.autostart)
        .unwrap_or(true);
    let want_pet = load_settings(app.clone())
        .map(|s| s.pet.enabled)
        .unwrap_or(false);

    let show_item = MenuItem::with_id(app, "show", "显示 Bugzia", true, None::<&str>)?;
    let autostart_item =
        CheckMenuItem::with_id(app, "autostart", "开机自启", true, want_autostart, None::<&str>)?;
    let pet_item =
        CheckMenuItem::with_id(app, "pet", "桌宠", true, want_pet, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    // Heterogeneous item types need an explicit `&[&dyn IsMenuItem]` coercion.
    let autostart_for_handler = autostart_item.clone();
    let pet_for_handler = pet_item.clone();
    let items: &[&dyn IsMenuItem<Wry>] =
        &[&show_item, &autostart_item, &pet_item, &quit_item];
    let menu = Menu::with_items(app, items)?;

    TrayIconBuilder::new()
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("missing default window icon"),
        )
        .tooltip("Bugzia")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => focus_main(app),
            "quit" => app.exit(0),
            "autostart" => {
                // Toggle the user intent, persist it, mirror to the OS, and
                // update the check mark so the menu reflects the new state.
                let mut s = load_settings(app.clone()).unwrap_or_default();
                s.system.autostart = !s.system.autostart;
                let next = s.system.autostart;
                let _ = save_settings(app.clone(), s);
                let mgr = app.state::<AutoLaunchManager>();
                let _ = if next { mgr.enable() } else { mgr.disable() };
                let _ = autostart_for_handler.set_checked(next);
            }
            "pet" => {
                // Toggle the pet-enabled intent, persist it, mirror the
                // checkmark, and signal MAIN to apply it. Rust does NOT create
                // the overlay window (frontend ACL); main reloads settings on
                // "settings://changed" and drives window creation.
                let mut s = load_settings(app.clone()).unwrap_or_default();
                s.pet.enabled = !s.pet.enabled;
                let next = s.pet.enabled;
                let _ = save_settings(app.clone(), s);
                let _ = app.emit("settings://changed", ());
                let _ = pet_for_handler.set_checked(next);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
```

- [ ] **Step 4: Register the commands in `invoke_handler`**

In `src-tauri/src/lib.rs`, change the `invoke_handler` list to add the three pet commands after `set_result_always_on_top`:

```rust
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            save_api_key,
            load_api_key,
            clear_api_key,
            chat,
            stop_chat,
            clear_context,
            get_messages,
            test_ai_connection,
            ask_once,
            ask_once_stream,
            search_files,
            open_file,
            reveal_file,
            weather::weather,
            set_result_always_on_top,
            pet_set_locked,
            pet_set_always_on_top,
            pet_assets_dir,
        ])
```

- [ ] **Step 5: Verify it compiles + `generate_context` validates conf/capabilities**

Run (from `src-tauri/`):
```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo check
```
Expected: EXIT 0 (no errors, no warnings about the new code).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(pet): add lock/always-on-top/assets-dir commands + tray toggle"
```

---

## Task 3: Asset protocol config + capabilities

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/pet.json`
- Modify: `src-tauri/capabilities/settings.json`

- [ ] **Step 1: Enable the asset protocol scope in `tauri.conf.json`**

In `src-tauri/tauri.conf.json`, replace the `"security"` block:

```json
    "security": {
      "csp": null,
      "assetProtocol": {
        "enable": true,
        "scope": ["$APPDATA/pet/**"]
      }
    }
```

Rationale: `csp: null` means no CSP meta tag is injected, so `asset:` / `http://asset.localhost` image URLs are not blocked by CSP. The `scope` (globset) still gates which files are readable — only files under the app's data `pet/` dir load. (`$APPDATA` is Tauri's per-app data dir variable, matching `app_data_dir()`.)

- [ ] **Step 2: Create the pet window capability**

Create `src-tauri/capabilities/pet.json` (clone of `result.json` + event perms so the pet window can listen for `settings:updated`):

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "pet",
  "description": "Capability for the desktop pet overlay window",
  "windows": ["pet"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-hide",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    "core:window:allow-start-dragging",
    "core:event:allow-listen",
    "core:event:default"
  ]
}
```

(`core:default` already bundles `core:path:default`, so `appDataDir()`-style resolvers + `convertFileSrc` are available; no extra path permission needed.)

- [ ] **Step 3: Add `opener:default` to the settings capability**

In `src-tauri/capabilities/settings.json`, add `"opener:default"` to the `permissions` array (the Settings "打开素材文件夹" button calls the opener plugin):

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "settings",
  "description": "Capability for the settings popup window",
  "windows": ["settings"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-set-focus",
    "core:window:allow-start-dragging",
    "dialog:default",
    "opener:default"
  ]
}
```

- [ ] **Step 4: Verify capabilities validate**

Run (from `src-tauri/`):
```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo check
```
Expected: EXIT 0 — `generate_context!` parses the new/changed capabilities at compile time; a malformed capability fails here.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/capabilities/pet.json src-tauri/capabilities/settings.json
git commit -m "feat(pet): asset protocol scope + pet capability + settings opener perm"
```

---

## Task 4: Frontend `PetSettings` types

**Files:**
- Modify: `src/features/settings/settingsTypes.ts`
- Modify: `src/components/SettingsWindow.tsx` (emit `pet` in the `settings:updated` patch)

- [ ] **Step 1: Add the `PetSettings` interface + `DEFAULT_PET`**

In `src/features/settings/settingsTypes.ts`, insert after the `SystemSettings` interface (before `AppSettings`):

```ts
/**
 * Desktop pet (Anya companion) settings. Frontend mirror of Rust `PetSettings`
 * (src-tauri/src/settings.rs); field names MUST match the serde JSON keys exactly.
 *
 * Self-contained overlay: idles (blink), looks toward the cursor, reacts to a
 * click (petted + speech bubble), can be dragged. No audio / system events.
 * x/y of -1 = never placed by the user (show defaults to lower-right).
 */
export interface PetSettings {
  enabled: boolean;
  always_on_top: boolean;
  locked: boolean;
  /** Sprite scale multiplier, 1 = native image size. */
  scale: number;
  blink_interval_ms: number;
  speech_enabled: boolean;
  speech_interval_ms: number;
  speech_lines: string[];
  /** -1 sentinel = never placed by the user. */
  x: number;
  y: number;
  w: number;
  h: number;
}
```

Then insert after `DEFAULT_SYSTEM` (before `DEFAULT_SETTINGS`):

```ts
export const DEFAULT_PET: PetSettings = {
  enabled: false,
  always_on_top: true,
  locked: false,
  scale: 1,
  blink_interval_ms: 4000,
  speech_enabled: true,
  speech_interval_ms: 20000,
  speech_lines: ["哇酷哇酷", "好厉害!", "嘿嘿", "喜欢!", "诶嘿~"],
  x: -1,
  y: -1,
  w: 150,
  h: 200,
};
```

- [ ] **Step 2: Wire into `AppSettings`, `DEFAULT_SETTINGS`, `SettingsPatch`**

Change the `AppSettings` interface to add the `pet` field:

```ts
export interface AppSettings {
  appearance: AppearanceSettings;
  result: ResultAppearanceSettings;
  window: WindowSettings;
  ai: AiSettings;
  search: SearchSettings;
  system: SystemSettings;
  pet: PetSettings;
}
```

Change `DEFAULT_SETTINGS` to add `pet`:

```ts
export const DEFAULT_SETTINGS: AppSettings = {
  appearance: DEFAULT_APPEARANCE,
  result: DEFAULT_RESULT,
  window: DEFAULT_WINDOW,
  ai: DEFAULT_AI,
  search: DEFAULT_SEARCH,
  system: DEFAULT_SYSTEM,
  pet: DEFAULT_PET,
};
```

Change `SettingsPatch` to add `pet`:

```ts
export interface SettingsPatch {
  appearance: AppearanceSettings;
  result: ResultAppearanceSettings;
  ai: AiSettings;
  search: SearchSettings;
  windowLocked: boolean;
  pet: PetSettings;
}
```

- [ ] **Step 3: Emit `pet` in the settings-window broadcast**

`pet` is now a REQUIRED field on `SettingsPatch`, so both places `SettingsWindow.tsx` builds the `settings:updated` payload must include it (otherwise `tsc` fails, and pet edits from the panel would never reach main). In `src/components/SettingsWindow.tsx`, change the `broadcast` function's `emit` payload:

```ts
      void emit("settings:updated", {
        appearance: next.appearance,
        result: next.result,
        ai: next.ai,
        search: next.search,
        pet: next.pet,
        windowLocked: next.window.locked,
      });
```

And the `flushAndClose` function's `emit` payload:

```ts
      void emit("settings:updated", {
        appearance: cur.appearance,
        result: cur.result,
        ai: cur.ai,
        search: cur.search,
        pet: cur.pet,
        windowLocked: cur.window.locked,
      });
```

- [ ] **Step 4: Type-check**

Run (from project root):
```bash
pnpm exec tsc --noEmit
```
Expected: 0 errors. (Adding the required `pet` field to `SettingsPatch` is exactly what makes the two `SettingsWindow.tsx` payloads type-check — hence Step 3 is mandatory, not optional.)

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/settingsTypes.ts src/components/SettingsWindow.tsx
git commit -m "feat(pet): add PetSettings types + DEFAULT_PET + emit pet in settings broadcast"
```

---

## Task 5: `petWindow.ts` lifecycle

**Files:**
- Create: `src/features/pet/petWindow.ts`

- [ ] **Step 1: Create the window lifecycle module**

Create `src/features/pet/petWindow.ts` (clone of `resultWindow.ts` shape; label `pet`, 150×200, **bottom-right** default placement; no replay/focus handshake — the pet needs none):

```ts
/**
 * Desktop-pet overlay window lifecycle — MUST run in the MAIN window context.
 *
 * Same rationale as resultWindow.ts: Tauri v2 checks window ACL against the
 * CALLER (main, `capabilities/default.json` has allow-set-position/size), so
 * positioning runs here. The pet window itself (`capabilities/pet.json`) lacks
 * those perms — it only renders, listens for `settings:updated`, and calls
 * `getCurrentWindow().startDragging()` on a pointer drag.
 *
 * Geometry memory: the overlay remembers its LOGICAL position + size across
 * sessions (persisted by main into settings.json as pet.x/y/w/h). On show, if
 * the user has placed it before (x >= 0) we restore that exact spot + size;
 * otherwise we default to the LOWER-RIGHT of the screen.
 *
 * Lifecycle is create-once-then-hide: the window is hidden, not destroyed, so
 * its React state (pose machine, timers) survives close/reopen and reopening is
 * instant. Created with `visible:false` then positioned + shown to avoid a
 * flash at a default location.
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";

const LABEL = "pet";
const DEFAULT_W = 150;
const DEFAULT_H = 200;
const MIN_W = 80;
const MIN_H = 100;

/** Saved overlay geometry (LOGICAL px) handed to `showPetWindow`. */
export interface PetGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A partial geometry update emitted on a user move/resize (LOGICAL px). */
export type PetGeomPatch = Partial<PetGeom>;

let geomCb: ((patch: PetGeomPatch) => void) | null = null;
let geomAttached = false;
/** Suppress geometry persistence while WE move/resize the window on show, so a
 *  programmatic placement isn't mistaken for a user placement (which would pin
 *  the pet to the default spot forever). */
let suppressGeomPersist = false;

/**
 * Register the callback fired with the pet window's LOGICAL geometry whenever the
 * USER moves or resizes it. Wired by the main window so it can persist pet.x/y/w/h
 * (main is the sole settings.json writer). Attaches lazily on first window existence.
 */
export function onPetGeometryChange(cb: (patch: PetGeomPatch) => void): void {
  geomCb = cb;
}

/** Attach move + resize listeners once per app lifetime. ACL-checked against main. */
function attachGeometryIfNeeded(win: WebviewWindow): void {
  if (geomAttached) return;
  geomAttached = true;

  win.onResized(async ({ payload }) => {
    if (suppressGeomPersist || !geomCb) return;
    try {
      const sf = await win.scaleFactor();
      geomCb({ w: Math.round(payload.width / sf), h: Math.round(payload.height / sf) });
    } catch {
      geomAttached = false;
    }
  }).catch(() => {
    geomAttached = false;
  });

  win.onMoved(async ({ payload }) => {
    if (suppressGeomPersist || !geomCb) return;
    try {
      const sf = await win.scaleFactor();
      geomCb({ x: Math.round(payload.x / sf), y: Math.round(payload.y / sf) });
    } catch {
      geomAttached = false;
    }
  }).catch(() => {
    geomAttached = false;
  });
}

/** Get-or-create the pet window. Awaits creation so callers can position it. */
export async function ensurePetWindow(): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    attachGeometryIfNeeded(existing);
    return existing;
  }

  const win = new WebviewWindow(LABEL, {
    title: "Bugzia 桌宠",
    width: DEFAULT_W,
    height: DEFAULT_H,
    minWidth: MIN_W,
    minHeight: MIN_H,
    resizable: true,
    decorations: false,
    transparent: true,
    shadow: false,
    skipTaskbar: true,
    visible: false, // positioned before reveal — no flash
    center: false,
  });

  await new Promise<void>((resolve, reject) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (e) =>
      reject(new Error("pet window creation failed: " + String(e))),
    );
  });

  attachGeometryIfNeeded(win);
  return win;
}

/**
 * Default placement: LOWER-RIGHT of the screen (so it doesn't cover the centered
 * main bar). All math in LOGICAL pixels. Used only when the user has not yet
 * placed the pet themselves (no saved pet.x/y, or the -1 sentinel).
 */
async function defaultPlacement(): Promise<void> {
  const main = getCurrentWindow();
  const pet = (await WebviewWindow.getByLabel(LABEL)) ?? (await ensurePetWindow());
  const sf = await main.scaleFactor();
  const mon = await currentMonitor();
  const waW = mon ? mon.size.width / sf : DEFAULT_W * 6;
  const waH = mon ? mon.size.height / sf : DEFAULT_H * 6;
  const w = DEFAULT_W;
  const h = DEFAULT_H;
  const x = Math.round(waW - w - 24); // 24px right margin
  const y = Math.round(waH - h - 80); // ~80px above the taskbar

  suppressGeomPersist = true;
  try {
    await pet.setPosition(new LogicalPosition(x, y));
    await pet.setSize(new LogicalSize(w, h));
  } finally {
    // Move/resize events from our own setPosition/setSize land asynchronously;
    // stay suppressed briefly so they aren't persisted as a "user placement".
    setTimeout(() => {
      suppressGeomPersist = false;
    }, 60);
  }
}

/** Ensure + place + reveal. If `saved` carries a user placement (x >= 0),
 *  restore that exact position + size; otherwise default to lower-right.
 *  Pin / click-through are applied separately from main via backend commands
 *  (`pet_set_always_on_top` / `pet_set_locked`). */
export async function showPetWindow(saved?: PetGeom): Promise<void> {
  const pet = await ensurePetWindow();
  if (saved && saved.x >= 0 && saved.y >= 0) {
    const w = Math.max(MIN_W, saved.w || DEFAULT_W);
    const h = Math.max(MIN_H, saved.h || DEFAULT_H);
    suppressGeomPersist = true;
    try {
      await pet.setPosition(new LogicalPosition(saved.x, saved.y));
      await pet.setSize(new LogicalSize(w, h));
    } finally {
      setTimeout(() => {
        suppressGeomPersist = false;
      }, 60);
    }
  } else {
    await defaultPlacement();
  }
  try {
    await pet.show();
  } catch (e) {
    console.error("[bugzia] show pet window", e);
  }
}

/** Hide (not destroy) the pet window. Renderer state persists for next show. */
export async function hidePetWindow(): Promise<void> {
  const pet = await WebviewWindow.getByLabel(LABEL);
  if (!pet) return;
  try {
    await pet.hide();
  } catch (e) {
    console.error("[bugzia] hide pet window", e);
  }
}
```

- [ ] **Step 2: Type-check**

Run (from project root):
```bash
pnpm exec tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/pet/petWindow.ts
git commit -m "feat(pet): add pet overlay window lifecycle (clone of resultWindow)"
```

---

## Task 6: `PetWindow.tsx` renderer + CSS + App route

**Files:**
- Create: `src/components/PetWindow.tsx`
- Create: `src/components/PetWindow.css`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create the renderer component**

Create `src/components/PetWindow.tsx`:

```tsx
import { useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { loadSettings } from "../features/settings/settingsStore";
import { DEFAULT_PET, type PetSettings } from "../features/settings/settingsTypes";
import "./PetWindow.css";

type Pose = "idle" | "blink" | "happy";
const POSES: Pose[] = ["idle", "blink", "happy"];

type PetEvent =
  | { type: "pet" }
  | { type: "blink" }
  | { type: "to-idle" };

/** Pose state machine. `happy`/`blink` are transient — an effect reverts them to
 *  `idle` after a short delay (see `useEffect([pose])`). */
function petReducer(state: Pose, event: PetEvent): Pose {
  switch (event.type) {
    case "pet":
      return "happy";
    case "blink":
      return "blink";
    case "to-idle":
      return "idle";
    default:
      return state;
  }
}

/** Pointer moved past `threshold` px from the start point -> it's a drag, not a
 *  click. Kept as an exported pure function so it can be unit-tested later. */
export function isDrag(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  threshold = 5,
): boolean {
  return Math.hypot(endX - startX, endY - startY) > threshold;
}

const DRAG_THRESHOLD = 5;

/** Inline SVG shown when a pose PNG is missing or fails to load, so the feature
 *  is fully testable before real art exists. A pink chibi-ish labeled card. */
function placeholderDataUri(pose: Pose): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='150' height='200'>` +
    `<rect width='150' height='200' rx='18' fill='#FFB7C5' opacity='0.9'/>` +
    `<circle cx='75' cy='78' r='44' fill='#ffffff'/>` +
    `<circle cx='61' cy='74' r='6' fill='#5a3b46'/>` +
    `<circle cx='89' cy='74' r='6' fill='#5a3b46'/>` +
    `<path d='M62 92 Q75 102 88 92' stroke='#5a3b46' stroke-width='3' fill='none' stroke-linecap='round'/>` +
    `<text x='75' y='150' font-size='13' text-anchor='middle' fill='#ffffff'>${pose}</text>` +
    `<text x='75' y='172' font-size='11' text-anchor='middle' fill='#ffffff' opacity='0.85'>占位</text>` +
    `</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function randomLine(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

export default function PetWindow() {
  const [pose, dispatch] = useReducer(petReducer, "idle");
  const [settings, setSettings] = useState<PetSettings>(DEFAULT_PET);
  const settingsRef = useRef<PetSettings>(DEFAULT_PET);
  const [bubble, setBubble] = useState<string | null>(null);
  const [poseSrcs, setPoseSrcs] = useState<Record<Pose, string> | null>(null);
  const [failed, setFailed] = useState<Partial<Record<Pose, boolean>>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Load settings on mount + resolve pose image URLs from ${appDataDir}/pet (the
  // dir is created by the `pet_assets_dir` backend command).
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await loadSettings();
      if (!alive) return;
      settingsRef.current = s.pet;
      setSettings(s.pet);
      try {
        const dir = await invoke<string>("pet_assets_dir");
        if (!alive) return;
        const map = {} as Record<Pose, string>;
        for (const p of POSES) map[p] = convertFileSrc(`${dir}/${p}.png`);
        setPoseSrcs(map);
        setFailed({}); // clear stale per-pose failures on a fresh resolve
      } catch (e) {
        console.error("[bugzia] resolve pet asset dir", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Live-apply settings changes broadcast by the settings window.
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let alive = true;
    (async () => {
      un = await listen<{ pet: PetSettings }>("settings:updated", (ev) => {
        if (ev.payload?.pet) {
          settingsRef.current = ev.payload.pet;
          setSettings(ev.payload.pet);
        }
      });
      if (!alive && un) un();
    })();
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  // Revert a transient pose (happy / blink) back to idle.
  useEffect(() => {
    if (pose === "idle") return;
    const ms = pose === "blink" ? 150 : 800;
    const t = window.setTimeout(() => dispatch({ type: "to-idle" }), ms);
    return () => window.clearTimeout(t);
  }, [pose]);

  // Idle blink timer (recursive). Cheap; keeps running while hidden (no harm).
  useEffect(() => {
    const iv = settings.blink_interval_ms;
    if (!iv || iv <= 0) return;
    let stopped = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (stopped) return;
        dispatch({ type: "blink" });
        schedule();
      }, iv);
    };
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [settings.blink_interval_ms]);

  // Idle random-speech timer.
  useEffect(() => {
    if (!settings.speech_enabled || !settings.speech_lines?.length) return;
    const iv = settings.speech_interval_ms;
    if (!iv || iv <= 0) return;
    const lines = settings.speech_lines;
    let stopped = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (stopped) return;
        setBubble(randomLine(lines));
        schedule();
      }, iv);
    };
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [settings.speech_enabled, settings.speech_interval_ms, settings.speech_lines]);

  // Auto-clear the speech bubble after a moment.
  useEffect(() => {
    if (bubble == null) return;
    const t = window.setTimeout(() => setBubble(null), 2500);
    return () => window.clearTimeout(t);
  }, [bubble]);

  // Click vs drag disambiguation (no data-tauri-drag-region — it eats clicks).
  const dragState = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    if (settingsRef.current.locked) return; // click-through handled by backend
    dragState.current = { x: e.clientX, y: e.clientY, moved: false };
  }

  function onPointerMove(e: React.PointerEvent) {
    const el = rootRef.current;
    // Hover look (no button held): write normalized cursor pos as CSS vars.
    if (el && e.buttons === 0) {
      const r = el.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      el.style.setProperty("--look-x", nx.toFixed(3));
      el.style.setProperty("--look-y", ny.toFixed(3));
    }
    // Drag detection (button held).
    const ds = dragState.current;
    if (!ds) return;
    if (!ds.moved && isDrag(ds.x, ds.y, e.clientX, e.clientY, DRAG_THRESHOLD)) {
      ds.moved = true;
      getCurrentWindow()
        .startDragging()
        .catch((err) => console.error("[bugzia] startDragging", err));
    }
  }

  function onPointerUp() {
    const ds = dragState.current;
    dragState.current = null;
    if (!ds) return;
    if (!ds.moved) {
      // A click (no drag) -> pet reaction + speech.
      dispatch({ type: "pet" });
      const cur = settingsRef.current;
      if (cur.speech_enabled && cur.speech_lines?.length) {
        setBubble(randomLine(cur.speech_lines));
      }
    }
  }

  const src = poseSrcs?.[pose];
  const showFallback = !src || !!failed[pose];
  const style = { "--scale": settings.scale } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className="pet-root"
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {bubble != null && <div className="pet-bubble">{bubble}</div>}
      <div className="pet-look">
        {showFallback ? (
          <img className="pet-sprite" src={placeholderDataUri(pose)} alt="" draggable={false} />
        ) : (
          <img
            className="pet-sprite"
            src={src}
            alt=""
            draggable={false}
            onError={() => setFailed((f) => ({ ...f, [pose]: true }))}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the CSS**

Create `src/components/PetWindow.css`:

```css
/* Desktop pet overlay. The window itself is transparent + borderless, so only
   the sprite (and optional speech bubble) is visible. The root fills the window
   and carries the pointer handlers; .pet-look applies the look-toward-cursor
   translate; .pet-sprite owns the breathing scale animation (two elements so the
   two transforms never collide). */
.pet-root {
  position: relative;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: transparent;
  cursor: grab;
  --look-x: 0;
  --look-y: 0;
}
.pet-root:active {
  cursor: grabbing;
}

.pet-look {
  transform: translate(calc(var(--look-x) * 5px), calc(var(--look-y) * 4px));
  transition: transform 140ms ease-out;
}

.pet-sprite {
  display: block;
  width: calc(150px * var(--scale, 1));
  height: auto;
  max-height: calc(200px * var(--scale, 1));
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
  animation: pet-breathe 3.4s ease-in-out infinite;
  filter: drop-shadow(0 6px 6px rgba(0, 0, 0, 0.28));
}

@keyframes pet-breathe {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.025);
  }
}

.pet-bubble {
  position: absolute;
  bottom: calc(190px * var(--scale, 1));
  left: 50%;
  transform: translateX(-50%);
  background: rgba(255, 255, 255, 0.94);
  color: #5a3b46;
  padding: 6px 12px;
  border-radius: 12px;
  font-size: 14px;
  white-space: nowrap;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18);
  animation: pet-pop 0.25s ease-out;
  pointer-events: none;
}

@keyframes pet-pop {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}
```

- [ ] **Step 3: Add the `pet` route in `App.tsx`**

In `src/App.tsx`, add the import and route:

```tsx
import { getCurrentWindow } from "@tauri-apps/api/window";
import CommandCard from "./components/CommandCard";
import PetWindow from "./components/PetWindow";
import ResultWindow from "./components/ResultWindow";
import SettingsWindow from "./components/SettingsWindow";
import "./styles/theme.css";

/**
 * Single SPA, routed by Tauri window label. Each window loads index.html and
 * renders a different root: main (长条入口) / result (结果浮层) / settings (设置弹窗)
 * / pet (桌宠浮层).
 */
function App() {
  const label = getCurrentWindow().label;
  if (label === "result") return <ResultWindow />;
  if (label === "settings") return <SettingsWindow />;
  if (label === "pet") return <PetWindow />;
  return <CommandCard />;
}

export default App;
```

- [ ] **Step 4: Type-check + build**

Run (from project root):
```bash
pnpm exec tsc --noEmit && pnpm build
```
Expected: 0 type errors; `dist/` produced.

- [ ] **Step 5: Commit**

```bash
git add src/components/PetWindow.tsx src/components/PetWindow.css src/App.tsx
git commit -m "feat(pet): add PetWindow renderer (pose machine, click/drag, speech) + route"
```

---

## Task 7: `CommandCard.tsx` wiring

**Files:**
- Modify: `src/components/CommandCard.tsx`

- [ ] **Step 1: Add imports**

In `src/components/CommandCard.tsx`, add to the existing settings-types import, and add the pet-window import. Change:

```ts
import type { AppSettings, WindowSettings, SettingsPatch } from "../features/settings/settingsTypes";
import {
  hideResultWindow,
  isResultVisible,
  onResultGeometryChange,
  showResultWindow,
} from "../features/result/resultWindow";
```

to:

```ts
import type { AppSettings, PetSettings, WindowSettings, SettingsPatch } from "../features/settings/settingsTypes";
import {
  hideResultWindow,
  isResultVisible,
  onResultGeometryChange,
  showResultWindow,
} from "../features/result/resultWindow";
import {
  hidePetWindow,
  onPetGeometryChange,
  showPetWindow,
} from "../features/pet/petWindow";
```

(`invoke` is already imported from `@tauri-apps/api/core`; `listen` from `@tauri-apps/api/event`.)

- [ ] **Step 2: Merge `pet` into the `settings:updated` handler**

In the existing `settings:updated` listener effect, change the `merged` object to include `pet`:

```ts
        const merged: AppSettings = {
          ...cur,
          appearance: ev.payload.appearance,
          result: ev.payload.result,
          ai: ev.payload.ai,
          search: ev.payload.search,
          pet: ev.payload.pet,
          window: { ...cur.window, locked: ev.payload.windowLocked },
        };
```

- [ ] **Step 3: Add the pet `enabled` effect (show/hide + apply pin/lock on show)**

Add a new `useEffect` (anywhere among the other effects, e.g. after the result-geometry effect):

```ts
  // ── pet overlay: show/hide on enabled; apply pin + lock once shown. Main is
  //    the sole settings.json writer, so geometry is passed from settings.pet. ──
  useEffect(() => {
    const pet = settings?.pet;
    if (!pet) return;
    if (pet.enabled) {
      void showPetWindow({ x: pet.x, y: pet.y, w: pet.w, h: pet.h })
        .then(() => {
          void invoke("pet_set_always_on_top", { top: pet.always_on_top }).catch(logErr("pet always_on_top"));
          void invoke("pet_set_locked", { locked: pet.locked }).catch(logErr("pet locked"));
        })
        .catch(logErr("show pet"));
    } else {
      void hidePetWindow().catch(logErr("hide pet"));
    }
  }, [settings?.pet.enabled]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 4: Add live-apply effects for pin + lock**

Add two more effects:

```ts
  // ── live-apply pet pin when toggled in Settings (while enabled) ──
  useEffect(() => {
    const pet = settings?.pet;
    if (!pet?.enabled) return;
    void invoke("pet_set_always_on_top", { top: pet.always_on_top }).catch(logErr("pet always_on_top"));
  }, [settings?.pet.always_on_top]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── live-apply pet click-through lock when toggled in Settings (while enabled) ──
  useEffect(() => {
    const pet = settings?.pet;
    if (!pet?.enabled) return;
    void invoke("pet_set_locked", { locked: pet.locked }).catch(logErr("pet locked"));
  }, [settings?.pet.locked]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 5: Persist pet geometry on user move/resize**

Add a new effect (mirrors the result-geometry effect):

```ts
  // ── persist the pet window's geometry when the USER moves/resizes it (so a
  //    manual placement + size survives an app restart). Programmatic placements
  //    on show are suppressed in petWindow.ts. ──
  useEffect(() => {
    onPetGeometryChange((g) => {
      const cur = settingsRef.current;
      if (!cur) return;
      const patch: Partial<PetSettings> = {};
      if (g.x !== undefined) patch.x = g.x;
      if (g.y !== undefined) patch.y = g.y;
      if (g.w !== undefined) patch.w = g.w;
      if (g.h !== undefined) patch.h = g.h;
      update({ ...cur, pet: { ...cur.pet, ...patch } });
    });
  }, [update]);
```

- [ ] **Step 6: Reload settings on the tray `settings://changed` signal**

Add a new effect (the tray "桌宠" toggle emits this; main reloads from disk and re-applies — the `pet.enabled` effect then fires show/hide):

```ts
  // ── tray "桌宠" toggle (or any settings://changed) -> reload from disk. Main
  //    re-applies appearance + pet enabled state from the fresh settings. ──
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let alive = true;
    (async () => {
      un = await listen("settings://changed", async () => {
        const s = await loadSettings();
        if (!alive) return;
        settingsRef.current = s;
        setSettings(s);
        applyAppearanceVars(s.appearance);
      });
      if (!alive && un) un();
    })();
    return () => {
      alive = false;
      un?.();
    };
  }, []);
```

- [ ] **Step 7: Type-check + build**

Run (from project root):
```bash
pnpm exec tsc --noEmit && pnpm build
```
Expected: 0 errors; `dist/` produced.

- [ ] **Step 8: Commit**

```bash
git add src/components/CommandCard.tsx
git commit -m "feat(pet): wire show/hide + pin/lock + geometry + settings reload in CommandCard"
```

---

## Task 8: `SettingsPanel.tsx` "桌宠" section

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Add imports + `patchPet` helper**

In `src/components/SettingsPanel.tsx`, change the settings-types import and add the opener/path imports:

```ts
import type {
  AppSettings,
  AppearanceSettings,
  AiSettings,
  PetSettings,
  ResultAppearanceSettings,
  SearchSettings,
  WindowSettings,
} from "../features/settings/settingsTypes";
import { loadApiKey, saveApiKey, clearApiKey, testAiConnection } from "../features/settings/settingsStore";
import { SEARCH_ENGINES } from "../features/search/command";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import "./SettingsPanel.css";
```

In the component body, next to the other `patchX` helpers, add:

```ts
  const patchPet = (p: Partial<PetSettings>) =>
    onChange({ ...settings, pet: { ...settings.pet, ...p } });
```

- [ ] **Step 2: Add the "open folder" handler**

Add (near the other handlers, e.g. after `removeIgnoreDir`):

```ts
  /** Open the pet sprite dir in the file manager (created on demand by the
   *  backend `pet_assets_dir` command, so it always exists). The user drops
   *  idle.png / blink.png / happy.png here to swap art — no rebuild needed. */
  async function handleOpenPetFolder() {
    try {
      const dir = await invoke<string>("pet_assets_dir");
      await openPath(dir);
    } catch (e) {
      console.error("[bugzia] open pet folder", e);
    }
  }
```

- [ ] **Step 3: Add the section JSX**

Add a local alias next to `const r = settings.result;`:

```ts
  const a = settings.appearance;
  const r = settings.result;
  const ai = settings.ai;
  const pet = settings.pet;
```

Then add a new `<section>` inside `.settings-body` (e.g. right after the 搜索 section, before the closing `</div>` of `.settings-body`):

```tsx
          {/* ── 桌宠 ── */}
          <section className="settings-section">
            <h4>桌宠</h4>
            <label className="check-row">
              <input
                type="checkbox"
                checked={pet.enabled}
                onChange={(e) => patchPet({ enabled: e.target.checked })}
              />
              启用桌宠
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={pet.always_on_top}
                onChange={(e) => patchPet({ always_on_top: e.target.checked })}
              />
              置顶
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={pet.locked}
                onChange={(e) => patchPet({ locked: e.target.checked })}
              />
              锁定（鼠标穿透，不响应点击/拖动）
            </label>
            <ColorRow label="缩放" value={pet.scale} min={0.5} max={2} step={0.05}
              fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => patchPet({ scale: v })} />
            <ColorRow label="眨眼间隔" value={pet.blink_interval_ms} min={1000} max={10000} step={500}
              fmt={(v) => `${v}ms`} onChange={(v) => patchPet({ blink_interval_ms: v })} />
            <label className="check-row">
              <input
                type="checkbox"
                checked={pet.speech_enabled}
                onChange={(e) => patchPet({ speech_enabled: e.target.checked })}
              />
              随机说话
            </label>
            <ColorRow label="说话间隔" value={pet.speech_interval_ms} min={5000} max={60000} step={1000}
              fmt={(v) => `${(v / 1000).toFixed(0)}s`} onChange={(v) => patchPet({ speech_interval_ms: v })} />
            <Field label="口癖（每行一条）">
              <textarea
                className="f-input"
                rows={4}
                value={pet.speech_lines.join("\n")}
                onChange={(e) =>
                  patchPet({
                    speech_lines: e.target.value.split("\n").map((s) => s).filter((s, i, arr) => s !== "" || i < arr.length - 1),
                  })
                }
              />
              <div className="hint">点击桌宠或空闲时会随机冒一条。</div>
            </Field>
            <Field label="素材">
              <div className="list-add-row">
                <button className="key-btn" type="button" onClick={handleOpenPetFolder}>
                  打开素材文件夹…
                </button>
                <button
                  className="key-btn ghost"
                  type="button"
                  onClick={() => patchPet({ x: -1, y: -1 })}
                  title="下次显示时回到屏幕右下角"
                >
                  重置位置
                </button>
              </div>
              <div className="hint">
                把 idle.png / blink.png / happy.png 放进该文件夹即换肤，无需重启。缺失时显示占位图。
              </div>
            </Field>
          </section>
```

Note on the speech-lines textarea: the `.filter(...)` keeps blank lines except a trailing one, so the user's newlines round-trip cleanly without an ever-growing empty line. (`ColorRow` and `Field` already exist in this file.)

- [ ] **Step 4: Type-check + build**

Run (from project root):
```bash
pnpm exec tsc --noEmit && pnpm build
```
Expected: 0 errors; `dist/` produced.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(pet): add 桌宠 settings section (toggles, scale, speech, open-folder)"
```

---

## Task 9: Integration gate + manual runtime verification

**Files:** none (verification only)

- [ ] **Step 1: Full backend check**

Run (from `src-tauri/`):
```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo check && cargo test --lib
```
Expected: EXIT 0; all tests pass (including the two new pet tests).

- [ ] **Step 2: Full frontend check**

Run (from project root):
```bash
pnpm exec tsc --noEmit && pnpm build
```
Expected: 0 errors; `dist/` produced.

- [ ] **Step 3: Runtime manual matrix (`pnpm tauri dev`)**

Run `pnpm tauri dev`. For each item, verify the observed behavior:

1. Settings → 桌宠 → 启用: pet overlay appears at **lower-right** showing the pink **placeholder** SVG (no real art yet).
2. Hover the pet: the sprite subtly **translates toward the cursor**.
3. Click the pet: pose swaps to **happy** (~800ms) and a **speech bubble** appears (~2.5s).
4. Press-drag the pet >5px: the **window moves** (native drag); releasing leaves it where dropped. (Pose stays idle — v1 has no drag pose.)
5. Wait ~4s: the pet **blinks** (pose → blink ~150ms → idle), recurring.
6. Drag the window, then disable+re-enable: position **persisted** — re-enabling restores the dropped spot. Restart `pnpm tauri dev`: spot still restored.
7. Toggle 锁定 in Settings: mouse **clicks pass through** the pet to the desktop; the pet no longer reacts. Toggle off: interactions return.
8. Toggle 置顶 in Settings: pet stays above other windows when on, doesn't when off.
9. Tray → 桌宠: toggles enabled; the checkmark mirrors state; the overlay shows/hides.
10. Adjust 缩放: sprite resizes live. Adjust 眨眼间隔 / 说话间隔: timings change. Edit 口柄: new lines appear in bubbles.
11. Click 打开素材文件夹…: the OS file manager opens `${appDataDir}/pet` (empty). Drop a real `idle.png` there → the placeholder is replaced by the real image (may require a disable/enable cycle to retry after a prior load failure).
12. Click 重置位置, disable+enable: pet returns to lower-right.

- [ ] **Step 4: Asset-protocol fallback probe**

If step 1 or 11 shows the placeholder **even after** dropping a real PNG into `${appDataDir}/pet`, the asset scope variable may differ. Verify the dropped path matches the scope by checking the console for a 403 on the `asset.localhost` URL. If so, broaden the scope in `tauri.conf.json` to `["$APPDATA/pet/**", "$APPLOCALDATA/pet/**"]` and re-check. If still failing, switch `pet_assets_dir`'s dir to `app_config_dir()` and add `$APPCONFIG/pet/**` to the scope.

- [ ] **Step 5: Final commit (if any gate-fix edits were made)**

```bash
git add -A
git commit -m "chore(pet): integration gate fixes"
```
(Only if steps 1–4 surfaced edits. If all green with no edits, this step is a no-op.)

---

## Self-Review (run after writing)

**Spec coverage:**
- Render = DOM/CSS sprite swapper → Task 6. ✓
- 5 poses → v1 ships 3 (idle/blink/happy) — documented deviation at top of plan; drag/surprise explicitly deferred. ✓ (scope-adjusted, not a gap)
- Asset: `${appDataDir}/pet/{pose}.png` via `convertFileSrc` + SVG fallback → Tasks 2 (`pet_assets_dir`), 3 (asset scope), 6 (loader + fallback). ✓
- Click vs drag threshold → Task 6 (`isDrag` + pointer handlers). ✓
- Hover look → Task 6 (CSS vars). ✓
- Speech bubbles, user-editable lines → Tasks 1 (default lines), 6 (bubble), 8 (editor). ✓
- Window skeleton reuse → Task 5 (clone resultWindow). ✓
- Backend minimal (settings + 2 window cmds + tray) → Tasks 1, 2. ✓ (+ `pet_assets_dir`, a justified 3rd)
- Defaults (150×200, lower-right, always_on_top=true, locked=false, enabled=false) → Tasks 1, 5. ✓
- Gates (tsc / cargo check / pnpm build / tauri dev manual) → Task 9. ✓
- Backward-compat (legacy settings.json loads) → Task 1 test. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; the only "verify-or-fallback" is Task 9 Step 4 (a runtime probe with a concrete remediation — not a placeholder).

**Type/name consistency:** `PetSettings` fields match across Rust (`settings.rs`), TS (`settingsTypes.ts`), reducer, CommandCard, SettingsPanel. `showPetWindow`/`hidePetWindow`/`onPetGeometryChange`/`ensurePetWindow` match between `petWindow.ts` and `CommandCard.tsx`. Commands `pet_set_locked` / `pet_set_always_on_top` / `pet_assets_dir` match between `lib.rs` and the frontend `invoke` calls. Event names `settings:updated` / `settings://changed` match across `CommandCard.tsx`, tray, `SettingsWindow`, and `PetWindow.tsx`.
