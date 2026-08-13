fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "boot_state",
                "retry_boot",
                "reveal_logs",
                "plugin_list",
                "plugin_manage",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
