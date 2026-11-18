//! Language of the messages the Rust side shows in the interface (errors, notices).
//! The UI resolves the user's choice ("system" included) and reports it with `set_language`.
//! English is the default until it does.

use std::sync::atomic::{AtomicBool, Ordering};

static FRENCH: AtomicBool = AtomicBool::new(false);

pub fn set(lang: &str) {
    FRENCH.store(lang == "fr", Ordering::Relaxed);
}

/// The English or French version of a message: `tr("Session closed", "Session fermée")`,
/// or with `format!` on both sides.
pub fn tr<T>(en: T, fr: T) -> T {
    if FRENCH.load(Ordering::Relaxed) {
        fr
    } else {
        en
    }
}
