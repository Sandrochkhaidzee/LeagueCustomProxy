use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::host_server::{is_server_running, kill_process_tree, server_port, HostServerState};

const TUNNEL_URL_PREFIX: &str = "https://";
const TUNNEL_URL_SUFFIX: &str = ".trycloudflare.com";
const TUNNEL_START_TIMEOUT: Duration = Duration::from_secs(45);
const CLOUDFLARED_MISSING_MSG: &str =
    "cloudflared not found. Install it or set the path below.";

#[derive(Serialize)]
pub struct CloudflareTunnelStatus {
    pub running: bool,
    pub url: Option<String>,
    pub error: Option<String>,
}

fn cloudflared_on_path() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("where")
            .arg("cloudflared")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        Command::new("which")
            .arg("cloudflared")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

fn store_cloudflared_path(state: &HostServerState, path: Option<String>) {
    let trimmed = path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    if let Ok(mut guard) = state.cloudflared_path.lock() {
        *guard = trimmed;
    }
}

fn resolve_cloudflared(state: &HostServerState) -> Result<String, String> {
    if let Ok(custom) = state.cloudflared_path.lock() {
        if let Some(path) = custom.as_ref() {
            if Path::new(path).exists() {
                return Ok(path.clone());
            }
            return Err(format!("cloudflared not found at: {path}"));
        }
    }
    if cloudflared_on_path() {
        return Ok("cloudflared".into());
    }
    Err(CLOUDFLARED_MISSING_MSG.into())
}

fn spawn_cloudflared_child(binary: &str, port: u16) -> std::io::Result<Child> {
    let local_url = format!("http://127.0.0.1:{port}");
    let mut cmd = Command::new(binary);
    cmd.args([
        "tunnel",
        "--url",
        &local_url,
        "--protocol",
        "http2",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
}

fn is_valid_trycloudflare_host(host: &str) -> bool {
    !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn extract_tunnel_url(output: &str) -> Option<String> {
    let mut search_from = 0;
    while let Some(suffix_rel) = output[search_from..].find(TUNNEL_URL_SUFFIX) {
        let suffix_pos = search_from + suffix_rel;
        let before = &output[..suffix_pos];
        let start = before.rfind(TUNNEL_URL_PREFIX)?;
        let end = suffix_pos + TUNNEL_URL_SUFFIX.len();
        let candidate = &output[start..end];
        let host = &candidate[TUNNEL_URL_PREFIX.len()..candidate.len() - TUNNEL_URL_SUFFIX.len()];
        if is_valid_trycloudflare_host(host) {
            return Some(candidate.to_string());
        }
        search_from = end;
    }
    None
}

fn read_stream_lines(
    reader: impl BufRead + Send + 'static,
    output_buf: Arc<Mutex<String>>,
    url_tx: mpsc::Sender<String>,
) {
    thread::spawn(move || {
        for line in reader.lines().map_while(Result::ok) {
            let mut buf = output_buf.lock().unwrap_or_else(|e| e.into_inner());
            buf.push_str(&line);
            buf.push('\n');
            if let Some(url) = extract_tunnel_url(&buf) {
                let _ = url_tx.send(url);
                break;
            }
        }
    });
}

pub(crate) fn stop_tunnel(state: &HostServerState) {
    if let Ok(mut guard) = state.tunnel_child.lock() {
        if let Some(mut child) = guard.take() {
            kill_process_tree(child.id());
            let _ = child.wait();
        }
    }
    if let Ok(mut url) = state.tunnel_url.lock() {
        *url = None;
    }
}

pub(crate) fn is_tunnel_running(state: &HostServerState) -> bool {
    state
        .tunnel_child
        .lock()
        .ok()
        .map(|mut g| {
            if let Some(child) = g.as_mut() {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        *g = None;
                        if let Ok(mut url) = state.tunnel_url.lock() {
                            *url = None;
                        }
                        if let Ok(mut err) = state.tunnel_error.lock() {
                            if err.is_none() {
                                *err = Some("Cloudflare tunnel stopped unexpectedly.".into());
                            }
                        }
                        false
                    }
                    Ok(None) => true,
                    Err(_) => false,
                }
            } else {
                false
            }
        })
        .unwrap_or(false)
}

fn wait_for_tunnel_url(child: &mut Child) -> Result<String, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read cloudflared output.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read cloudflared output.".to_string())?;

    let output_buf = Arc::new(Mutex::new(String::new()));
    let (url_tx, url_rx) = mpsc::channel::<String>();

    read_stream_lines(
        BufReader::new(stdout),
        Arc::clone(&output_buf),
        url_tx.clone(),
    );
    read_stream_lines(BufReader::new(stderr), output_buf.clone(), url_tx);

    let deadline = Instant::now() + TUNNEL_START_TIMEOUT;
    loop {
        if let Ok(url) = url_rx.try_recv() {
            return Ok(url);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = output_buf.lock().map(|g| g.clone()).unwrap_or_default();
                return Err(format!(
                    "cloudflared exited before the tunnel was ready (exit {:?}). {}",
                    status.code(),
                    summarize_output(&output)
                ));
            }
            Ok(None) => {}
            Err(_) => {}
        }
        if Instant::now() >= deadline {
            let output = output_buf.lock().map(|g| g.clone()).unwrap_or_default();
            return Err(format!(
                "Timed out waiting for Cloudflare tunnel URL ({}s). {}",
                TUNNEL_START_TIMEOUT.as_secs(),
                summarize_output(&output)
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn summarize_output(output: &str) -> String {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(url) = extract_tunnel_url(trimmed) {
        return format!("Tunnel URL detected: {url}");
    }
    let tail: String = trimmed
        .lines()
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ");
    format!("Last output: {tail}")
}

#[tauri::command]
pub async fn pick_cloudflared_exe() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("Executable", &["exe"])
            .set_title("Select cloudflared")
            .pick_file()
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("File picker task failed: {e}"))
}

#[tauri::command]
pub fn set_cloudflared_path(
    state: State<'_, HostServerState>,
    path: Option<String>,
) -> Result<(), String> {
    if is_tunnel_running(&state) {
        return Err("Stop the server before changing the cloudflared path.".into());
    }
    store_cloudflared_path(&state, path);
    Ok(())
}

#[tauri::command]
pub fn start_cloudflare_tunnel(
    state: State<'_, HostServerState>,
    port: Option<u16>,
    cloudflared_path: Option<String>,
) -> Result<(), String> {
    if !is_server_running(&state) {
        return Err("Start the signaling server before opening a Cloudflare tunnel.".into());
    }

    if is_tunnel_running(&state) {
        if state
            .tunnel_url
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .is_some()
        {
            return Ok(());
        }
        stop_tunnel(&state);
    }

    store_cloudflared_path(&state, cloudflared_path);
    let binary = resolve_cloudflared(&state).map_err(|msg| {
        if let Ok(mut err) = state.tunnel_error.lock() {
            *err = Some(msg.clone());
        }
        msg
    })?;

    let port = port.unwrap_or_else(|| server_port(&state));
    if port == 0 {
        return Err("Port is required.".into());
    }

    if let Ok(mut err) = state.tunnel_error.lock() {
        *err = None;
    }
    if let Ok(mut url) = state.tunnel_url.lock() {
        *url = None;
    }

    let mut child = spawn_cloudflared_child(&binary, port).map_err(|e| {
        let msg = format!("Could not start cloudflared: {e}. {CLOUDFLARED_MISSING_MSG}");
        if let Ok(mut err) = state.tunnel_error.lock() {
            *err = Some(msg.clone());
        }
        msg
    })?;

    match wait_for_tunnel_url(&mut child) {
        Ok(url) => {
            if let Ok(mut guard) = state.tunnel_child.lock() {
                *guard = Some(child);
            }
            if let Ok(mut stored) = state.tunnel_url.lock() {
                *stored = Some(url);
            }
            if let Ok(mut err) = state.tunnel_error.lock() {
                *err = None;
            }
            Ok(())
        }
        Err(msg) => {
            kill_process_tree(child.id());
            let _ = child.wait();
            if let Ok(mut err) = state.tunnel_error.lock() {
                *err = Some(msg.clone());
            }
            Err(msg)
        }
    }
}

#[tauri::command]
pub fn cloudflare_tunnel_status(state: State<'_, HostServerState>) -> CloudflareTunnelStatus {
    let running = is_tunnel_running(&state);
    let url = state
        .tunnel_url
        .lock()
        .ok()
        .and_then(|g| g.clone());
    let error = state
        .tunnel_error
        .lock()
        .ok()
        .and_then(|g| g.clone());
    CloudflareTunnelStatus {
        running,
        url,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_trycloudflare_url_not_cloudflare_terms() {
        let output = "\
            https://www.cloudflare.com/website-terms/\n\
            2026-06-18T13:27:43Z INF | https://lucas-hay-since-lecture.trycloudflare.com |\n";
        assert_eq!(
            extract_tunnel_url(output),
            Some("https://lucas-hay-since-lecture.trycloudflare.com".into())
        );
    }
}
