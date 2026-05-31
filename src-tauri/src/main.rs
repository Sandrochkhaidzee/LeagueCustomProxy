#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod lcu;

use capture::CaptureState;
use std::sync::Mutex;
use tauri::Manager;

/// Reposition the overlay so the control panel sits immediately left of the
/// minimap and the (transparent) calibration region overlaps the minimap itself.
/// `x, y, width, height` describe the minimap's screen rect.
#[tauri::command]
fn position_overlay(app: tauri::AppHandle, x: f64, y: f64, width: f64, height: f64) {
    if let Some(window) = app.get_webview_window("overlay") {
        // Must match .panel width + #minimap-border margin-left in overlay.css
        const PANEL_WIDTH: f64 = 240.0;
        const PANEL_GAP: f64 = 4.0;

        let total_width = (PANEL_WIDTH + PANEL_GAP + width) as i32;
        let new_x = (x - PANEL_WIDTH - PANEL_GAP) as i32;

        let _ = window.set_position(tauri::PhysicalPosition::new(new_x, y as i32));
        let _ = window.set_size(tauri::PhysicalSize::new(total_width as u32, height as u32));
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
