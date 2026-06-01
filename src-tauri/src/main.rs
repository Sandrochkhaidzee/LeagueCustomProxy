#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod lcu;
mod updater;

use capture::CaptureState;
use std::fs::File;
use std::io::Write;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

/// Holds the open log file. Written to only when the frontend's Debug toggle
/// is on (the TS logging layer forwards each console call into append_log).
struct LogFile {
    file: Mutex<Option<File>>,
}

#[tauri::command]
fn append_log(state: tauri::State<LogFile>, line: String) {
    write_log_line(&state, line);
}

fn write_log_line(state: &tauri::State<LogFile>, line: String) {
    if let Ok(mut guard) = state.file.lock() {
        if let Some(f) = guard.as_mut() {
            let _ = writeln!(f, "{}", line);
            let _ = f.flush();
        }
    }
}

/// Write a `[rust]`-tagged line to the log file from non-frontend code paths
/// (the global-shortcut handler, setup hooks, etc).
fn rust_log<S: AsRef<str>>(app: &tauri::AppHandle, msg: S) {
    let Some(state) = app.try_state::<LogFile>() else { return };
    let Ok(mut guard) = state.file.lock() else { return };
    let Some(f) = guard.as_mut() else { return };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = writeln!(f, "{} [rust] {}", now, msg.as_ref());
    let _ = f.flush();
}

// Hit-test box (in window-local px) for which clicks the overlay should
// actually receive — everything else passes through to the game.
// Width includes the 4px gap to the calibration region so the panel border
// isn't a pixel-thin edge to land on.
static PANEL_HIT_RECT: Mutex<(i32, i32)> = Mutex::new((244, 400));

/// JS calls this whenever the panel resizes (settings expand, collapse, etc).
#[tauri::command]
fn set_panel_size(width: i32, height: i32) {
    *PANEL_HIT_RECT.lock().unwrap() = (width + 4, height);
}

/// Reposition the overlay so the control panel sits immediately left of the
/// minimap and the (transparent) calibration region overlaps the minimap itself.
/// `x, y, width, height` are physical screen pixels (from the BitBlt capture).
/// The PANEL_WIDTH/GAP constants are CSS pixels, so they must be scaled by the
/// monitor's DPI factor before being mixed with physical coordinates.
#[tauri::command]
fn position_overlay(app: tauri::AppHandle, x: f64, y: f64, width: f64, height: f64) {
    if let Some(window) = app.get_webview_window("overlay") {
        // Must match .panel width + #minimap-border margin-left in overlay.css (CSS px).
        const PANEL_WIDTH_CSS: f64 = 240.0;
        const PANEL_GAP_CSS: f64 = 4.0;

        let scale = window.scale_factor().unwrap_or(1.0);
        let panel_width_phys = PANEL_WIDTH_CSS * scale;
        let panel_gap_phys = PANEL_GAP_CSS * scale;

        let total_width = (panel_width_phys + panel_gap_phys + width) as i32;
        let new_x = (x - panel_width_phys - panel_gap_phys) as i32;

        let _ = window.set_position(tauri::PhysicalPosition::new(new_x, y as i32));
        let _ = window.set_size(tauri::PhysicalSize::new(total_width as u32, height as u32));
    }
}

/// Toggle WDA_EXCLUDEFROMCAPTURE on the overlay window. When `excluded` is
/// true the overlay becomes invisible to GDI BitBlt and most screen capture
/// software — which prevents the debug-paint feedback loop but also disables
/// recording in Nvidia ShadowPlay / Win11 Game Bar. Called from the frontend
/// when the user toggles Debug, so non-debug users keep ShadowPlay working.
#[tauri::command]
fn set_excluded_from_capture(app: tauri::AppHandle, excluded: bool) -> Result<(), String> {
    let window = app.get_webview_window("overlay").ok_or("no overlay window")?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };
    let affinity = if excluded { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
    unsafe {
        SetWindowDisplayAffinity(HWND(hwnd.0 as _), affinity)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Get screen dimensions for the primary monitor.
#[tauri::command]
fn get_screen_size() -> (u32, u32) {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN) as u32;
        let h = GetSystemMetrics(SM_CYSCREEN) as u32;
        (w, h)
    }
}

fn main() {
    // Handle the "--complete-update <old-path>" handoff before Tauri starts.
    // If we were launched by an in-flight self-update, this deletes the old
    // .exe and renames us from proxchat.exe.new → proxchat.exe.
    updater::handle_complete_update_arg();

    use tauri::Emitter;
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    tauri::Builder::default()
        .manage(CaptureState {
            bounds: Mutex::new(None),
        })
        .manage(LogFile {
            file: Mutex::new(None),
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    rust_log(app, format!("shortcut handler fired: state={:?}", event.state()));
                    // Rebuild shortcuts each call to avoid closure-capture/move issues.
                    // Comparison is cheap (struct of bitset + enum).
                    let toggle_mute = Shortcut::new(
                        Some(Modifiers::CONTROL | Modifiers::SHIFT),
                        Code::KeyM,
                    );
                    let ptt = Shortcut::new(None, Code::F8);
                    let payload: Option<&'static str> = if shortcut == &toggle_mute {
                        if event.state() == ShortcutState::Pressed { Some("toggleMute") } else { None }
                    } else if shortcut == &ptt {
                        Some(if event.state() == ShortcutState::Pressed { "pttDown" } else { "pttUp" })
                    } else {
                        None
                    };
                    if let Some(p) = payload {
                        let result = app.emit("global_shortcut", p);
                        rust_log(app, format!("emit({}) → {:?}", p, result.map_err(|e| e.to_string())));
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Open the log file once at startup (truncated each session).
            // The TS layer only writes to it while Debug is on.
            if let Ok(dir) = app.path().app_local_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let path = dir.join("proxchat.log");
                if let Ok(file) = std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&path)
                {
                    if let Ok(mut guard) = app.state::<LogFile>().file.lock() {
                        *guard = Some(file);
                    }
                    println!("[proxchat] log file: {}", path.display());
                }
            }

            // Register the global shortcuts now that the plugin is initialized.
            // F8 (PTT) and Ctrl+Shift+M (toggle self-mute).
            let gs = app.global_shortcut();
            let r1 = gs.register(Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyM));
            let r2 = gs.register(Shortcut::new(None, Code::F8));
            rust_log(&app.handle(), format!(
                "register Ctrl+Shift+M → {:?}, F8 → {:?}",
                r1.as_ref().map(|_| "ok").map_err(|e| e.to_string()),
                r2.as_ref().map(|_| "ok").map_err(|e| e.to_string()),
            ));

            let Some(window) = app.get_webview_window("overlay") else {
                return Ok(());
            };

            // NOTE: WDA_EXCLUDEFROMCAPTURE is intentionally NOT set at startup.
            // Setting it permanently causes Nvidia ShadowPlay / Win11 Game Bar
            // to treat the overlay as protected content and disable game
            // recording entirely (issue #2). It's only needed when Debug paints
            // the HSV-filtered image into the calibration region, which would
            // otherwise feed back into the next BitBlt frame. The overlay
            // toggles this flag via `set_excluded_from_capture` when the user
            // flips Debug on/off.

            // Start globally click-through. The polling loop below flips it
            // off only when the cursor is over the panel region.
            let _ = window.set_ignore_cursor_events(true);

            // Stash the HWND as an integer — the windows::HWND type wraps a raw
            // pointer that isn't Send, so we can't hold it across an await.
            let hwnd_addr: isize = match window.hwnd() {
                Ok(h) => h.0 as isize,
                Err(_) => return Ok(()),
            };
            let window_for_loop = window.clone();
            tauri::async_runtime::spawn(async move {
                use windows::Win32::Foundation::{HWND, POINT, RECT};
                use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};

                let mut last_ignore = true;
                loop {
                    let mut cursor = POINT::default();
                    let mut win_rect = RECT::default();
                    let ok = unsafe {
                        let hwnd = HWND(hwnd_addr as *mut _);
                        GetCursorPos(&mut cursor).is_ok()
                            && GetWindowRect(hwnd, &mut win_rect).is_ok()
                    };

                    if ok {
                        let (pw, ph) = *PANEL_HIT_RECT.lock().unwrap();
                        let over_panel = cursor.x >= win_rect.left
                            && cursor.x < win_rect.left + pw
                            && cursor.y >= win_rect.top
                            && cursor.y < win_rect.top + ph;

                        let should_ignore = !over_panel;
                        if should_ignore != last_ignore {
                            let _ = window_for_loop.set_ignore_cursor_events(should_ignore);
                            last_ignore = should_ignore;
                        }
                    }

                    tokio::time::sleep(Duration::from_millis(33)).await;
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture::set_capture_bounds,
            capture::capture_minimap,
            lcu::check_league_running,
            lcu::get_game_state,
            lcu::get_live_client_data,
            lcu::read_text_file,
            lcu::get_league_install_dir,
            position_overlay,
            get_screen_size,
            set_panel_size,
            set_excluded_from_capture,
            append_log,
            updater::check_for_update,
            updater::download_and_apply_update,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
