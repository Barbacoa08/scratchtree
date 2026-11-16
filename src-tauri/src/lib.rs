mod external;
pub mod files;
pub mod model;
pub mod recovery;
mod window_geometry;
use model::*;
use std::sync::Arc;
use tauri::{Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn external_open_url(app: tauri::AppHandle, url: String) -> Result<()> {
    external::validate_url(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(storage_error)
}
#[tauri::command]
fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<()> {
    app.clipboard().write_text(text).map_err(storage_error)
}

#[tauri::command]
async fn backup_read_text(app: tauri::AppHandle) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .dialog()
            .file()
            .add_filter("Scratchtree backup", &["json"])
            .blocking_pick_file();
        let Some(path) = path else { return Ok(None) };
        let path = path.into_path().map_err(storage_error)?;
        files::read_text(&path).map(Some)
    })
    .await
    .map_err(storage_error)?
}

#[tauri::command]
async fn backup_write_text(app: tauri::AppHandle, text: String) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .dialog()
            .file()
            .add_filter("Scratchtree backup", &["json"])
            .set_file_name("scratchtree-backup.json")
            .blocking_save_file();
        let Some(path) = path else { return Ok(None) };
        let path = path.into_path().map_err(storage_error)?;
        files::write_text(&path, &text)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(storage_error)?
}

#[tauri::command]
async fn backup_safety_text(app: tauri::AppHandle, text: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = app
            .path()
            .app_data_dir()
            .map_err(storage_error)?
            .join("backups");
        files::safety_text(&folder, &text)?;
        Ok(())
    })
    .await
    .map_err(storage_error)?
}

#[tauri::command]
async fn recovery_begin(
    app: tauri::AppHandle,
    state: State<'_, Arc<recovery::RecoveryExports>>,
) -> Result<Option<String>> {
    let exports = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .dialog()
            .file()
            .add_filter("Scratchtree recovery archive", &["json"])
            .set_file_name("scratchtree-recovery.json")
            .blocking_save_file();
        let Some(path) = path else { return Ok(None) };
        exports
            .begin(path.into_path().map_err(storage_error)?)
            .map(Some)
    })
    .await
    .map_err(storage_error)?
}

#[tauri::command]
async fn recovery_append(
    state: State<'_, Arc<recovery::RecoveryExports>>,
    id: String,
    index: u64,
    chunk: String,
) -> Result<()> {
    let exports = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || exports.append(&id, index, &chunk))
        .await
        .map_err(storage_error)?
}

#[tauri::command]
async fn recovery_finish(
    state: State<'_, Arc<recovery::RecoveryExports>>,
    id: String,
) -> Result<String> {
    let exports = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        exports
            .finish(&id)
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(storage_error)?
}

#[tauri::command]
async fn recovery_abort(
    state: State<'_, Arc<recovery::RecoveryExports>>,
    id: String,
) -> Result<()> {
    let exports = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || exports.abort(&id))
        .await
        .map_err(storage_error)?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            app.manage(window_geometry::GeometryState::new(
                app.path().app_config_dir().ok(),
            ));
            app.manage(Arc::new(recovery::RecoveryExports::default()));
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                window_geometry::restore(&webview.window());
            }
        })
        .on_window_event(window_geometry::event)
        .invoke_handler(tauri::generate_handler![
            external_open_url,
            clipboard_write_text,
            backup_read_text,
            backup_write_text,
            backup_safety_text,
            recovery_begin,
            recovery_append,
            recovery_finish,
            recovery_abort
        ])
        .build(tauri::generate_context!())
        .expect("Cannot start Scratchtree")
        .run(|app, event| {
            // Reuse the hidden webview: rebuilding it would lose session/editor state.
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                let _ = app.show();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                window_geometry::exiting(app);
            }
        });
}
