//! Built-in browser: a real WKWebView, a child of the main window,
//! placed by the UI in the right panel (the UI draws only the address bar).
//! Loaded pages have no access to the app's IPC (no capability granted).

use crate::events::UiEvent;
use crate::hub::Hub;
use crate::i18n::tr;
use std::sync::Arc;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

const LABEL: &str = "browser";
/// A native view cannot be hidden: it moves out of the window.
pub const OFFSCREEN: f64 = -20_000.0;

/// Places a child view of the window, or moves it away when a dialog or another tab would cover it.
pub fn place(view: &tauri::Webview, x: f64, y: f64, w: f64, h: f64, visible: bool) {
    if visible && w > 1.0 && h > 1.0 {
        let _ = view.set_position(LogicalPosition::new(x, y));
        let _ = view.set_size(LogicalSize::new(w, h));
    } else {
        let _ = view.set_position(LogicalPosition::new(OFFSCREEN, OFFSCREEN));
        let _ = view.set_size(LogicalSize::new(1.0, 1.0));
    }
}

pub struct Browser {
    app: AppHandle,
    hub: Arc<Hub>,
}

/// "localhost:3000" → "http://localhost:3000", "example.com" → "https://example.com".
pub fn normalize(input: &str) -> Result<tauri::Url, String> {
    let s = input.trim();
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else if s.starts_with("localhost") || s.starts_with("127.") || s.starts_with("0.0.0.0") || s.starts_with('[') {
        format!("http://{s}")
    } else {
        format!("https://{s}")
    };
    let url: tauri::Url = with_scheme.parse().map_err(|_| tr(format!("Invalid address: {s}"), format!("Adresse invalide : {s}")))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        other => Err(tr(format!("Unsupported scheme: {other}"), format!("Schéma non pris en charge : {other}"))),
    }
}

impl Browser {
    pub fn new(app: AppHandle, hub: Arc<Hub>) -> Self {
        Self { app, hub }
    }

    pub fn open(&self, url: &str, x: f64, y: f64, w: f64, h: f64) -> Result<String, String> {
        let url = normalize(url)?;
        if let Some(wv) = self.app.get_webview(LABEL) {
            wv.navigate(url.clone()).map_err(|e| e.to_string())?;
            self.bounds(x, y, w, h, true);
            return Ok(url.to_string());
        }
        let window = self.app.get_window("main").ok_or(tr("Main window not found", "Fenêtre principale introuvable"))?;
        let hub_nav = self.hub.clone();
        let hub_load = self.hub.clone();
        let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url.clone()))
            .on_navigation(move |u| {
                hub_nav.emit(UiEvent::Browser { url: u.to_string(), loading: true });
                true
            })
            .on_page_load(move |_wv, payload| {
                hub_load.emit(UiEvent::Browser {
                    url: payload.url().to_string(),
                    loading: matches!(payload.event(), PageLoadEvent::Started),
                });
            });
        window
            .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w.max(1.0), h.max(1.0)))
            .map_err(|e| e.to_string())?;
        Ok(url.to_string())
    }

    /// Places the view (or sets it aside when a dialog or another tab would cover it).
    pub fn bounds(&self, x: f64, y: f64, w: f64, h: f64, visible: bool) {
        if let Some(wv) = self.app.get_webview(LABEL) {
            place(&wv, x, y, w, h, visible);
        }
    }

    pub fn nav(&self, action: &str) -> Result<(), String> {
        let wv = self.app.get_webview(LABEL).ok_or(tr("No page open", "Aucune page ouverte"))?;
        let js = match action {
            "back" => "history.back()",
            "forward" => "history.forward()",
            "reload" => "location.reload()",
            _ => return Err(tr(format!("Unknown action: {action}"), format!("Action inconnue : {action}"))),
        };
        wv.eval(js).map_err(|e| e.to_string())
    }

    pub fn close(&self) {
        if let Some(wv) = self.app.get_webview(LABEL) {
            let _ = wv.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn normalizes_addresses() {
        assert_eq!(normalize("localhost:5173").unwrap().as_str(), "http://localhost:5173/");
        assert_eq!(normalize("tauri.app").unwrap().as_str(), "https://tauri.app/");
        assert!(normalize("file:///etc/passwd").is_err());
    }
}
