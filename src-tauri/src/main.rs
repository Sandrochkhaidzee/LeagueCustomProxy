#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod lcu;

use capture::CaptureState;
use std::sync::Mutex;

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
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
