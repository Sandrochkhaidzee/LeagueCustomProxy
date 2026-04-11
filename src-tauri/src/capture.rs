use base64::Engine;
use std::sync::Mutex;
use tauri::State;

pub struct CaptureState {
    pub bounds: Mutex<Option<CaptureBounds>>,
}

#[derive(Clone, serde::Deserialize)]
pub struct CaptureBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(serde::Serialize)]
pub struct CaptureResult {
    pub data_url: String,
    pub width: i32,
    pub height: i32,
}

#[tauri::command]
pub fn set_capture_bounds(state: State<CaptureState>, bounds: CaptureBounds) {
    *state.bounds.lock().unwrap() = Some(bounds);
}

/// Capture a region of the screen using Win32 BitBlt.
/// Returns a base64-encoded BMP data URL.
///
/// This is a placeholder implementation that returns an error until
/// the Windows-specific capture code is tested on the target machine.
/// The actual implementation will use:
/// 1. GetDC(null) for desktop
/// 2. CreateCompatibleDC + CreateCompatibleBitmap
/// 3. BitBlt with crop coordinates
/// 4. GetDIBits for raw RGBA
/// 5. Encode as base64 data URL
#[tauri::command]
pub fn capture_minimap(state: State<CaptureState>) -> Result<CaptureResult, String> {
    let bounds = state.bounds.lock().unwrap();
    let _bounds = bounds
        .as_ref()
        .ok_or("Capture bounds not set. Call set_capture_bounds first.")?;

    // TODO: Implement actual Win32 BitBlt screen capture
    // This requires testing on a Windows machine with a display.
    // For now, return a 1x1 red pixel BMP as a proof-of-concept placeholder.
    let bmp_header: Vec<u8> = vec![
        0x42, 0x4D, // BM
        0x46, 0x00, 0x00, 0x00, // file size: 70 bytes
        0x00, 0x00, 0x00, 0x00, // reserved
        0x36, 0x00, 0x00, 0x00, // offset to pixel data: 54
        0x28, 0x00, 0x00, 0x00, // DIB header size: 40
        0x01, 0x00, 0x00, 0x00, // width: 1
        0x01, 0x00, 0x00, 0x00, // height: 1
        0x01, 0x00, // planes: 1
        0x18, 0x00, // bits per pixel: 24
        0x00, 0x00, 0x00, 0x00, // compression: none
        0x10, 0x00, 0x00, 0x00, // image size
        0x13, 0x0B, 0x00, 0x00, // x pixels per meter
        0x13, 0x0B, 0x00, 0x00, // y pixels per meter
        0x00, 0x00, 0x00, 0x00, // colors in table
        0x00, 0x00, 0x00, 0x00, // important colors
        // Pixel data (BGR): red pixel
        0x00, 0x00, 0xFF, 0x00, // 1 pixel + padding
    ];

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bmp_header);

    Ok(CaptureResult {
        data_url: format!("data:image/bmp;base64,{}", b64),
        width: 1,
        height: 1,
    })
}
