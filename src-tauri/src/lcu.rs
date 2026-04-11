use serde::Serialize;
use std::path::PathBuf;
use sysinfo::System;

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub is_league_running: bool,
    pub is_in_game: bool,
    pub summoner_name: Option<String>,
    pub is_dead: bool,
    pub game_flow_phase: String,
}

/// Find LeagueClient.exe process and parse its lockfile for API credentials.
fn find_lockfile() -> Option<(u16, String)> {
    let sys = System::new_all();

    // Check if LeagueClient.exe is running
    let has_league = sys
        .processes()
        .values()
        .any(|p| p.name().to_string_lossy().contains("LeagueClient"));

    if !has_league {
        return None;
    }

    // Try standard lockfile locations
    let paths = [
        PathBuf::from(r"C:\Riot Games\League of Legends\lockfile"),
        PathBuf::from(r"D:\Riot Games\League of Legends\lockfile"),
    ];

    for path in &paths {
        if let Ok(content) = std::fs::read_to_string(path) {
            let parts: Vec<&str> = content.split(':').collect();
            if parts.len() >= 4 {
                if let Ok(port) = parts[2].parse::<u16>() {
                    return Some((port, parts[3].to_string()));
                }
            }
        }
    }
    None
}

#[tauri::command]
pub fn check_league_running() -> bool {
    find_lockfile().is_some()
}

#[tauri::command]
pub async fn get_game_state() -> GameState {
    let mut state = GameState {
        is_league_running: false,
        is_in_game: false,
        summoner_name: None,
        is_dead: false,
        game_flow_phase: "None".into(),
    };

    let lockfile = find_lockfile();
    state.is_league_running = lockfile.is_some();

    if let Some((port, password)) = &lockfile {
        // Check gameflow phase via LCU API
        if let Ok(client) = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
        {
            let url = format!(
                "https://127.0.0.1:{}/lol-gameflow/v1/gameflow-phase",
                port
            );
            if let Ok(resp) = client
                .get(&url)
                .basic_auth("riot", Some(password))
                .send()
                .await
            {
                if let Ok(phase) = resp.text().await {
                    let phase = phase.trim_matches('"').to_string();
                    state.is_in_game = phase == "InProgress";
                    state.game_flow_phase = phase;
                }
            }
        }
    }

    // If in game, get live data (no auth needed)
    if state.is_in_game {
        if let Ok(client) = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
        {
            if let Ok(resp) = client
                .get("https://127.0.0.1:2999/liveclientdata/allgamedata")
                .send()
                .await
            {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if let Some(player) = data.get("activePlayer") {
                        state.summoner_name = player
                            .get("riotId")
                            .or_else(|| player.get("summonerName"))
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        state.is_dead = player
                            .get("isDead")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                    }
                }
            }
        }
    }

    state
}

/// Get full live client data (all players, active player, events).
/// Only available during an active game on localhost:2999 with no auth.
#[tauri::command]
pub async fn get_live_client_data() -> Option<serde_json::Value> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .ok()?;

    client
        .get("https://127.0.0.1:2999/liveclientdata/allgamedata")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()
}

/// Read a text file from disk. Used for loading saved config/calibration.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}
