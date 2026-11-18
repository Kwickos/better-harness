mod artifacts;
mod browser;
mod commands;
mod events;
mod files_tool;
mod git;
mod history;
mod hub;
mod mcp;
mod mentions;
mod metrics;
mod protocol;
mod servers;
mod settings;
mod shellenv;
mod simulator;
mod simulator_tool;
mod updates;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let cache_dir = app.path().app_cache_dir()?;
            let simulator_cache = cache_dir.clone();
            let hub = hub::Hub::new(app.handle().clone(), config_dir, cache_dir);
            hub.restore();
            tauri::async_runtime::spawn(hub.clone().supervise());
            // Préchauffe la lecture du PATH du shell pour que le premier message parte vite.
            tauri::async_runtime::spawn(async {
                shellenv::path().await;
            });
            // Filet : si l'interface ne signale jamais qu'elle est prête, la fenêtre s'affiche quand même.
            let window_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                if let Some(window) = window_handle.get_window("main") {
                    let _ = window.show();
                }
            });
            app.manage(simulator::Simulator::new(hub.clone(), simulator_cache));
            app.manage(servers::Servers::new(hub.clone()));
            app.manage(browser::Browser::new(app.handle().clone(), hub.clone()));
            app.manage(artifacts::ArtifactView::new(app.handle().clone(), hub.clone()));
            app.manage(hub);
            app.manage(metrics::Metrics::new());
            let updates = Arc::new(updates::Updates::default());
            tauri::async_runtime::spawn(updates::watch(app.handle().clone(), updates.clone()));
            app.manage(updates);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::subscribe,
            commands::list_sessions,
            commands::create_session,
            commands::send_message,
            commands::interrupt,
            commands::respond_permission,
            commands::set_permission_mode,
            commands::set_model,
            commands::suspend_session,
            commands::close_session,
            commands::focus_session,
            commands::set_visible,
            commands::list_history,
            commands::list_archived,
            commands::set_archived,
            commands::delete_conversation,
            commands::load_transcript,
            commands::list_mcp,
            commands::get_metrics,
            commands::get_settings,
            commands::save_settings,
            commands::app_info,
            commands::set_effort,
            commands::set_advisor,
            commands::context_usage,
            commands::mcp_status,
            commands::mcp_toggle,
            commands::mcp_reconnect,
            commands::servers_list,
            commands::server_start,
            commands::server_stop,
            commands::server_logs,
            commands::browser_open,
            commands::browser_bounds,
            commands::browser_nav,
            commands::browser_close,
            commands::scratch_dir,
            commands::app_ready,
            commands::copy_text,
            commands::cli_defaults,
            commands::list_commands,
            commands::mention_files,
            commands::git_status,
            commands::git_diff,
            commands::git_discard,
            commands::artifact_show,
            commands::artifact_bounds,
            commands::artifact_reload,
            commands::artifact_close,
            commands::artifact_delete,
            commands::attachments,
            commands::open_attachment,
            commands::sim_devices,
            commands::sim_boot,
            commands::sim_shutdown,
            commands::sim_attach,
            commands::sim_detach,
            commands::sim_select,
            commands::sim_frame,
            commands::sim_input,
            commands::sim_screenshot,
            commands::sim_appearance,
            commands::update_status,
            commands::update_check,
            commands::update_install,
        ])
        .on_window_event(|window, event| {
            // Avec une webview enfant (navigateur), la vue principale suit la taille de la fenêtre.
            if let tauri::WindowEvent::Resized(size) = event {
                if let Some(main) = window.app_handle().get_webview("main") {
                    let _ = main.set_size(*size);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("échec du démarrage de Better Harness")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Arc<hub::Hub>>().shutdown_all();
                app.state::<Arc<servers::Servers>>().shutdown_all();
                app.state::<Arc<simulator::Simulator>>().close_stream();
                // Une version téléchargée mais pas encore installée l'est maintenant : le prochain lancement est à jour.
                if let Err(e) = app.state::<Arc<updates::Updates>>().install() {
                    eprintln!("mise à jour non installée : {e}");
                }
            }
        });
}
