fn main() {
    // 图标变化需要触发 Windows 资源重新嵌入（tauri-build 默认不跟踪 icon.ico）
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "boot_state",
                "retry_boot",
                "reveal_logs",
                "stage_attachments",
                "plugin_list",
                "plugin_manage",
                "plugin_set_enabled",
                "mcp_list",
                "mcp_set_enabled",
                "log_query",
                "log_meta",
                "log_clear",
                "log_client",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
