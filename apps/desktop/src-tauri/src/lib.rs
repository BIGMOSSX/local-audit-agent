pub mod allowlist;
pub mod sidecar;

use serde_json::Value;
use sidecar::{IpcFailure, Sidecar, SidecarSpec};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

/// The allowlist gate: `ipc_call` runs this before anything reaches the sidecar.
fn check_method(method: &str) -> Result<(), IpcFailure> {
    if allowlist::is_allowed(method) {
        Ok(())
    } else {
        Err(IpcFailure::new(
            "method_not_allowed",
            "This method is not available.",
        ))
    }
}

/// The only command the webview can invoke: forwards allowlisted methods to the local service.
#[tauri::command]
async fn ipc_call(
    sidecar: tauri::State<'_, Arc<Sidecar>>,
    method: String,
    params: Option<Value>,
) -> Result<Value, IpcFailure> {
    check_method(&method)?;
    let sidecar = Arc::clone(sidecar.inner());
    // The exchange is blocking std I/O; keep it off the async runtime's threads.
    tauri::async_runtime::spawn_blocking(move || sidecar.call(&method, params))
        .await
        .map_err(|_| IpcFailure::new("internal", "The request worker failed."))?
}

#[cfg(debug_assertions)]
fn resolve_spec(data_dir: PathBuf) -> SidecarSpec {
    let node = std::env::var_os("AUDITD_NODE").unwrap_or_else(|| "node".into());
    let entry = std::env::var_os("AUDITD_ENTRY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../packages/auditd/dist/main.js"
            ))
        });
    SidecarSpec {
        node,
        entry: Some(entry),
        data_dir,
    }
}

/// No daemon is bundled yet, and environment overrides are ignored in release builds.
#[cfg(not(debug_assertions))]
fn resolve_spec(data_dir: PathBuf) -> SidecarSpec {
    SidecarSpec {
        node: "node".into(),
        entry: None,
        data_dir,
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // `tauri::Error` converts into the setup hook's `Box<dyn Error>`.
            let data_dir = app.path().app_data_dir()?;
            app.manage(Arc::new(Sidecar::new(resolve_spec(data_dir))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc_call])
        .build(tauri::generate_context!())
        .expect("error while building the desktop shell")
        .run(|app_handle, event| {
            // `App::run` ends by exiting the process, so `Drop for Sidecar` never runs:
            // stop the daemon (and remove its endpoint dir) here instead.
            if let tauri::RunEvent::Exit = event {
                if let Some(sidecar) = app_handle.try_state::<Arc<Sidecar>>() {
                    sidecar.shutdown();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gate_rejects_methods_outside_the_allowlist() {
        for m in ["shell.exec", "fs.read", "", "PROJECT.OPEN", "project.open "] {
            let failure = check_method(m).expect_err(m);
            assert_eq!(failure.code, "method_not_allowed", "{m:?}");
            assert_eq!(failure.message, "This method is not available.");
        }
    }

    #[test]
    fn the_gate_passes_every_allowlisted_method() {
        for m in allowlist::ALLOWED_METHODS {
            assert_eq!(check_method(m), Ok(()), "{m}");
        }
    }
}
