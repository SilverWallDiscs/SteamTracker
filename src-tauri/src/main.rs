#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod steam;
mod rich_presence;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
    WindowEvent,
};
use steam::MonitorState;
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
fn send_desktop_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("Windows no pudo mostrar la notificación: {error}"))
}

fn tray_icon() -> Image<'static> {
    let mut rgba = vec![0_u8; 16 * 16 * 4];

    for y in 1..15 {
        for x in 1..15 {
            let dx = if x < 8 { 7 - x } else { x - 8 };
            let dy = if y < 8 { 7 - y } else { y - 8 };
            if dx * dx + dy * dy <= 49 {
                let index = (y * 16 + x) * 4;
                rgba[index..index + 4].copy_from_slice(&[24, 91, 137, 255]);
            }
        }
    }

    let glyph = [
        "01110",
        "11000",
        "11000",
        "01110",
        "00011",
        "00011",
        "11110",
    ];
    for (row, line) in glyph.iter().enumerate() {
        for (column, pixel) in line.chars().enumerate() {
            if pixel == '1' {
                let x = column + 5;
                let y = row + 4;
                let index = (y * 16 + x) * 4;
                rgba[index..index + 4].copy_from_slice(&[232, 245, 255, 255]);
            }
        }
    }

    Image::new_owned(rgba, 16, 16)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(MonitorState::default())
        .setup(|app| {
            let open_item =
                MenuItem::with_id(app, "open", "Abrir SteamTracker", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(tray_icon())
                .tooltip("SteamTracker")
                .show_menu_on_left_click(false)
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let bridge = rich_presence::RichPresenceBridge::start(app.handle());
            app.manage(bridge.clone());
            tauri::async_runtime::spawn(async move {
                bridge.restore_saved_session().await;
            });

            let monitor_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                steam::monitor_loop(monitor_app).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            steam::save_api_key,
            steam::has_api_key,
            steam::get_targets,
            steam::get_snapshots,
            steam::add_target,
            steam::remove_target,
            send_desktop_notification,
            rich_presence::rich_presence_start_login,
            rich_presence::rich_presence_status,
            rich_presence::rich_presence_query,
            rich_presence::rich_presence_logout
        ])
        .run(tauri::generate_context!())
        .expect("error while running SteamTracker");
}