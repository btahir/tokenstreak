//! Tokenstreak desktop app: a menu-bar popover plus a dashboard window over
//! `tokenstreak-core`.

mod commands;
mod tray;
mod worker;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tokenstreak_core::engine::Engine;

pub fn run() {
    // Logs carry counts and timings only (never log content), to stderr.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("TOKENSTREAK_LOG").unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch (e.g. from Finder) opens the dashboard.
            tray::show_dashboard(app);
        }))
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            // Opening restores the incremental cache, so the first snapshot is instant.
            let engine = Engine::open(&data_dir);
            let core = worker::start(app.handle(), engine);
            app.manage(core);
            tray::create(app.handle())?;

            // Popover: hide when it loses focus.
            if let Some(w) = app.get_webview_window("popover") {
                let handle = app.handle().clone();
                w.on_window_event(move |e| {
                    if let WindowEvent::Focused(false) = e {
                        tray::hide_popover(&handle);
                    }
                });
            }
            // Dashboard: closing hides it and returns to a menu-bar-only app.
            if let Some(w) = app.get_webview_window("dashboard") {
                let handle = app.handle().clone();
                let win = w.clone();
                w.on_window_event(move |e| {
                    if let WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        let _ = win.hide();
                        #[cfg(target_os = "macos")]
                        let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                });
            }
            // First run: open the dashboard for onboarding.
            let first_run = !app.state::<worker::Core>().snapshot().onboarding.completed;
            if first_run {
                tray::show_dashboard(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::get_breakdown,
            commands::get_settings,
            commands::update_settings,
            commands::set_goals,
            commands::complete_onboarding,
            commands::refresh,
            commands::refresh_prices,
            commands::get_share_card,
            commands::export_csv,
            commands::acknowledge_celebration,
            commands::acknowledge_achievements,
            commands::get_app_info,
            commands::open_dashboard,
            commands::hide_popover,
            commands::set_popover_height,
            commands::quit_app,
            commands::open_external,
            commands::save_export,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tokenstreak")
        .run(|_app, event| {
            // Keep running in the menu bar when every window is closed.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
