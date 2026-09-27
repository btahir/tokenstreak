//! Tokenstreak desktop app: a menu-bar popover plus a dashboard window over
//! `tokenstreak-core`.

mod commands;
mod logging;
mod qa;
mod shortcut;
mod system;
mod tray;
mod worker;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_window_state::StateFlags;
use tokenstreak_core::engine::Engine;

/// Hands memory freed by a closed window back to the OS (the allocator
/// otherwise keeps it cached).
pub(crate) fn engine_release_memory(_app: &tauri::AppHandle) {
    tokenstreak_core::engine::release_memory();
}

/// The dashboard remembers its size, position and zoom; the popover is
/// positioned under the menu-bar icon every time instead.
fn window_state_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_window_state::Builder::new()
        .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
        .with_denylist(&["popover"])
        .build()
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    logging::init(app.path().app_log_dir().ok().as_deref());
    tracing::info!(version = %app.package_info().version, "starting");

    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    // `TOKENSTREAK_DATA_DIR` points the app at another data folder (QA,
    // measurements, demos) without touching the real one. QA mode never
    // uses the real one.
    let data_dir = if qa::enabled() {
        tracing::info!("QA mode: no login item, notifications or global shortcut");
        qa::data_dir()
    } else {
        match std::env::var_os("TOKENSTREAK_DATA_DIR").filter(|v| !v.is_empty()) {
            Some(d) => std::path::PathBuf::from(d),
            None => app.path().app_data_dir()?,
        }
    };
    std::fs::create_dir_all(&data_dir)?;
    // Opening restores the incremental cache, so the first snapshot is instant.
    let engine = Engine::open(&data_dir);
    let shortcut_setting = engine.settings().popover_shortcut.clone();
    let core = worker::start(app.handle(), engine)?;
    app.manage(core);
    tray::create(app.handle())?;

    if let Some(accel) = shortcut_setting.as_deref() {
        if let Err(e) = shortcut::apply(app.handle(), Some(accel)) {
            tracing::warn!(error = %e, "saved popover shortcut unavailable");
        }
    }

    let handle = app.handle().clone();
    system::observe(move |ev| {
        use tauri::Manager as _;
        handle.state::<worker::Core>().send(worker::Msg::System(ev));
    });

    // Popover: hide when it loses focus.
    if let Some(w) = app.get_webview_window("popover") {
        let handle = app.handle().clone();
        w.on_window_event(move |e| match e {
            WindowEvent::Focused(false) => tray::hide_popover(&handle),
            WindowEvent::Focused(true) => tray::popover_focused(),
            _ => {}
        });
    }
    // First run: open the dashboard for onboarding.
    let first_run = !app.state::<worker::Core>().snapshot().onboarding.completed;
    if first_run {
        tray::show_dashboard(app.handle());
    }
    // Launch flags on the first launch too (QA scripts): once the popover page has loaded.
    let args: Vec<String> = std::env::args().collect();
    let debug = qa::parse(&args);
    let popover = args.iter().any(|a| a == "--popover");
    if popover || !debug.is_empty() {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            if popover {
                tray::toggle_popover(&handle);
            }
            qa::run(&handle, debug);
        });
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum Action {
    Dashboard,
    Popover,
    Settings,
    Refresh,
    Quit,
}

fn second_launch_action(args: &[String]) -> Action {
    for a in args.iter().skip(1) {
        match a.as_str() {
            "--popover" => return Action::Popover,
            "--settings" => return Action::Settings,
            "--refresh" => return Action::Refresh,
            "--quit" => return Action::Quit,
            "--dashboard" => return Action::Dashboard,
            _ => {}
        }
    }
    Action::Dashboard
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch opens the dashboard (e.g. from Finder), or does
            // what its flag asks, so launchers and scripts can drive the app:
            // `open -a Tokenstreak --args --popover | --settings | --refresh | --quit`.
            let debug = qa::parse(&args);
            if !debug.is_empty() {
                qa::run(app, debug);
                return;
            }
            match second_launch_action(&args) {
                Action::Popover => tray::toggle_popover(app),
                Action::Settings => tray::show_settings(app),
                Action::Refresh => app.state::<worker::Core>().send(worker::Msg::Refresh(None)),
                Action::Quit => app.exit(0),
                Action::Dashboard => tray::show_dashboard(app),
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(window_state_plugin())
        .plugin(shortcut::plugin())
        .plugin(tauri_plugin_dialog::init())
        .setup(setup)
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
            commands::open_settings,
            commands::hide_popover,
            commands::set_popover_height,
            commands::quit_app,
            commands::open_external,
            commands::save_export,
            commands::reveal_logs,
            commands::locate_tool,
        ])
        .build(tauri::generate_context!());
    let app = match app {
        Ok(a) => a,
        Err(e) => {
            tracing::error!(error = %e, "Tokenstreak failed to start");
            eprintln!("Tokenstreak failed to start: {e}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| match event {
        // Keep running in the menu bar when every window is closed.
        tauri::RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        // The parse cache is written lazily while agents write; flush it.
        tauri::RunEvent::Exit => {
            if let Some(core) = app.try_state::<worker::Core>() {
                core.engine.lock().persist();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_launch_flags() {
        let a = |v: &[&str]| second_launch_action(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(a(&["tokenstreak"]), Action::Dashboard);
        assert_eq!(a(&["tokenstreak", "--popover"]), Action::Popover);
        assert_eq!(a(&["tokenstreak", "-psn_0_123", "--settings"]), Action::Settings);
        assert_eq!(a(&["tokenstreak", "--quit"]), Action::Quit);
        assert_eq!(a(&["tokenstreak", "--refresh"]), Action::Refresh);
    }
}
