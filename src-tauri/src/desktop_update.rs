use crate::model::{error, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use url::Url;

const MANIFEST_LIMIT: usize = 64 * 1024;
const NOTES_LIMIT: usize = 8 * 1024;

#[derive(Serialize)]
pub(crate) struct Offer {
    platform: &'static str,
    version: String,
    notes: Option<String>,
}

fn configuration_error() -> crate::model::AppError {
    error(
        "update_configuration",
        "The desktop update channel is not configured correctly.",
    )
}

fn invalid_metadata() -> crate::model::AppError {
    error(
        "update_metadata",
        "The desktop update information could not be verified.",
    )
}

fn metadata_endpoint(value: Option<&str>) -> Result<Option<Url>> {
    let Some(value) = value else { return Ok(None) };
    let url = Url::parse(value).map_err(|_| configuration_error())?;
    if !value.starts_with("https://")
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
        || !is_https_url(&url)
        || !matches!(
            url.host_str(),
            Some("scratchtree.barbajoe.tech" | "scratchtree.netlify.app")
        )
        || url.path() == "/"
        || url.query().is_some()
    {
        return Err(configuration_error());
    }
    Ok(Some(url))
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
fn probe_endpoint(value: Option<&str>) -> Result<Option<Url>> {
    let Some(value) = value else { return Ok(None) };
    let url = Url::parse(value).map_err(|_| configuration_error())?;
    if !value.starts_with("http://127.0.0.1:")
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none_or(|port| port < 1024)
        || url.path() != "/mac.json"
        || url.as_str() != value
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(configuration_error());
    }
    Ok(Some(url))
}

fn is_https_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn parse_metadata<'a, T: Deserialize<'a>>(body: &'a [u8]) -> Result<T> {
    if body.len() > MANIFEST_LIMIT {
        return Err(invalid_metadata());
    }
    serde_json::from_slice(body).map_err(|_| invalid_metadata())
}

fn validate_notes(notes: Option<&str>) -> Result<()> {
    if notes.is_some_and(|value| {
        value.len() > NOTES_LIMIT
            || value
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\t' | '\r' | '\n'))
    }) {
        return Err(invalid_metadata());
    }
    Ok(())
}

fn is_newer_release(candidate: &Version, current: &Version) -> bool {
    candidate.pre.is_empty()
        && candidate.build.is_empty()
        && candidate.cmp_precedence(current).is_gt()
}

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchRelease {
    platform: String,
    package: String,
    version: String,
    notes: Option<String>,
}

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
fn arch_offer(body: &[u8], current: &Version) -> Result<Option<Offer>> {
    let release: ArchRelease = parse_metadata(body)?;
    if release.platform != "linux-x86_64" || release.package != "scratchtree-preview" {
        return Err(invalid_metadata());
    }
    let version = Version::parse(&release.version).map_err(|_| invalid_metadata())?;
    validate_notes(release.notes.as_deref())?;
    Ok(is_newer_release(&version, current).then_some(Offer {
        platform: "arch",
        version: release.version,
        notes: release.notes,
    }))
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MacRelease {
    version: Version,
    notes: Option<String>,
    platforms: MacPlatforms,
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MacPlatforms {
    #[serde(rename = "darwin-aarch64")]
    apple_silicon: MacArtifact,
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct MacArtifact {
    url: String,
    signature: String,
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
impl MacRelease {
    fn parse(body: &[u8], probe: Option<&Url>) -> Result<Self> {
        let release: Self = parse_metadata(body)?;
        validate_notes(release.notes.as_deref())?;
        let MacArtifact { url, signature } = &release.platforms.apple_silicon;
        let version = &release.version;
        let file = format!("Scratchtree-{version}-aarch64.app.tar.gz");
        let expected = if let Some(endpoint) = probe {
            endpoint
                .join(&format!("/v{version}/{file}"))
                .map_err(|_| invalid_metadata())?
                .to_string()
        } else {
            format!("https://github.com/Barbacoa08/scratchtree/releases/download/v{version}/{file}")
        };
        if *url != expected
            || signature.is_empty()
            || signature.len() > 4096
            || !signature
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        {
            return Err(invalid_metadata());
        }
        Ok(release)
    }
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Default)]
struct MacOffers {
    // Keep the most recent artifact pinned even if a later check has no offer.
    latest: Option<MacRelease>,
    available: bool,
    installed: bool,
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
impl MacOffers {
    fn record(&mut self, release: Option<MacRelease>) -> Result<()> {
        if self.installed {
            return Err(update_in_progress());
        }
        let Some(release) = release else {
            self.available = false;
            return Ok(());
        };
        if self.latest.as_ref().is_some_and(|existing| {
            release.version.cmp_precedence(&existing.version).is_lt()
                || (existing.version == release.version
                    && existing.platforms.apple_silicon != release.platforms.apple_silicon)
        }) {
            return Err(invalid_metadata());
        }
        self.latest = Some(release);
        self.available = true;
        Ok(())
    }

    fn for_install(&self, version: &str) -> Result<&MacRelease> {
        if self.available && !self.installed {
            if let Some(offer) = &self.latest {
                if offer.version.to_string() == version {
                    return Ok(offer);
                }
            }
        }
        Err(error(
            "update_stale",
            "Check for updates again before installing.",
        ))
    }

    fn finish_install(&mut self) {
        self.available = false;
        self.installed = true;
    }
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
fn update_in_progress() -> crate::model::AppError {
    error(
        "update_busy",
        "A desktop update operation is already in progress.",
    )
}

use std::time::Duration;
use tauri::AppHandle;

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);

#[tauri::command]
pub(crate) async fn desktop_update_check(app: AppHandle) -> Result<Option<Offer>> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return mac::check(app).await;

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        if app.config().identifier != "tech.barbajoe.scratchtree.preview" {
            return Ok(None);
        }
        let Some(endpoint) = metadata_endpoint(option_env!("SCRATCHTREE_ARCH_UPDATE_ENDPOINT"))?
        else {
            return Ok(None);
        };
        match fetch_manifest(endpoint).await? {
            Some(body) => arch_offer(&body, &app.package_info().version),
            None => Ok(None),
        }
    }

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    {
        let _ = app;
        Ok(None)
    }
}

#[tauri::command]
pub(crate) async fn desktop_update_install(app: AppHandle, version: String) -> Result<()> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return mac::install(app, version).await;

    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        let _ = (app, version);
        Err(error(
            "update_unavailable",
            "In-app installation is unavailable on this device.",
        ))
    }
}

async fn fetch_manifest(endpoint: Url) -> Result<Option<Vec<u8>>> {
    let mut builder = reqwest::Client::builder()
        .https_only(endpoint.scheme() == "https")
        .redirect(reqwest::redirect::Policy::none());
    if endpoint.scheme() == "http" {
        builder = builder.no_proxy();
    }
    let client = builder
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|_| check_failed())?;
    let response = client
        .get(endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, "Scratchtree Desktop Updater")
        .send()
        .await
        .map_err(|_| check_failed())?;
    match response.status() {
        reqwest::StatusCode::NO_CONTENT => Ok(None),
        reqwest::StatusCode::OK => read_bounded(response, MANIFEST_LIMIT)
            .await
            .map(Some)
            .map_err(|_| invalid_metadata()),
        _ => Err(check_failed()),
    }
}

async fn read_bounded(
    mut response: reqwest::Response,
    limit: usize,
) -> std::result::Result<Vec<u8>, ()> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if chunk.len() > limit - bytes.len() {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn check_failed() -> crate::model::AppError {
    error(
        "update_check_failed",
        "Scratchtree could not check for desktop updates. Try again.",
    )
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub(crate) mod mac {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use std::collections::HashSet;
    use std::ffi::OsStr;
    use std::fs::{self, File, TryLockError};
    use std::io::{Cursor, Read};
    use std::os::unix::fs::MetadataExt;
    use std::path::{Component, Path, PathBuf};
    use std::sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    };
    use tauri::{async_runtime::Mutex, ExitRequestApi, Manager};
    use tauri_plugin_updater::{Update, UpdaterExt};

    const RELEASE_ID: &str = "tech.barbajoe.scratchtree";
    const PROBE_ID: &str = "tech.barbajoe.scratchtree.updater-probe";
    const MAC_TARGET: &str = "darwin-aarch64";
    const ARCHIVE_LIMIT: usize = 128 * 1024 * 1024;
    const UNPACKED_LIMIT: u64 = 512 * 1024 * 1024;
    const ARCHIVE_PATH_LIMIT: usize = 4096;
    const ARCHIVE_ENTRY_LIMIT: usize = 4096;
    const RUNNING: u8 = 0;
    const REPLACING: u8 = 1;
    const EXITING: u8 = 2;
    const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);

    #[derive(Default)]
    struct State {
        offers: Arc<Mutex<MacOffers>>,
        lifecycle: AtomicU8,
    }

    pub(crate) fn defer_exit(app: &AppHandle, api: &ExitRequestApi) -> bool {
        let state = app.state::<State>();
        if state
            .lifecycle
            .compare_exchange(RUNNING, EXITING, Ordering::AcqRel, Ordering::Acquire)
            == Err(REPLACING)
        {
            api.prevent_exit();
            return true;
        }
        false
    }

    struct Replacing<'a>(&'a AtomicU8);

    impl<'a> Replacing<'a> {
        fn begin(lifecycle: &'a AtomicU8) -> Result<Self> {
            lifecycle
                .compare_exchange(RUNNING, REPLACING, Ordering::AcqRel, Ordering::Acquire)
                .map_err(|_| update_in_progress())?;
            Ok(Self(lifecycle))
        }
    }

    impl Drop for Replacing<'_> {
        fn drop(&mut self) {
            self.0.store(RUNNING, Ordering::Release);
        }
    }

    struct Channel {
        identifier: &'static str,
        endpoint: Url,
        key: &'static str,
        executable: PathBuf,
    }

    impl Channel {
        fn probe_endpoint(&self) -> Option<&Url> {
            (self.identifier == PROBE_ID).then_some(&self.endpoint)
        }
    }

    pub(crate) fn configure(
        builder: tauri::Builder<tauri::Wry>,
        context: &mut tauri::Context<tauri::Wry>,
    ) -> tauri::Builder<tauri::Wry> {
        // The plugin's JS permissions are not granted. Only the commands above use it.
        let is_probe = context.config().identifier == PROBE_ID;
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": "",
                "requireSignedVersion": true,
                "dangerousInsecureTransportProtocol": is_probe
            }),
        );
        builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .manage(State::default())
    }

    fn channel(app: &AppHandle) -> Result<Option<Channel>> {
        let configured = option_env!("SCRATCHTREE_MAC_UPDATE_ENDPOINT");
        let (identifier, endpoint) = match app.config().identifier.as_str() {
            RELEASE_ID => (RELEASE_ID, metadata_endpoint(configured)?),
            PROBE_ID => (PROBE_ID, probe_endpoint(configured)?),
            _ => return Ok(None),
        };
        let key = option_env!("SCRATCHTREE_MAC_UPDATE_PUBKEY");
        let (endpoint, key) = match (endpoint, key) {
            (None, None) => return Ok(None),
            (Some(endpoint), Some(key)) => (endpoint, key),
            _ => return Err(configuration_error()),
        };
        let decoded = BASE64.decode(key).map_err(|_| configuration_error())?;
        let public_key = std::str::from_utf8(&decoded).map_err(|_| configuration_error())?;
        minisign_verify::PublicKey::decode(public_key).map_err(|_| configuration_error())?;
        let executable = std::env::current_exe().map_err(|_| configuration_error())?;
        if !is_bundled_app(&executable) {
            return Ok(None);
        }
        Ok(Some(Channel {
            identifier,
            endpoint,
            key,
            executable,
        }))
    }

    fn is_bundled_app(executable: &Path) -> bool {
        let Some(macos) = executable.parent() else {
            return false;
        };
        let Some(contents) = macos.parent() else {
            return false;
        };
        macos.file_name() == Some(OsStr::new("MacOS"))
            && contents.file_name() == Some(OsStr::new("Contents"))
            && contents.parent().and_then(Path::extension) == Some(OsStr::new("app"))
    }

    pub(super) async fn check(app: AppHandle) -> Result<Option<Offer>> {
        let Some(channel) = channel(&app)? else {
            return Ok(None);
        };
        let state = app.state::<State>();
        let mut offers = state.offers.try_lock().map_err(|_| update_in_progress())?;
        if offers.installed {
            return Err(update_in_progress());
        }
        let body = fetch_manifest(channel.endpoint.clone()).await?;
        let release = body
            .as_deref()
            .map(|body| MacRelease::parse(body, channel.probe_endpoint()))
            .transpose()?
            .filter(|release| is_newer_release(&release.version, &app.package_info().version));
        let offer = release.as_ref().map(|release| Offer {
            platform: "mac",
            version: release.version.to_string(),
            notes: release.notes.clone(),
        });
        offers.record(release)?;
        Ok(offer)
    }

    pub(super) async fn install(app: AppHandle, version: String) -> Result<()> {
        let Some(channel) = channel(&app)? else {
            return Err(error(
                "update_unavailable",
                "In-app installation is unavailable on this device.",
            ));
        };
        let state = app.state::<State>();
        let mut offers = Arc::clone(&state.offers)
            .try_lock_owned()
            .map_err(|_| update_in_progress())?;
        let release = offers.for_install(&version)?;
        let install_lock = lock_install(&channel.executable)?;
        let running = app.package_info().version.clone();
        verify_current_bundle(
            &install_lock,
            &channel.executable,
            channel.identifier,
            &running,
        )?;
        let expected = release.version.clone();
        let update = restore_update(&app, release, &channel)?;
        let bytes =
            download_archive(&update.download_url, channel.probe_endpoint().is_some()).await?;
        // Hold both locks through replacement even if the caller goes away. Tauri's
        // installer can call macOS authorization on the main thread.
        tauri::async_runtime::spawn_blocking(move || {
            update.verify(&bytes).map_err(|_| install_failed())?;
            inspect_archive(&bytes, channel.identifier, &expected)?;
            let state = app.state::<State>();
            let replacing = Replacing::begin(&state.lifecycle)?;
            verify_current_bundle(&install_lock, &channel.executable, channel.identifier, &running)?;
            if let Err(failure) = update.install(bytes) {
                if let tauri_plugin_updater::Error::PreviousAppNotRestored(path) = failure {
                    offers.finish_install();
                    return Err(error(
                        "update_manual_recovery",
                        &format!(
                            "The previous application was preserved at {}. Restore that copy or reinstall using the Mac download.",
                            path.display()
                        ),
                    ));
                }
                return Err(install_failed());
            }
            offers.finish_install();
            drop(replacing);
            app.request_restart();
            Ok(())
        })
        .await
        .map_err(|_| install_failed())?
    }

    fn restore_update(app: &AppHandle, release: &MacRelease, channel: &Channel) -> Result<Update> {
        let updater = app
            .updater_builder()
            .target(MAC_TARGET)
            .pubkey(channel.key)
            .executable_path(channel.executable.clone())
            .version_comparator(|current, release| is_newer_release(&release.version, &current))
            .endpoints(vec![channel.endpoint.clone()])
            .and_then(|builder| builder.build())
            .map_err(|_| configuration_error())?;
        // Tauri's restore path forces signature verification to bind the archive
        // to the announced version, including when feed metadata has been modified.
        updater
            .restore_update(serde_json::to_value(release).map_err(|_| invalid_metadata())?)
            .map_err(|_| invalid_metadata())?
            .ok_or_else(invalid_metadata)
    }

    async fn download_archive(url: &Url, is_probe: bool) -> Result<Vec<u8>> {
        let redirects = reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            if attempt.previous().len() == 1
                && is_https_url(url)
                && url.host_str() == Some("release-assets.githubusercontent.com")
            {
                attempt.follow()
            } else {
                attempt.error("Unexpected update archive redirect")
            }
        });
        let builder = reqwest::Client::builder().https_only(!is_probe);
        let builder = if is_probe {
            builder
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
        } else {
            builder.redirect(redirects)
        };
        let client = builder
            .timeout(DOWNLOAD_TIMEOUT)
            .build()
            .map_err(|_| install_failed())?;
        let response = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "application/octet-stream")
            .header(reqwest::header::USER_AGENT, "Scratchtree Desktop Updater")
            .send()
            .await
            .map_err(|_| install_failed())?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(install_failed());
        }
        read_bounded(response, ARCHIVE_LIMIT)
            .await
            .map_err(|_| install_failed())
    }

    fn inspect_archive(bytes: &[u8], identifier: &str, version: &Version) -> Result<()> {
        let decoder = flate2::read::GzDecoder::new(bytes);
        let mut archive = tar::Archive::new(decoder.take(UNPACKED_LIMIT));
        let mut plist_found = false;
        let mut executable_found = false;
        let mut paths = HashSet::new();
        let info_path = Path::new("Scratchtree.app/Contents/Info.plist");
        let executable_path = Path::new("Scratchtree.app/Contents/MacOS/scratchtree");
        let entries = archive.entries().map_err(|_| install_failed())?;
        for entry in entries {
            let mut entry = entry.map_err(|_| install_failed())?;
            let path = entry.path().map_err(|_| install_failed())?;
            let mut components = path.components();
            let kind = entry.header().entry_type();
            if components.next() != Some(Component::Normal(OsStr::new("Scratchtree.app")))
                || !components.all(|part| matches!(part, Component::Normal(_)))
                || (!kind.is_dir() && !kind.is_file())
                || (path == Path::new("Scratchtree.app") && !kind.is_dir())
            {
                return Err(install_failed());
            }
            let normalized = path.components().collect::<PathBuf>();
            let name = normalized.as_os_str().as_encoded_bytes();
            if paths.len() == ARCHIVE_ENTRY_LIMIT
                || name.len() > ARCHIVE_PATH_LIMIT
                || !name.iter().all(|byte| (b' '..=b'~').contains(byte))
            {
                return Err(install_failed());
            }
            let folded = name.to_ascii_lowercase();
            let aliases_critical = match folded.as_slice() {
                b"scratchtree.app/contents/info.plist" => path != info_path,
                b"scratchtree.app/contents/macos/scratchtree" => path != executable_path,
                _ => false,
            };
            if aliases_critical || !paths.insert(folded) {
                return Err(install_failed());
            }
            if path == info_path {
                if plist_found || !kind.is_file() || entry.size() > MANIFEST_LIMIT as u64 {
                    return Err(install_failed());
                }
                let mut data = Vec::new();
                entry.read_to_end(&mut data).map_err(|_| install_failed())?;
                let bundle: InstalledBundle =
                    plist::from_reader(Cursor::new(data)).map_err(|_| install_failed())?;
                if !bundle.matches(identifier, version) || bundle.executable != "scratchtree" {
                    return Err(install_failed());
                }
                plist_found = true;
            } else if path == executable_path {
                if executable_found
                    || !kind.is_file()
                    || entry.header().mode().map_err(|_| install_failed())? & 0o111 == 0
                    || !is_arm64_executable(&mut entry)
                {
                    return Err(install_failed());
                }
                executable_found = true;
            }
        }
        if !plist_found || !executable_found || archive.into_inner().limit() == 0 {
            return Err(install_failed());
        }
        Ok(())
    }

    fn is_arm64_executable<R: Read>(entry: &mut tar::Entry<'_, R>) -> bool {
        let mut header = [0u8; 32];
        if entry.read_exact(&mut header).is_err() {
            return false;
        }
        let word = |offset| u32::from_le_bytes(header[offset..offset + 4].try_into().unwrap());
        let command_count = u64::from(word(16));
        let commands_size = u64::from(word(20));
        word(0) == 0xfeed_facf // MH_MAGIC_64
            && word(4) == 0x0100_000c // CPU_TYPE_ARM64
            && word(12) == 2 // MH_EXECUTE
            && command_count > 0
            && command_count * 8 <= commands_size
            && entry.size() >= 32 + commands_size
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn synthetic_archive(
            identifier: &str,
            version: &str,
            architecture: u32,
            extra_entry: Option<&str>,
            extra_first: bool,
        ) -> Vec<u8> {
            let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            let mut archive = tar::Builder::new(gzip);
            let info = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
                <plist version="1.0"><dict>
                <key>CFBundleIdentifier</key><string>{identifier}</string>
                <key>CFBundleShortVersionString</key><string>{version}</string>
                <key>CFBundleExecutable</key><string>scratchtree</string>
                </dict></plist>"#
            );
            let mut mach_o = [0u8; 40];
            mach_o[..4].copy_from_slice(&0xfeed_facfu32.to_le_bytes());
            mach_o[4..8].copy_from_slice(&architecture.to_le_bytes());
            mach_o[12..16].copy_from_slice(&2u32.to_le_bytes());
            mach_o[16..20].copy_from_slice(&1u32.to_le_bytes());
            mach_o[20..24].copy_from_slice(&8u32.to_le_bytes());
            let mut entries = vec![
                ("Scratchtree.app/Contents/Info.plist", info.as_bytes()),
                (
                    "Scratchtree.app/Contents/MacOS/scratchtree",
                    mach_o.as_slice(),
                ),
            ];
            if let Some(path) = extra_entry {
                if extra_first {
                    entries.insert(0, (path, info.as_bytes()));
                } else {
                    entries.push((path, info.as_bytes()));
                }
            }
            for (path, data) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                archive.append_data(&mut header, path, data).unwrap();
            }
            archive.into_inner().unwrap().finish().unwrap()
        }

        #[test]
        fn archive_preflight_checks_identity_version_architecture_and_critical_paths() {
            let expected = Version::parse("0.2.9").unwrap();
            for (id, version, architecture, extra, valid) in [
                (RELEASE_ID, "0.2.9", 0x0100_000c, None, true),
                (PROBE_ID, "0.2.9", 0x0100_000c, None, false),
                (RELEASE_ID, "0.2.8", 0x0100_000c, None, false),
                (RELEASE_ID, "0.2.9", 0x0100_0007, None, false),
                (
                    RELEASE_ID,
                    "0.2.9",
                    0x0100_000c,
                    Some("Scratchtree.app/Contents/Info.plist"),
                    false,
                ),
                (
                    RELEASE_ID,
                    "0.2.9",
                    0x0100_000c,
                    Some("Other.app/Contents/Info.plist"),
                    false,
                ),
            ] {
                let archive = synthetic_archive(id, version, architecture, extra, false);
                assert_eq!(
                    inspect_archive(&archive, RELEASE_ID, &expected).is_ok(),
                    valid,
                    "{id}, {version}, {architecture:x}, {extra:?}"
                );
            }
        }

        #[test]
        fn archive_rejects_case_folded_critical_aliases_in_both_orders() {
            let expected = Version::parse("0.2.9").unwrap();
            for alias in [
                "Scratchtree.app/Contents/info.plist",
                "Scratchtree.app/contents/Info.plist",
                "Scratchtree.app/Contents/MacOS/Scratchtree",
            ] {
                for alias_first in [true, false] {
                    let archive = synthetic_archive(
                        RELEASE_ID,
                        "0.2.9",
                        0x0100_000c,
                        Some(alias),
                        alias_first,
                    );
                    assert!(
                        inspect_archive(&archive, RELEASE_ID, &expected).is_err(),
                        "{alias}, first: {alias_first}"
                    );
                }
            }
        }

        #[test]
        fn install_lock_rejects_another_open_handle_until_released() {
            let stage = tempfile::tempdir().unwrap();
            let executable = stage.path().join("scratchtree");
            fs::write(&executable, []).unwrap();
            let first = lock_install(&executable).unwrap();
            assert_eq!(lock_install(&executable).unwrap_err().code, "update_busy");
            drop(first);
            assert!(lock_install(&executable).is_ok());
        }

        #[test]
        fn old_process_cannot_replace_a_bundle_that_has_already_updated() {
            let stage = tempfile::tempdir().unwrap();
            let contents = stage.path().join("Scratchtree.app/Contents");
            let executable = contents.join("MacOS/scratchtree");
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            let plist = contents.join("Info.plist");
            fs::write(&executable, []).unwrap();
            let lock = lock_install(&executable).unwrap();
            for (identifier, version, can_install) in [
                (RELEASE_ID, "0.2.8", true),
                (RELEASE_ID, "0.2.10", false),
                ("tech.barbajoe.scratchtree.preview", "0.2.8", false),
                (RELEASE_ID, "0.2.8", true),
            ] {
                std::fs::write(
                    &plist,
                    format!(
                        r#"<?xml version="1.0" encoding="UTF-8"?>
                        <plist version="1.0"><dict>
                        <key>CFBundleIdentifier</key><string>{identifier}</string>
                        <key>CFBundleShortVersionString</key><string>{version}</string>
                        <key>CFBundleExecutable</key><string>scratchtree</string>
                        </dict></plist>"#
                    ),
                )
                .unwrap();
                assert_eq!(
                    verify_current_bundle(
                        &lock,
                        &executable,
                        RELEASE_ID,
                        &Version::parse("0.2.8").unwrap()
                    )
                    .is_ok(),
                    can_install
                );
            }
            fs::rename(&executable, executable.with_extension("old")).unwrap();
            fs::write(&executable, []).unwrap();
            assert_eq!(
                verify_current_bundle(
                    &lock,
                    &executable,
                    RELEASE_ID,
                    &Version::parse("0.2.8").unwrap()
                )
                .unwrap_err()
                .code,
                "update_bundle_changed"
            );
        }
    }

    fn lock_install(executable: &Path) -> Result<File> {
        let lock = File::open(executable).map_err(|_| bundle_changed())?;
        match lock.try_lock() {
            Ok(()) => Ok(lock),
            Err(TryLockError::WouldBlock) => Err(update_in_progress()),
            Err(TryLockError::Error(_)) => Err(install_failed()),
        }
    }

    #[derive(Deserialize)]
    struct InstalledBundle {
        #[serde(rename = "CFBundleIdentifier")]
        identifier: String,
        #[serde(rename = "CFBundleShortVersionString")]
        version: String,
        #[serde(rename = "CFBundleExecutable")]
        executable: String,
    }

    impl InstalledBundle {
        fn matches(&self, identifier: &str, version: &Version) -> bool {
            self.identifier == identifier
                && Version::parse(&self.version).ok().as_ref() == Some(version)
        }
    }

    fn verify_current_bundle(
        lock: &File,
        executable: &Path,
        identifier: &str,
        version: &Version,
    ) -> Result<()> {
        let held = lock.metadata().map_err(|_| bundle_changed())?;
        let current = fs::metadata(executable).map_err(|_| bundle_changed())?;
        if held.ino() != current.ino() || held.dev() != current.dev() {
            return Err(bundle_changed());
        }
        let contents = executable
            .parent()
            .and_then(Path::parent)
            .ok_or_else(bundle_changed)?;
        let bundle: InstalledBundle =
            plist::from_file(contents.join("Info.plist")).map_err(|_| bundle_changed())?;
        if !bundle.matches(identifier, version)
            || executable.file_name() != Some(OsStr::new(&bundle.executable))
        {
            return Err(bundle_changed());
        }
        Ok(())
    }

    fn bundle_changed() -> crate::model::AppError {
        error(
            "update_bundle_changed",
            "The installed app changed. Reopen Scratchtree before checking for updates.",
        )
    }

    fn install_failed() -> crate::model::AppError {
        error(
            "update_install_failed",
            "Scratchtree could not verify or install the update. Try again or use the Mac download.",
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    const FIRST_PARTY: &str = "https://scratchtree.barbajoe.tech/releases/arch.json";
    const ARCH_RELEASE: &[u8] = br#"{"platform":"linux-x86_64","package":"scratchtree-preview","version":"0.2.9","notes":"A new release."}"#;
    const MAC_ASSET: &str =
        "https://github.com/Barbacoa08/scratchtree/releases/download/v0.2.9/Scratchtree-0.2.9-aarch64.app.tar.gz";

    #[test]
    fn configured_metadata_endpoints_are_static_and_first_party() {
        assert!(metadata_endpoint(None).unwrap().is_none());
        assert_eq!(
            metadata_endpoint(Some(FIRST_PARTY))
                .unwrap()
                .unwrap()
                .as_str(),
            FIRST_PARTY
        );
        for invalid in [
            "",
            "http://scratchtree.barbajoe.tech/releases/arch.json",
            "https://scratchtree.barbajoe.tech.evil.example/releases/arch.json",
            "https://joe@scratchtree.barbajoe.tech/releases/arch.json",
            "https://scratchtree.barbajoe.tech:444/releases/arch.json",
            "https://scratchtree.barbajoe.tech/releases/arch.json?token=x",
            "https://scratchtree.barbajoe.tech/releases/arch.json#fragment",
            "https://scratchtree.barbajoe.tech/",
        ] {
            assert!(metadata_endpoint(Some(invalid)).is_err(), "{invalid}");
        }
    }

    #[test]
    fn arch_metadata_identifies_the_packaged_preview() {
        let current = Version::parse("0.2.8").unwrap();
        let offer = arch_offer(ARCH_RELEASE, &current).unwrap().unwrap();
        assert_eq!(offer.platform, "arch");
        assert_eq!(offer.version, "0.2.9");
        assert_eq!(offer.notes.as_deref(), Some("A new release."));
        for invalid in [
            br#"{"platform":"linux-aarch64","package":"scratchtree-preview","version":"0.2.9"}"#.as_slice(),
            br#"{"platform":"linux-x86_64","package":"scratchtree","version":"0.2.9"}"#,
            br#"{"platform":"linux-x86_64","package":"scratchtree-preview","version":"v0.2.9"}"#,
            br#"{"platform":"linux-x86_64","package":"scratchtree-preview","version":"0.2.9","url":"https://example.com/"}"#,
            br#"{"platform":"linux-x86_64","package":"scratchtree-preview","version":"0.2.9","version":"1.0.0"}"#,
            br#"{"platform":"linux-x86_64","package":"scratchtree-preview","version":"0.2.9","notes":42}"#,
        ] {
            assert!(arch_offer(invalid, &current).is_err(), "{invalid:?}");
        }
        assert!(arch_offer(&vec![b' '; MANIFEST_LIMIT + 1], &current).is_err());
    }

    #[test]
    fn release_channel_uses_semver_precedence_and_skips_rcs() {
        for (running, offered, expected) in [
            ("0.2.9", "0.2.8", false),
            ("0.2.9", "0.2.9", false),
            ("0.2.9", "0.2.9+build.17", false),
            ("0.2.9", "0.2.10-rc.1", false),
            ("0.2.9", "0.2.10", true),
            ("0.2.10-rc.1", "0.2.10", true),
            ("0.2.10+build.17", "0.2.10", false),
        ] {
            assert_eq!(
                is_newer_release(
                    &Version::parse(offered).unwrap(),
                    &Version::parse(running).unwrap()
                ),
                expected,
                "{running} → {offered}"
            );
        }
    }

    fn mac_manifest(url: &str, signature: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": "0.2.9",
            "notes": null,
            "platforms": {
                "darwin-aarch64": {
                    "url": url,
                    "signature": signature,
                },
            }
        }))
        .unwrap()
    }

    #[test]
    fn mac_metadata_points_to_the_exact_tag_asset_for_apple_silicon() {
        let valid = MacRelease::parse(&mac_manifest(MAC_ASSET, "c2ln"), None).unwrap();
        assert_eq!(valid.version, Version::parse("0.2.9").unwrap());
        for invalid in [
            MAC_ASSET.replace("aarch64", "x86_64"),
            MAC_ASSET.replace("/v0.2.9/", "/v0.2.8/"),
            MAC_ASSET.replace("github.com", "example.com"),
            MAC_ASSET.replace("https:", "http:"),
            format!("{MAC_ASSET}?token=x"),
        ] {
            assert!(
                MacRelease::parse(&mac_manifest(&invalid, "c2ln"), None).is_err(),
                "{invalid}"
            );
        }
        let mut wrong_target: serde_json::Value =
            serde_json::from_slice(&mac_manifest(MAC_ASSET, "c2ln")).unwrap();
        wrong_target["platforms"] = serde_json::json!({"darwin-x86_64": {}});
        assert!(MacRelease::parse(&serde_json::to_vec(&wrong_target).unwrap(), None).is_err());
        assert!(MacRelease::parse(&mac_manifest(MAC_ASSET, ""), None).is_err());
    }

    #[test]
    fn disposable_mac_probe_is_limited_to_its_numeric_loopback_origin() {
        let url = probe_endpoint(Some("http://127.0.0.1:4519/mac.json"))
            .unwrap()
            .unwrap();
        assert_eq!(url.port(), Some(4519));
        let probe_asset = "http://127.0.0.1:4519/v0.2.9/Scratchtree-0.2.9-aarch64.app.tar.gz";
        assert!(MacRelease::parse(&mac_manifest(probe_asset, "c2ln"), Some(&url)).is_ok());
        assert!(MacRelease::parse(&mac_manifest(probe_asset, "c2ln"), None).is_err());
        assert!(MacRelease::parse(&mac_manifest(MAC_ASSET, "c2ln"), Some(&url)).is_err());
        for invalid in [
            probe_asset.replace(":4519", ":4520"),
            probe_asset.replace("/v0.2.9/", "/v0.2.8/"),
            format!("{probe_asset}?token=x"),
        ] {
            assert!(MacRelease::parse(&mac_manifest(&invalid, "c2ln"), Some(&url)).is_err());
        }
        for invalid in [
            "http://localhost:4519/mac.json",
            "http://127.1:4519/mac.json",
            "http://127.0.0.1:4519/other.json",
            "http://127.0.0.1:4519@127.0.0.1:4519/mac.json",
            "http://127.0.0.1:4519/mac.json?token=x",
            "http://127.0.0.1/mac.json",
            "http://127.0.0.1:80/mac.json",
            "https://scratchtree.barbajoe.tech/mac.json",
        ] {
            assert!(probe_endpoint(Some(invalid)).is_err(), "{invalid}");
        }
    }

    #[test]
    fn mac_offer_retains_the_exact_signature_and_disallows_replay() {
        let first = MacRelease::parse(&mac_manifest(MAC_ASSET, "c2ln"), None).unwrap();
        let conflict = MacRelease::parse(&mac_manifest(MAC_ASSET, "d3Jvbmc="), None).unwrap();
        let mut book = MacOffers::default();
        book.record(Some(first.clone())).unwrap();
        book.record(None).unwrap();
        assert!(book.for_install("0.2.9").is_err());
        assert!(book.record(Some(conflict)).is_err());
        book.record(Some(first)).unwrap();
        assert!(book.for_install("0.2.8").is_err());
        assert!(book.for_install("0.2.9").is_ok());
        book.finish_install();
        assert!(book.for_install("0.2.9").is_err());
        assert!(book.record(None).is_err());
    }
}
