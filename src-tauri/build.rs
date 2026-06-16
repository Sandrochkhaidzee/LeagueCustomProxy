fn main() {
    let repo = std::env::var("GITHUB_REPOSITORY").unwrap_or_else(|_| {
        let owner = std::env::var("GITHUB_REPO_OWNER").unwrap_or_else(|_| "Sandrochkhaidzee".into());
        let name = std::env::var("GITHUB_REPO_NAME").unwrap_or_else(|_| "LeagueCustomProxy".into());
        format!("{}/{}", owner, name)
    });
    let (owner, name) = {
        let mut parts = repo.splitn(2, '/');
        (
            parts.next().unwrap_or("Sandrochkhaidzee").to_string(),
            parts.next().unwrap_or("LeagueCustomProxy").to_string(),
        )
    };
    println!(
        "cargo:rustc-env=PROXCHAT_GITHUB_LATEST=https://api.github.com/repos/{}/{}/releases/latest",
        owner, name
    );
    println!(
        "cargo:rustc-env=PROXCHAT_GITHUB_DOWNLOAD_PREFIX=https://github.com/{}/{}/releases/download/",
        owner, name
    );
    tauri_build::build();
}
