use serde::Serialize;

const GITHUB_LATEST: &str = env!("PROXCHAT_GITHUB_LATEST");
const ALLOWED_DOWNLOAD_PREFIX: &str = env!("PROXCHAT_GITHUB_DOWNLOAD_PREFIX");
const UA: &str = "leagueproxy-updater";

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub download_url: Option<String>,
    pub notes: Option<String>,
}

fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.split('.')
            .map(|p| p.trim_start_matches(|c: char| !c.is_ascii_digit()).parse().unwrap_or(0))
            .collect()
    };
    parse(latest) > parse(current)
}

#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(GITHUB_LATEST)
        .header("User-Agent", UA)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;

    if !resp.status().is_success() {
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(
                "No GitHub release published yet — create a release with leagueproxy.exe attached"
                    .into(),
            );
        }
        return Err(format!("GitHub returned {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let tag = json["tag_name"]
        .as_str()
        .ok_or("missing tag_name")?
        .trim_start_matches('v')
        .to_string();

    let current = env!("CARGO_PKG_VERSION").to_string();

    let assets = json["assets"].as_array();
    let pick_named = |target: &str| -> Option<String> {
        assets.and_then(|arr| {
            arr.iter()
                .find(|a| {
                    a["name"]
                        .as_str()
                        .map(|n| n.eq_ignore_ascii_case(target))
                        .unwrap_or(false)
                })
                .and_then(|asset| asset["browser_download_url"].as_str())
                .map(String::from)
        })
    };
    let pick_any_exe = || -> Option<String> {
        assets.and_then(|arr| {
            arr.iter()
                .find(|a| {
                    a["name"]
                        .as_str()
                        .map(|n| n.to_lowercase().ends_with(".exe"))
                        .unwrap_or(false)
                })
                .and_then(|asset| asset["browser_download_url"].as_str())
                .map(String::from)
        })
    };
    let download_url = pick_named("leagueproxy.exe")
        .or_else(|| pick_named("lolproxchat.exe"))
        .or_else(pick_any_exe);

    let notes = json["body"].as_str().map(String::from);

    Ok(UpdateInfo {
        update_available: is_newer(&tag, &current),
        current_version: current,
        latest_version: tag,
        download_url,
        notes,
    })
}

#[tauri::command]
pub async fn download_and_apply_update(url: String) -> Result<(), String> {
    if !url.starts_with(ALLOWED_DOWNLOAD_PREFIX) {
        return Err(format!(
            "update url rejected — must start with {}",
            ALLOWED_DOWNLOAD_PREFIX
        ));
    }

    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = current_exe
        .parent()
        .ok_or("current exe has no parent directory")?;
    let current_name = current_exe
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("leagueproxy.exe")
        .to_string();
    let new_path = parent.join(format!("{}.new", current_name));

    let _ = std::fs::remove_file(&new_path);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header("User-Agent", UA)
        .send()
        .await
        .map_err(|e| format!("download error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("download returned {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() < 1_000_000 {
        return Err(format!(
            "download too small ({} bytes), aborting",
            bytes.len()
        ));
    }

    std::fs::write(&new_path, &bytes).map_err(|e| format!("write new exe: {}", e))?;

    let old_path_str = current_exe.to_string_lossy().to_string();
    std::process::Command::new(&new_path)
        .arg("--complete-update")
        .arg(&old_path_str)
        .spawn()
        .map_err(|e| format!("spawn new exe: {}", e))?;

    std::thread::sleep(std::time::Duration::from_millis(300));
    std::process::exit(0);
}

pub fn handle_complete_update_arg() {
    let args: Vec<String> = std::env::args().collect();
    let Some(idx) = args.iter().position(|a| a == "--complete-update") else {
        return;
    };
    let Some(old_path_str) = args.get(idx + 1) else {
        return;
    };
    let old_path = std::path::PathBuf::from(old_path_str);

    std::thread::sleep(std::time::Duration::from_millis(800));

    for _ in 0..5 {
        if std::fs::remove_file(&old_path).is_ok() || !old_path.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
    }

    if let Ok(current) = std::env::current_exe() {
        let is_dotnew = current
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.ends_with(".new"))
            .unwrap_or(false);
        if is_dotnew {
            let target = current.with_extension("");
            let _ = std::fs::rename(&current, &target);
        }
    }
}
