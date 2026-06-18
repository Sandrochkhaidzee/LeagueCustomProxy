#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host_server;
mod host_server_admin;
mod host_tunnel;
mod updater;

use std::fs::File;
use std::io::Write;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

struct LogFile {
    file: Mutex<Option<File>>,
}

#[tauri::command]
fn append_log(state: tauri::State<LogFile>, line: String) {
    if let Ok(mut guard) = state.file.lock() {
        if let Some(f) = guard.as_mut() {
            let _ = writeln!(f, "{}", line);
            let _ = f.flush();
        }
    }
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<host_server::HostServerState>() {
        state.stop();
    }
    app.exit(0);
}

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

static PANEL_HIT_RECT: Mutex<(i32, i32)> = Mutex::new((240, 320));

#[tauri::command]
fn set_panel_size(width: i32, height: i32) {
    *PANEL_HIT_RECT.lock().unwrap() = (width, height);
}

#[tauri::command]
fn resize_overlay(app: tauri::AppHandle, height: u32) {
    let Some(window) = app.get_webview_window("overlay") else {
        return;
    };
    let clamped = height.clamp(100, 4000);
    let current_width = window
        .outer_size()
        .ok()
        .map(|s| s.width)
        .unwrap_or(260);
    let _ = window.set_size(tauri::PhysicalSize::new(current_width, clamped));
    let mut rect = PANEL_HIT_RECT.lock().unwrap();
    rect.1 = clamped as i32;
}

fn main() {
    updater::handle_complete_update_arg();

    tauri::Builder::default()
        .manage(LogFile {
            file: Mutex::new(None),
        })
        .manage(host_server::HostServerState::new())
        .setup(|app| {
            host_server::init_runtime_dir(&app.handle())?;

            if let Ok(dir) = app.path().app_local_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let log_path = dir.join("leagueproxy-server.log");
                if let Ok(file) = std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&log_path)
                {
                    if let Ok(mut guard) = app.state::<LogFile>().file.lock() {
                        *guard = Some(file);
                    }
                }
            }

            let Some(window) = app.get_webview_window("overlay") else {
                return Ok(());
            };

            let _ = window.set_ignore_cursor_events(true);

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
                    let lmb_down =
                        unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 };
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
            set_panel_size,
            resize_overlay,
            append_log,
            open_log_folder,
            exit_app,
            updater::check_for_update,
            updater::download_and_apply_update,
            host_server::start_signaling_server,
            host_server::stop_signaling_server,
            host_server::signaling_server_status,
            host_server::set_signaling_port,
            host_tunnel::start_cloudflare_tunnel,
            host_tunnel::cloudflare_tunnel_status,
            host_tunnel::set_cloudflared_path,
            host_tunnel::pick_cloudflared_exe,
            host_server_admin::host_admin_status,
            host_server_admin::host_admin_logs,
            host_server_admin::host_admin_kick,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.app_handle().try_state::<host_server::HostServerState>()
                {
                    state.stop();
                }
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!("tauri.server.conf.json"))
        .expect("error building leagueproxy-server")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<host_server::HostServerState>() {
                    state.stop();
                }
            }
        });
}
