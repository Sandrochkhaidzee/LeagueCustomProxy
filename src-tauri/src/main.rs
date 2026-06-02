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

/// Open the directory that holds the rolling debug log in Explorer so the
/// user can grab the file and attach it to a GitHub issue.
#[tauri::command]
fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
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

// Hit-test box (in window-local px) for which clicks the overlay (panel)
// should actually receive — everything else passes through to the game.
static PANEL_HIT_RECT: Mutex<(i32, i32)> = Mutex::new((240, 400));

/// JS calls this whenever the panel resizes (settings expand, collapse, etc).
#[tauri::command]
fn set_panel_size(width: i32, height: i32) {
    *PANEL_HIT_RECT.lock().unwrap() = (width, height);
}

/// Position the scanner window directly over the minimap region.
/// `x, y, width, height` are physical screen pixels (from the BitBlt capture).
/// Also makes the scanner visible on the first call (it starts hidden).
#[tauri::command]
fn position_scanner(app: tauri::AppHandle, x: f64, y: f64, width: f64, height: f64) {
    let Some(window) = app.get_webview_window("scanner") else { return };
    let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
    let _ = window.set_size(tauri::PhysicalSize::new(width as u32, height as u32));
    let _ = window.show();
}

/// Hide the scanner window. Called when a session ends so the scanner isn't
/// floating mid-screen between games.
#[tauri::command]
fn hide_scanner(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("scanner") {
        let _ = window.hide();
    }
}

/// Toggle WDA_EXCLUDEFROMCAPTURE on the **scanner** window. Set true only
/// when Debug is on — that's the only case where the scanner paints into the
/// minimap region (HSV-filtered debug image) and would feed back into the next
/// BitBlt frame. The panel never carries this flag so ShadowPlay / Game Bar
/// always record normally.
#[tauri::command]
fn set_excluded_from_capture(app: tauri::AppHandle, excluded: bool) -> Result<(), String> {
    let window = app.get_webview_window("scanner").ok_or("no scanner window")?;
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
                // Rotate previous session logs so users who restart the app
                // before grabbing diagnostics don't lose the prior session.
                // Keeps up to 3 sessions: lolproxchat.log (current),
                // lolproxchat.1.log (previous), lolproxchat.2.log (oldest).
                let log_path = dir.join("lolproxchat.log");
                let log_1 = dir.join("lolproxchat.1.log");
                let log_2 = dir.join("lolproxchat.2.log");
                let _ = std::fs::remove_file(&log_2);
                let _ = std::fs::rename(&log_1, &log_2);
                let _ = std::fs::rename(&log_path, &log_1);
                let path = log_path;
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

            // Scanner is always click-through (never receives input).
            // WDA_EXCLUDEFROMCAPTURE is only applied to the scanner when Debug
            // turns on — keeping the panel free of that flag means ShadowPlay
            // and Win11 Game Bar record normally regardless of Debug state.
            if let Some(scanner) = app.get_webview_window("scanner") {
                let _ = scanner.set_ignore_cursor_events(true);
            }

            // Panel starts globally click-through too. The polling loop below
            // flips it off only when the cursor is over the panel hit-rect.
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
                use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
                use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};

                let mut last_ignore = true;
                loop {
                    // Skip the hit-test entirely while LMB is held: the user
                    // is mid-drag (or mid-click on a control), and toggling
                    // WS_EX_TRANSPARENT during Windows' native move loop
                    // kills the drag because hit-test returns HTTRANSPARENT
                    // on the next frame before GetWindowRect catches up.
                    let lmb_down = unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 };
                    if lmb_down {
                        tokio::time::sleep(Duration::from_millis(33)).await;
                        continue;
                    }

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
            position_scanner,
            hide_scanner,
            get_screen_size,
            set_panel_size,
            set_excluded_from_capture,
            append_log,
            open_log_folder,
            updater::check_for_update,
            updater::download_and_apply_update,
        ])
        // Closing the panel ("overlay") window should exit the whole app —
        // otherwise the scanner window (which is decorationless and
        // skip-taskbar) sits invisibly over the minimap with no way to
        // close it. Same applies in reverse: any window-close request
        // tears down the app cleanly.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
