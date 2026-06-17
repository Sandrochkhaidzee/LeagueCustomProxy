use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::host_server_admin::{runtime_script_name, wait_for_server_ready};

pub struct HostServerState {
    child: Mutex<Option<Child>>,
    last_error: Mutex<Option<String>>,
    port: Mutex<u16>,
    pub(crate) admin_token: Mutex<Option<String>>,
    runtime_dir: Mutex<Option<PathBuf>>,
}

impl HostServerState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            last_error: Mutex::new(None),
            port: Mutex::new(0),
            admin_token: Mutex::new(None),
            runtime_dir: Mutex::new(None),
        }
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                kill_process_tree(child.id());
                let _ = child.wait();
            }
        }
        if let Ok(mut token) = self.admin_token.lock() {
            *token = None;
        }
    }
}

impl Drop for HostServerState {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(windows))]
fn kill_process_tree(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
}

#[derive(Serialize)]
pub struct SignalingServerStatus {
    pub running: bool,
    pub error: Option<String>,
    pub port: u16,
}

fn validate_port(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("Port must be between 1 and 65535.".into());
    }
    Ok(())
}

fn current_port(state: &HostServerState) -> u16 {
    state.port.lock().ok().map(|g| *g).unwrap_or(0)
}

pub(crate) fn is_server_running(state: &HostServerState) -> bool {
    state
        .child
        .lock()
        .ok()
        .map(|mut g| {
            if let Some(child) = g.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        *g = None;
                        clear_admin_token(state);
                        let msg = format!(
                            "Signaling server stopped (exit {:?}). See signaling-server.log.",
                            status.code()
                        );
                        if let Ok(mut err) = state.last_error.lock() {
                            *err = Some(msg);
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

fn clear_admin_token(state: &HostServerState) {
    if let Ok(mut token) = state.admin_token.lock() {
        *token = None;
    }
}

fn signaling_log_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|dir| {
        PathBuf::from(dir)
            .join("com.leagueproxy.server")
            .join("signaling-server.log")
    })
}

/// Bundled at compile time — single server.exe needs no extra folders.
const EMBEDDED_SIGNALING_SCRIPT: &[u8] =
    include_bytes!("../../server/dist/signaling-server.cjs");

fn write_embedded_script(dest: &PathBuf) -> Result<(), String> {
    std::fs::write(dest, EMBEDDED_SIGNALING_SCRIPT).map_err(|e| e.to_string())
}

/// Copy the bundled signaling script into app cache (works from a single server.exe).
pub fn init_runtime_dir(app: &AppHandle) -> Result<(), String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let runtime = cache.join("signaling");
    std::fs::create_dir_all(&runtime).map_err(|e| e.to_string())?;
    let dest = runtime.join(runtime_script_name());
    write_embedded_script(&dest)?;

    if let Ok(mut guard) = app.state::<HostServerState>().runtime_dir.lock() {
        *guard = Some(runtime);
    }
    Ok(())
}

fn runtime_dir(state: &HostServerState) -> Result<PathBuf, String> {
    state
        .runtime_dir
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "Signaling runtime not initialized.".into())
}

fn ensure_port_available(port: u16) -> Result<(), String> {
    let addr = format!("127.0.0.1:{port}");
    match TcpListener::bind(&addr) {
        Ok(_) => Ok(()),
        Err(_) => Err(format!(
            "Port {port} is already in use. Close any other server on that port and try again."
        )),
    }
}

fn new_admin_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    format!("{:032x}", nanos ^ (pid << 32))
}

fn spawn_signaling_child(
    runtime_dir: &PathBuf,
    port: u16,
    admin_token: &str,
) -> std::io::Result<Child> {
    let mut cmd = Command::new("node");
    cmd.arg(runtime_script_name())
        .current_dir(runtime_dir)
        .env("PORT", port.to_string())
        .env("ADMIN_TOKEN", admin_token)
        .stdin(Stdio::null())
        .stdout(Stdio::null());

    if let Some(log_path) = signaling_log_path() {
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_path)
        {
            cmd.stderr(Stdio::from(file));
        } else {
            cmd.stderr(Stdio::null());
        }
    } else {
        cmd.stderr(Stdio::null());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
}

#[tauri::command]
pub fn start_signaling_server(
    state: State<'_, HostServerState>,
    port: Option<u16>,
) -> Result<(), String> {
    if is_server_running(&state) {
        return Ok(());
    }

    let port = port.unwrap_or_else(|| current_port(&state));
    if port == 0 {
        return Err("Port is required.".into());
    }
    validate_port(port)?;
    ensure_port_available(port)?;

    let runtime = runtime_dir(&state)?;
    let script = runtime.join(runtime_script_name());
    if !script.exists() {
        return Err("Signaling server files missing. Restart the app.".into());
    }

    let admin_token = new_admin_token();
    let mut child = spawn_signaling_child(&runtime, port, &admin_token).map_err(|e| {
        let msg = format!(
            "Could not start server: {e}. Install Node.js 24+ from nodejs.org."
        );
        if let Ok(mut err) = state.last_error.lock() {
            *err = Some(msg.clone());
        }
        msg
    })?;

    if let Err(msg) = wait_for_server_ready(port) {
        let _ = child.kill();
        let _ = child.wait();
        if let Ok(mut err) = state.last_error.lock() {
            *err = Some(msg.clone());
        }
        return Err(msg);
    }

    if let Ok(mut guard) = state.port.lock() {
        *guard = port;
    }
    if let Ok(mut token) = state.admin_token.lock() {
        *token = Some(admin_token);
    }
    if let Ok(mut guard) = state.child.lock() {
        *guard = Some(child);
    }
    if let Ok(mut err) = state.last_error.lock() {
        *err = None;
    }
    Ok(())
}

#[tauri::command]
pub fn stop_signaling_server(state: State<'_, HostServerState>) {
    state.stop();
}

#[tauri::command]
pub fn signaling_server_status(state: State<'_, HostServerState>) -> SignalingServerStatus {
    let running = is_server_running(&state);
    let error = state
        .last_error
        .lock()
        .ok()
        .and_then(|g| g.clone());
    let port = current_port(&state);
    SignalingServerStatus {
        running,
        error,
        port,
    }
}

#[tauri::command]
pub fn set_signaling_port(state: State<'_, HostServerState>, port: u16) -> Result<(), String> {
    validate_port(port)?;
    if is_server_running(&state) {
        return Err("Stop the server before changing the port.".into());
    }
    if let Ok(mut guard) = state.port.lock() {
        *guard = port;
    }
    Ok(())
}
