#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
    WindowEvent,
};

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

    Image::new_owned(16, 16, rgba)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let open_item =
                MenuItem::with_id(app, "open", "Open SteamTracker", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(tray_icon())
                .tooltip("SteamTracker")
                .menu(&menu)
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

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running SteamTracker");
}