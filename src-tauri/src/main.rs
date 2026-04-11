#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod lcu;

use capture::CaptureState;
use std::sync::Mutex;
use tauri::Manager;

/// Reposition the overlay window to sit above the minimap area.
/// Called from TypeScript with the minimap's screen coordinates.
#[tauri::command]
fn position_overlay(app: tauri::AppHandle, x: f64, y: f64, width: f64, _height: f64) {
    if let Some(window) = app.get_webview_window("overlay") {
        // Position overlay just above the minimap, right-aligned
        let overlay_width = 280.0;
        let overlay_height = 350.0;
        let new_x = x + width - overlay_width; // right-align with minimap
        let new_y = y - overlay_height - 10.0; // 10px gap above minimap

        let _ = window.set_position(tauri::PhysicalPosition::new(new_x as i32, new_y as i32));
        let _ = window.set_size(tauri::PhysicalSize::new(overlay_width as u32, overlay_height as u32));
    }
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
    tauri::Builder::default()
        .manage(CaptureState {
            bounds: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            capture::set_capture_bounds,
            capture::capture_minimap,
            lcu::check_league_running,
            lcu::get_game_state,
            lcu::get_live_client_data,
            lcu::read_text_file,
            position_overlay,
            get_screen_size,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
