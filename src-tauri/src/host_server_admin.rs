use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};
use tauri::State;

use crate::host_server::{is_server_running, HostServerState};

const SCRIPT_NAME: &str = "signaling-server.cjs";

fn admin_token_for_running(state: &HostServerState) -> Result<String, String> {
    if !is_server_running(state) {
        return Err("Server is not running.".into());
    }
    state
        .admin_token
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "Admin token unavailable.".into())
}

fn http_request(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|e| format!("Could not reach signaling server: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if let Some(token) = token {
        req.push_str("X-Admin-Token: ");
        req.push_str(token);
        req.push_str("\r\n");
    }
    if let Some(body) = body {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    req.push_str("\r\n");
    if let Some(body) = body {
        req.push_str(body);
    }

    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("Admin request failed: {e}"))?;

    let mut raw = String::new();
    stream
        .read_to_string(&mut raw)
        .map_err(|e| format!("Admin response failed: {e}"))?;

    let status = raw
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);

    let body_text = extract_response_body(&raw);

    Ok((status, body_text))
}

fn header_ends_at(raw: &str) -> Option<usize> {
    raw.find("\r\n\r\n")
        .or_else(|| raw.find("\n\n").map(|i| i + 1))
}

fn is_chunked_response(header_section: &str) -> bool {
    header_section
        .lines()
        .any(|line| {
            let lower = line.to_ascii_lowercase();
            lower.starts_with("transfer-encoding:") && lower.contains("chunked")
        })
}

fn decode_chunked_body(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body.trim_start_matches(['\r', '\n']);
    loop {
        let Some(line_end) = rest.find('\n') else {
            break;
        };
        let size_line = rest[..line_end].trim();
        let size = usize::from_str_radix(size_line, 16).unwrap_or(0);
        rest = &rest[line_end + 1..];
        if size == 0 {
            break;
        }
        if rest.len() < size {
            out.push_str(&rest[..rest.len().min(size)]);
            break;
        }
        out.push_str(&rest[..size]);
        rest = &rest[size..].trim_start_matches(['\r', '\n']);
    }
    out
}

fn extract_response_body(raw: &str) -> String {
    let Some(header_end) = header_ends_at(raw) else {
        return String::new();
    };
    let header_section = &raw[..header_end];
    let body = if raw.as_bytes().get(header_end..header_end + 4) == Some(b"\r\n\r\n") {
        &raw[header_end + 4..]
    } else {
        &raw[header_end + 2..]
    };
    if is_chunked_response(header_section) {
        decode_chunked_body(body)
    } else {
        body.to_string()
    }
}

fn admin_get_json(port: u16, token: &str, path: &str) -> Result<serde_json::Value, String> {
    let (status, text) = http_request(port, "GET", path, Some(token), None)?;
    if status == 200 {
        if text.is_empty() {
            return Ok(serde_json::json!({}));
        }
        return serde_json::from_str(&text).map_err(|e| format!("Invalid admin response: {e}"));
    }
    if status == 401 {
        return Err("Admin auth failed.".into());
    }
    Err(format!("Admin request failed (HTTP {status}): {text}"))
}

#[tauri::command]
pub fn host_admin_status(
    state: State<'_, HostServerState>,
    port: u16,
) -> Result<serde_json::Value, String> {
    let token = admin_token_for_running(&state)?;
    admin_get_json(port, &token, "/admin/status")
}

#[tauri::command]
pub fn host_admin_logs(
    state: State<'_, HostServerState>,
    port: u16,
    after: u64,
) -> Result<serde_json::Value, String> {
    let token = admin_token_for_running(&state)?;
    admin_get_json(port, &token, &format!("/admin/logs?after={after}"))
}

#[tauri::command]
pub fn host_admin_kick(
    state: State<'_, HostServerState>,
    port: u16,
    client_id: String,
) -> Result<(), String> {
    let token = admin_token_for_running(&state)?;
    let body = serde_json::json!({ "clientId": client_id }).to_string();
    let (status, text) = http_request(port, "POST", "/admin/kick", Some(&token), Some(&body))?;
    if status == 200 {
        return Ok(());
    }
    Err(format!("Kick failed (HTTP {status}): {text}"))
}

/// Wait until /health responds — no external HTTP client (safe inside Tauri commands).
pub fn wait_for_server_ready(port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Ok((status, text)) = http_request(port, "GET", "/health", None, None) {
            if status == 200 && text.contains("\"ok\"") {
                return Ok(());
            }
            if status == 401 {
                return Err(format!(
                    "Port {port} is in use by another server. Close it and try again."
                ));
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(
        "Server did not start. Install Node.js 24+ and try again. \
         See signaling-server.log in the app data folder."
            .into(),
    )
}

pub fn runtime_script_name() -> &'static str {
    SCRIPT_NAME
}
