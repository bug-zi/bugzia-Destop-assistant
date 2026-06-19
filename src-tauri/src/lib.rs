mod ai;
mod file_search;
mod settings;
mod weather;

use ai::{ask_once, ask_once_stream, chat, clear_context, get_messages, stop_chat, test_ai_connection};
use file_search::{open_file, reveal_file, search_files};
use settings::{clear_api_key, load_api_key, load_settings, save_api_key, save_settings};

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::{AutoLaunchManager, MacosLauncher};

/// Show + focus the main bar. Used by the global shortcut and the tray menu.
fn focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Pin (or unpin) the result overlay above every other window. Driven by the
/// result window's pin button. Implemented in Rust rather than the frontend
/// because the result window's capability (`capabilities/result.json`) lacks
/// `allow-set-always-on-top` — a backend command has full window access
/// regardless of the caller's ACL.
#[tauri::command]
fn set_result_always_on_top(app: AppHandle, top: bool) {
    if let Some(win) = app.get_webview_window("result") {
        let _ = win.set_always_on_top(top);
    }
}

/// Make the OS launch-on-boot state match the user's stored intent. Called at
/// startup so a user who disabled autostart stays disabled across restarts —
/// we never force-enable over their choice.
fn sync_autostart(app: &AppHandle) {
    let want = load_settings(app.clone())
        .map(|s| s.system.autostart)
        .unwrap_or(true);
    let mgr = app.state::<AutoLaunchManager>();
    let cur = mgr.is_enabled().unwrap_or(false);
    if want && !cur {
        let _ = mgr.enable();
    } else if !want && cur {
        let _ = mgr.disable();
    }
}

/// Build the system tray: show / autostart toggle / quit. The autostart item
/// starts checked to match the synced intent and re-syncs on every toggle.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let want_autostart = load_settings(app.clone())
        .map(|s| s.system.autostart)
        .unwrap_or(true);

    let show_item = MenuItem::with_id(app, "show", "显示 Bugzia", true, None::<&str>)?;
    let autostart_item =
        CheckMenuItem::with_id(app, "autostart", "开机自启", true, want_autostart, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    // Heterogeneous item types need an explicit `&[&dyn IsMenuItem]` coercion.
    let autostart_for_handler = autostart_item.clone();
    let items: &[&dyn IsMenuItem<Wry>] = &[&show_item, &autostart_item, &quit_item];
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
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Global shortcut: Alt+Space focuses the bar from anywhere (plan §8). The
    // handler fires on both press and release; focusing twice is harmless and
    // avoids depending on the ShortcutEvent state API.
    let global_shortcut = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcuts(["alt+space"])
        .expect("invalid global shortcut spec")
        .with_handler(|app, _shortcut, _event| {
            focus_main(app);
        })
        .build();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(global_shortcut)
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None::<Vec<&'static str>>,
        ))
        .manage(ai::ChatState::default())
        .setup(|app| {
            sync_autostart(app.handle());
            build_tray(app.handle())?;
            Ok(())
        })
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
