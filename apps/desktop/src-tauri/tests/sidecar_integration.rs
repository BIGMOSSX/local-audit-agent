use audit_desktop_lib::sidecar::{Sidecar, SidecarSpec};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn auditd_entry() -> PathBuf {
    let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/auditd/dist/main.js");
    assert!(
        entry.exists(),
        "auditd is not built. Run `pnpm --filter @audit/auditd build` first (missing: {})",
        entry.display()
    );
    entry
}

fn node() -> std::ffi::OsString {
    std::env::var_os("AUDITD_NODE").unwrap_or_else(|| "node".into())
}

fn unique_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("{label}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn sidecar(data_dir: &Path) -> Sidecar {
    Sidecar::new(SidecarSpec {
        node: node(),
        entry: Some(auditd_entry()),
        data_dir: data_dir.to_path_buf(),
    })
}

fn code_of(result: Result<Value, audit_desktop_lib::sidecar::IpcFailure>) -> String {
    result.expect_err("expected a failure").code
}

#[test]
fn lists_an_empty_project_set_on_first_call() {
    let data = unique_dir("audit-data");
    let sc = sidecar(&data);
    let listed = sc.call("project.list", Some(json!({}))).unwrap();
    assert_eq!(listed, json!({ "projects": [] }));
}

#[test]
fn opens_a_project_in_a_unicode_path_with_spaces() {
    let data = unique_dir("audit-data");
    let project = unique_dir("审计 项目 (副本)");
    fs::write(project.join("package.json"), "{}").unwrap();
    let sc = sidecar(&data);

    let opened = sc
        .call("project.open", Some(json!({ "path": project })))
        .unwrap();
    assert_eq!(
        opened["name"],
        json!(project.file_name().unwrap().to_string_lossy())
    );
    assert_eq!(opened["ecosystems"], json!(["node"]));

    let listed = sc.call("project.list", None).unwrap();
    assert_eq!(listed["projects"].as_array().unwrap().len(), 1);
}

#[test]
fn projects_survive_a_restart_of_the_shell() {
    let data = unique_dir("audit-data");
    let project = unique_dir("persisted");
    fs::write(project.join("package.json"), "{}").unwrap();

    let first = sidecar(&data);
    first
        .call("project.open", Some(json!({ "path": project })))
        .unwrap();
    drop(first);

    let second = sidecar(&data);
    let listed = second.call("project.list", None).unwrap();
    assert_eq!(listed["projects"].as_array().unwrap().len(), 1);
}

#[test]
fn respawns_after_the_daemon_is_killed() {
    let data = unique_dir("audit-data");
    let project = unique_dir("survivor");
    fs::write(project.join("package.json"), "{}").unwrap();
    let sc = sidecar(&data);
    sc.call("project.open", Some(json!({ "path": project })))
        .unwrap();

    sc.kill_for_test();

    let listed = sc
        .call("project.list", None)
        .expect("call after kill must respawn the daemon");
    assert_eq!(
        listed["projects"].as_array().unwrap().len(),
        1,
        "data persists across the respawn"
    );
}

#[cfg(unix)]
#[test]
fn shutdown_stops_the_daemon_and_removes_its_endpoint_dir() {
    let data = unique_dir("audit-data");
    let sc = sidecar(&data);
    sc.call("project.list", None).unwrap();
    let endpoint = sc.endpoint_for_test().expect("daemon is running");
    let dir = Path::new(&endpoint).parent().unwrap().to_path_buf();
    assert!(dir.exists());

    sc.shutdown();

    assert!(!dir.exists(), "endpoint dir must be gone after shutdown");
    assert!(sc.endpoint_for_test().is_none());
    // Idempotent: a second shutdown (or the later Drop) is a no-op.
    sc.shutdown();
}

#[cfg(unix)]
#[test]
fn recovers_when_the_daemon_is_alive_but_its_socket_is_gone() {
    let data = unique_dir("audit-data");
    let sc = sidecar(&data);
    sc.call("project.list", None).unwrap();
    let endpoint = sc.endpoint_for_test().expect("daemon running");
    fs::remove_file(&endpoint).unwrap();

    sc.call("project.list", None)
        .expect("connect failure must trigger a restart and a retry");
    let new_endpoint = sc.endpoint_for_test().unwrap();
    assert_ne!(new_endpoint, endpoint);
}

#[test]
fn the_daemon_rejects_shell_exec_even_if_the_shell_forwarded_it() {
    let data = unique_dir("audit-data");
    let sc = sidecar(&data);
    assert_eq!(
        code_of(sc.call("shell.exec", Some(json!({ "cmd": "id" })))),
        "method_not_allowed"
    );
}

#[test]
fn invalid_paths_come_back_as_readable_daemon_errors() {
    let data = unique_dir("audit-data");
    let sc = sidecar(&data);
    let failure = sc
        .call("project.open", Some(json!({ "path": "relative/dir" })))
        .unwrap_err();
    assert_eq!(failure.code, "invalid_path");
    assert!(!failure.message.is_empty());
}

#[test]
fn a_missing_entry_is_sidecar_unavailable_not_a_panic() {
    let data = unique_dir("audit-data");
    let sc = Sidecar::new(SidecarSpec {
        node: node(),
        entry: None,
        data_dir: data,
    });
    assert_eq!(
        code_of(sc.call("project.list", None)),
        "sidecar_unavailable"
    );
}

#[test]
fn an_entry_that_crashes_is_sidecar_unavailable() {
    let data = unique_dir("audit-data");
    let sc = Sidecar::new(SidecarSpec {
        node: node(),
        entry: Some(data.join("does-not-exist.js")),
        data_dir: data,
    });
    assert_eq!(
        code_of(sc.call("project.list", None)),
        "sidecar_unavailable"
    );
}
