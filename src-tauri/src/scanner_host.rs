use serde::Serialize;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn begin_scanner_calibration(app: AppHandle) -> Result<(), String> {
    let scanner = app
        .get_webview_window("scanner")
        .ok_or_else(|| "scanner window not found".to_string())?;
    scanner
        .set_ignore_cursor_events(false)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn end_scanner_calibration(app: AppHandle) -> Result<(), String> {
    let scanner = app
        .get_webview_window("scanner")
        .ok_or_else(|| "scanner window not found".to_string())?;
    scanner
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
pub struct ScreenBounds {
    pub screen_x: f64,
    pub screen_y: f64,
    pub screen_width: f64,
    pub screen_height: f64,
}

#[tauri::command]
pub fn get_scanner_screen_bounds(app: AppHandle) -> Result<ScreenBounds, String> {
    let scanner = app
        .get_webview_window("scanner")
        .ok_or_else(|| "scanner window not found".to_string())?;
    let pos = scanner.outer_position().map_err(|e| e.to_string())?;
    let size = scanner.outer_size().map_err(|e| e.to_string())?;
    Ok(ScreenBounds {
        screen_x: pos.x as f64,
        screen_y: pos.y as f64,
        screen_width: size.width as f64,
        screen_height: size.height as f64,
    })
}

#[tauri::command]
pub fn set_scanner_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let scanner = app
        .get_webview_window("scanner")
        .ok_or_else(|| "scanner window not found".to_string())?;
    scanner
        .set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
        .map_err(|e| e.to_string())?;
    scanner
        .set_size(tauri::PhysicalSize::new(width.max(40.0) as u32, height.max(40.0) as u32))
        .map_err(|e| e.to_string())?;
    Ok(())
}
