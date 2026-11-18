//! L'outil MCP qui laisse Claude piloter un simulateur iOS. Le CLI le voit comme un serveur
//! « sdk » : ses messages JSON-RPC passent par le canal stream-json déjà ouvert (`mcp_message`),
//! sans processus de plus par conversation. Chaque appel passe par la permission habituelle du CLI.

use crate::simulator::{self, SimDevice, Simulator};
use base64::Engine;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub const SERVER: &str = "ios-simulator";
pub const CONFIG: &str = r#"{"mcpServers":{"ios-simulator":{"type":"sdk","name":"ios-simulator"}}}"#;
const DESCRIPTION: &str = "Drive an iOS Simulator device the user can watch live: see its screen, tap, swipe, type. \
Actions except list and boot return a screenshot once the screen settles; if it is still loading, call screenshot again. \
Coordinates are pixels of that screenshot, origin top-left. A swipe starting within 6 px of an edge is the system gesture: \
bottom = home, left = back, top = notifications or Control Center. Build, install and launch apps with xcodebuild and `xcrun simctl`.";

/// Un geste qui part à moins de ce nombre de pixels d'un bord est un geste du système.
const EDGE_PX: f64 = 6.0;
const TAP: Duration = Duration::from_millis(60);
/// SimulatorKit ignore deux mouvements à moins de 16 ms.
const SWIPE_TICK: f64 = 0.02;
/// Délai laissé à l'écran pour réagir : sur une machine chargée, l'accueil met plus d'une seconde à démarrer.
const FIRST_CHANGE: Duration = Duration::from_secs(2);
/// Une capture demandée alors que Claude a déjà vu l'écran : une app lente à s'ouvrir ne doit pas lui
/// faire enchaîner des images identiques, ni renoncer avant la fin du lancement.
const POLL_WAIT: Duration = Duration::from_secs(3);

fn tool() -> Value {
    json!({
        "name": "control",
        "description": DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["list", "boot", "screenshot", "tap", "swipe", "type", "key", "home", "open_url"] },
                "device": { "type": "string", "description": "Name or UDID. Default: the device shown in the panel, or the only booted one." },
                "x": { "type": "number" },
                "y": { "type": "number" },
                "x2": { "type": "number", "description": "Swipe end." },
                "y2": { "type": "number", "description": "Swipe end." },
                "duration": { "type": "number", "description": "Seconds: long press for tap, gesture length for swipe." },
                "text": { "type": "string", "description": "type: typed into the focused field, tap it first. key: return, delete, tab, escape, space, up, down, left or right. open_url: the URL." }
            },
            "required": ["action"]
        }
    })
}

/// Répond à un message JSON-RPC du CLI.
pub async fn handle(sim: &Arc<Simulator>, message: &Value) -> Value {
    let id = message["id"].clone();
    let result = match message["method"].as_str() {
        Some("initialize") => json!({
            "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") }
        }),
        Some("tools/list") => json!({ "tools": [tool()] }),
        Some("tools/call") => match run(sim, &message["params"]["arguments"]).await {
            Ok(content) => json!({ "content": content }),
            Err(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": true }),
        },
        Some("ping") => json!({}),
        // Une notification n'attend pas de réponse.
        _ if id.is_null() => return json!({}),
        _ => return json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Méthode inconnue" } }),
    };
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn device_line(device: &SimDevice, selected: Option<&str>) -> String {
    let shown = if selected == Some(device.udid.as_str()) { " (shown in the panel)" } else { "" };
    format!("{}: {}, {}, {}{shown}", device.name, device.udid, device.state, device.runtime)
}

/// L'appareil demandé, sinon celui du panneau, sinon le seul démarré. Jamais un choix au hasard.
fn resolve(devices: &[SimDevice], wanted: Option<&str>, selected: Option<&str>) -> Result<SimDevice, String> {
    let booted = |d: &SimDevice| d.state == "Booted";
    if let Some(wanted) = wanted {
        let matching: Vec<&SimDevice> = devices.iter().filter(|d| d.udid.eq_ignore_ascii_case(wanted) || d.name.eq_ignore_ascii_case(wanted)).collect();
        return matching
            .iter()
            .find(|d| booted(d))
            .or(matching.first())
            .map(|d| (*d).clone())
            .ok_or_else(|| format!("No device named {wanted}. Use the list action to see them."));
    }
    if let Some(device) = selected.and_then(|udid| devices.iter().find(|d| d.udid == udid)).filter(|d| booted(d)) {
        return Ok(device.clone());
    }
    let running: Vec<&SimDevice> = devices.iter().filter(|d| booted(d)).collect();
    match running.as_slice() {
        [only] => Ok((*only).clone()),
        [] => Err("No device is booted. Use the list action, then boot one.".into()),
        many => Err(format!("Several devices are booted: {}. Say which one with the device parameter.", many.iter().map(|d| d.name.as_str()).collect::<Vec<_>>().join(", "))),
    }
}

/// `x`, `y` lus dans les arguments et vérifiés contre la taille de la capture.
fn point(args: &Value, keys: (&str, &str), size: (f64, f64)) -> Result<(f64, f64), String> {
    let (Some(x), Some(y)) = (args[keys.0].as_f64(), args[keys.1].as_f64()) else {
        return Err(format!("{} and {} are required.", keys.0, keys.1));
    };
    if !(0.0..=size.0).contains(&x) || !(0.0..=size.1).contains(&y) {
        return Err(format!("({x}, {y}) is outside the {}x{} screenshot.", size.0, size.1));
    }
    Ok((x, y))
}

/// 1 haut, 2 gauche, 3 bas, 4 droite, 0 si le geste ne part pas d'un bord.
fn edge_of(x: f64, y: f64, size: (f64, f64)) -> u8 {
    if size.1 - y <= EDGE_PX {
        3
    } else if x <= EDGE_PX {
        2
    } else if size.0 - x <= EDGE_PX {
        4
    } else if y <= EDGE_PX {
        1
    } else {
        0
    }
}

fn key_code(name: &str) -> Option<u32> {
    Some(match name.to_ascii_lowercase().as_str() {
        "return" | "enter" => 40,
        "escape" => 41,
        "delete" | "backspace" => 42,
        "tab" => 43,
        "space" => 44,
        "right" => 79,
        "left" => 80,
        "down" => 81,
        "up" => 82,
        _ => return None,
    })
}

const COMMAND_KEY: u32 = 227;
const SHIFT_KEY: u32 = 225;
const V_KEY: u32 = 25;
/// Au-delà, frapper touche par touche serait trop long : on colle.
const TYPE_MAX: usize = 300;

/// Disposition du clavier de l'appareil : un code HID désigne une position, pas un caractère.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Layout {
    Qwerty,
    Azerty,
}

const QWERTY_KEYS: &[(u32, char, char)] = &[
    (30, '1', '!'), (31, '2', '@'), (32, '3', '#'), (33, '4', '$'), (34, '5', '%'), (35, '6', '^'), (36, '7', '&'), (37, '8', '*'), (38, '9', '('), (39, '0', ')'),
    (45, '-', '_'), (46, '=', '+'), (47, '[', '{'), (48, ']', '}'), (49, '\\', '|'), (51, ';', ':'), (52, '\'', '"'), (53, '`', '~'), (54, ',', '<'), (55, '.', '>'), (56, '/', '?'),
];
/// Relevée sur un simulateur en français. Les codes 53 et 100 y sont inversés par rapport à un clavier physique.
const AZERTY_KEYS: &[(u32, char, char)] = &[
    (53, '<', '>'), (100, '@', '#'), (30, '&', '1'), (31, 'é', '2'), (32, '"', '3'), (33, '\'', '4'), (34, '(', '5'), (35, '§', '6'), (36, 'è', '7'), (37, '!', '8'), (38, 'ç', '9'), (39, 'à', '0'),
    (45, ')', '°'), (46, '-', '_'), (48, '$', '*'), (52, 'ù', '%'), (16, ',', '?'), (54, ';', '.'), (55, ':', '/'), (56, '=', '+'),
];
const AZERTY_LETTERS: &[(char, u32)] = &[
    ('a', 20), ('z', 26), ('e', 8), ('r', 21), ('t', 23), ('y', 28), ('u', 24), ('i', 12), ('o', 18), ('p', 19), ('q', 4), ('s', 22), ('d', 7),
    ('f', 9), ('g', 10), ('h', 11), ('j', 13), ('k', 14), ('l', 15), ('m', 51), ('w', 29), ('x', 27), ('c', 6), ('v', 25), ('b', 5), ('n', 17),
];
const AZERTY_DEAD_KEY: u32 = 47;

/// Les touches qui écrivent ce caractère : `None` s'il n'y en a pas sur cette disposition.
fn strokes_for(c: char, layout: Layout) -> Option<Vec<(u32, bool)>> {
    match c {
        ' ' => return Some(vec![(44, false)]),
        '\n' => return Some(vec![(40, false)]),
        '\t' => return Some(vec![(43, false)]),
        _ => {}
    }
    let letter = |l: char| match layout {
        Layout::Qwerty => l.is_ascii_lowercase().then(|| 4 + (l as u32 - 'a' as u32)),
        Layout::Azerty => AZERTY_LETTERS.iter().find(|(known, _)| *known == l).map(|(_, code)| *code),
    };
    if c.is_ascii_alphabetic() {
        return letter(c.to_ascii_lowercase()).map(|code| vec![(code, c.is_ascii_uppercase())]);
    }
    let keys = if layout == Layout::Qwerty { QWERTY_KEYS } else { AZERTY_KEYS };
    if let Some((code, plain, _)) = keys.iter().find(|(_, plain, shifted)| *plain == c || *shifted == c) {
        return Some(vec![(*code, *plain != c)]);
    }
    if layout == Layout::Azerty {
        // Touche morte : ^ ou ¨, puis la voyelle.
        let (shift, vowel) = match c {
            'â' => (false, 'a'),
            'ê' => (false, 'e'),
            'î' => (false, 'i'),
            'ô' => (false, 'o'),
            'û' => (false, 'u'),
            'ä' => (true, 'a'),
            'ë' => (true, 'e'),
            'ï' => (true, 'i'),
            'ö' => (true, 'o'),
            'ü' => (true, 'u'),
            _ => return None,
        };
        return Some(vec![(AZERTY_DEAD_KEY, shift), (letter(vowel)?, false)]);
    }
    None
}

fn strokes(text: &str, layout: Layout) -> Option<Vec<(u32, bool)>> {
    if text.chars().count() > TYPE_MAX {
        return None;
    }
    let mut all = Vec::new();
    for c in text.chars() {
        all.extend(strokes_for(c, layout)?);
    }
    Some(all)
}

/// La disposition d'après les réglages de l'appareil, seulement si on la connaît avec certitude.
pub fn layout_from(keyboards: Option<&str>, languages: Option<&str>) -> Option<Layout> {
    let first_quoted = |text: &str| text.lines().map(|l| l.trim().trim_matches(|c: char| c == '"' || c == ',' || c == '(' || c == ')').to_string()).find(|l| !l.is_empty());
    if let Some(keyboard) = keyboards.and_then(first_quoted) {
        return if keyboard.starts_with("fr_FR@sw=AZERTY") {
            Some(Layout::Azerty)
        } else if keyboard.starts_with("en_US@sw=QWERTY") {
            Some(Layout::Qwerty)
        } else {
            None
        };
    }
    match languages.and_then(first_quoted)?.as_str() {
        "fr" | "fr-FR" => Some(Layout::Azerty),
        "en" | "en-US" => Some(Layout::Qwerty),
        _ => None,
    }
}

async fn run(sim: &Arc<Simulator>, args: &Value) -> Result<Value, String> {
    let action = args["action"].as_str().ok_or("action is required.")?;
    let devices = simulator::devices().await?;
    let selected = sim.selected();
    if action == "list" {
        let lines: Vec<String> = devices.iter().map(|d| device_line(d, selected.as_deref())).collect();
        return Ok(json!([{ "type": "text", "text": lines.join("\n") }]));
    }
    let device = resolve(&devices, args["device"].as_str(), selected.as_deref())?;
    if action == "boot" {
        simulator::boot(&device.udid).await?;
        return Ok(json!([{ "type": "text", "text": format!("{} is booted.", device.name) }]));
    }
    if device.state != "Booted" {
        return Err(format!("{} is {}. Use the boot action first.", device.name, device.state.to_lowercase()));
    }

    // Un collage parti avant que le toucher ait donné le focus déclenche une alerte d'iOS.
    let _turn = sim.agent_turn.lock().await;
    sim.agent_attach(&device.udid).await?;
    let size = sim.image_size().ok_or("The screen is not available yet.")?;
    let before = sim.frame_count();
    let mut first_change = FIRST_CHANGE;
    let mut note = "";
    match action {
        "screenshot" => first_change = if sim.agent_is_current() { POLL_WAIT } else { Duration::ZERO },
        "tap" => {
            let (x, y) = point(args, ("x", "y"), size)?;
            sim.require_input()?;
            let hold = args["duration"].as_f64().map_or(TAP, |s| Duration::from_secs_f64(s.clamp(0.02, 10.0)));
            sim.send_line(format!("touch down {:.4} {:.4} 0", x / size.0, y / size.1));
            tokio::time::sleep(hold).await;
            sim.send_line(format!("touch up {:.4} {:.4}", x / size.0, y / size.1));
        }
        "swipe" => {
            let (x, y) = point(args, ("x", "y"), size)?;
            let (x2, y2) = point(args, ("x2", "y2"), size)?;
            sim.require_input()?;
            let length = args["duration"].as_f64().unwrap_or(0.3).clamp(0.1, 5.0);
            let steps = (length / SWIPE_TICK).round().max(5.0) as u32;
            sim.send_line(format!("touch down {:.4} {:.4} {}", x / size.0, y / size.1, edge_of(x, y, size)));
            for step in 1..=steps {
                tokio::time::sleep(Duration::from_secs_f64(SWIPE_TICK)).await;
                let t = f64::from(step) / f64::from(steps);
                sim.send_line(format!("touch move {:.4} {:.4}", (x + (x2 - x) * t) / size.0, (y + (y2 - y) * t) / size.1));
            }
            sim.send_line(format!("touch up {:.4} {:.4}", x2 / size.0, y2 / size.1));
        }
        "type" => {
            let text = args["text"].as_str().ok_or("text is required.")?;
            sim.require_input()?;
            let layout = simulator::keyboard_settings(&device.udid).await;
            let layout = layout_from(layout.0.as_deref(), layout.1.as_deref());
            match layout.and_then(|layout| strokes(text, layout)) {
                Some(keys) => {
                    for (code, shift) in keys {
                        if shift {
                            sim.send_line(format!("key down {SHIFT_KEY}"));
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                        sim.send_line(format!("key down {code}"));
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        sim.send_line(format!("key up {code}"));
                        if shift {
                            tokio::time::sleep(Duration::from_millis(20)).await;
                            sim.send_line(format!("key up {SHIFT_KEY}"));
                        }
                        tokio::time::sleep(Duration::from_millis(30)).await;
                    }
                }
                None => {
                    // Disposition inconnue, caractère absent ou texte long : le presse-papiers accepte tout,
                    // mais iOS demande alors la permission de coller.
                    simulator::copy_to_device(&device.udid, text).await?;
                    sim.send_line(format!("key down {COMMAND_KEY}"));
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    sim.send_line(format!("key down {V_KEY}"));
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    sim.send_line(format!("key up {V_KEY}"));
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    sim.send_line(format!("key up {COMMAND_KEY}"));
                    note = " The text was pasted: if iOS asks to allow it, tap allow.";
                }
            }
        }
        "key" => {
            let name = args["text"].as_str().ok_or("text is required.")?;
            let code = key_code(name).ok_or_else(|| format!("Unknown key {name}."))?;
            sim.require_input()?;
            sim.send_line(format!("key down {code}"));
            tokio::time::sleep(Duration::from_millis(40)).await;
            sim.send_line(format!("key up {code}"));
        }
        "home" => {
            sim.require_input()?;
            sim.send_line("home".to_string());
        }
        "open_url" => {
            let url = args["text"].as_str().ok_or("text is required: the URL.")?;
            simulator::open_url(&device.udid, url).await?;
        }
        other => return Err(format!("Unknown action {other}.")),
    }

    let frame = sim.settled(before, first_change).await.ok_or("The screen is not available yet.")?;
    sim.agent_saw_latest();
    let data = base64::engine::general_purpose::STANDARD.encode(frame.as_slice());
    // Sans cette précision, une capture trop tôt se lit comme une action sans effet.
    let unchanged = if !first_change.is_zero() && sim.frame_count() == before { " Nothing has changed on screen yet: it may still be reacting, take another screenshot before concluding." } else { "" };
    Ok(json!([
        { "type": "text", "text": format!("{}, screen {}x{}.{note}{unchanged}", device.name, size.0, size.1) },
        { "type": "image", "data": data, "mimeType": "image/jpeg" }
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(udid: &str, name: &str, state: &str) -> SimDevice {
        SimDevice { udid: udid.into(), name: name.into(), state: state.into(), runtime: "iOS 27.0".into() }
    }

    #[test]
    fn plusieurs_appareils_demarres_sans_choix_est_une_erreur() {
        let list = [device("a", "iPhone A", "Booted"), device("b", "iPhone B", "Booted")];
        let message = resolve(&list, None, None).unwrap_err();
        assert!(message.contains("iPhone A") && message.contains("iPhone B"));
    }

    #[test]
    fn le_panneau_decide_si_son_appareil_est_demarre() {
        let list = [device("a", "iPhone A", "Booted"), device("b", "iPhone B", "Booted"), device("c", "iPhone C", "Shutdown")];
        assert_eq!(resolve(&list, None, Some("b")).unwrap().udid, "b");
        // Éteint : on ne se rabat pas sur un autre sans le dire.
        assert!(resolve(&list, None, Some("c")).is_err());
    }

    #[test]
    fn le_seul_demarre_sert_par_defaut() {
        let list = [device("a", "iPhone A", "Shutdown"), device("b", "iPhone B", "Booted")];
        assert_eq!(resolve(&list, None, None).unwrap().udid, "b");
        assert!(resolve(&list[..1], None, None).is_err());
    }

    #[test]
    fn un_nom_prefere_l_appareil_demarre() {
        let list = [device("a", "iPhone 17e", "Shutdown"), device("b", "iphone 17E", "Booted")];
        assert_eq!(resolve(&list, Some("iPhone 17e"), None).unwrap().udid, "b");
        assert_eq!(resolve(&list, Some("a"), None).unwrap().udid, "a");
        assert!(resolve(&list, Some("iPad"), None).is_err());
    }

    #[test]
    fn un_geste_part_d_un_bord_seulement_tout_pres() {
        let size = (585.0, 1266.0);
        assert_eq!(edge_of(290.0, 1264.0, size), 3);
        assert_eq!(edge_of(2.0, 600.0, size), 2);
        assert_eq!(edge_of(583.0, 600.0, size), 4);
        assert_eq!(edge_of(290.0, 3.0, size), 1);
        assert_eq!(edge_of(290.0, 600.0, size), 0);
    }

    #[test]
    fn un_point_hors_de_la_capture_est_refuse() {
        let size = (585.0, 1266.0);
        assert_eq!(point(&json!({ "x": 10, "y": 20 }), ("x", "y"), size), Ok((10.0, 20.0)));
        assert!(point(&json!({ "x": 900, "y": 20 }), ("x", "y"), size).is_err());
        assert!(point(&json!({ "x": 10 }), ("x", "y"), size).is_err());
    }

    #[test]
    fn la_frappe_suit_la_disposition() {
        assert_eq!(strokes("aA", Layout::Azerty), Some(vec![(20, false), (20, true)]));
        assert_eq!(strokes("aA", Layout::Qwerty), Some(vec![(4, false), (4, true)]));
        // Sur AZERTY, les chiffres demandent Maj.
        assert_eq!(strokes("1", Layout::Azerty), Some(vec![(30, true)]));
        assert_eq!(strokes("1", Layout::Qwerty), Some(vec![(30, false)]));
        assert_eq!(strokes("@", Layout::Azerty), Some(vec![(100, false)]));
        assert_eq!(strokes("ê", Layout::Azerty), Some(vec![(47, false), (8, false)]));
        assert_eq!(strokes("ï", Layout::Azerty), Some(vec![(47, true), (12, false)]));
    }

    #[test]
    fn sans_touche_on_colle() {
        assert_eq!(strokes("é", Layout::Qwerty), None);
        assert_eq!(strokes("✓", Layout::Azerty), None);
        assert_eq!(strokes("É", Layout::Azerty), None);
        assert_eq!(strokes(&"a".repeat(TYPE_MAX + 1), Layout::Qwerty), None);
    }

    #[test]
    fn disposition_lue_dans_les_reglages() {
        let languages = "(\n    \"fr-FR\"\n)";
        assert_eq!(layout_from(None, Some(languages)), Some(Layout::Azerty));
        assert_eq!(layout_from(None, Some("(\n    \"en-US\"\n)")), Some(Layout::Qwerty));
        // Le britannique place @ et " ailleurs : mieux vaut coller que se tromper.
        assert_eq!(layout_from(None, Some("(\n    \"en-GB\"\n)")), None);
        assert_eq!(layout_from(Some("(\n    \"de_DE@sw=QWERTZ;hw=Automatic\"\n)"), Some(languages)), None);
        assert_eq!(layout_from(Some("(\n    \"en_US@sw=QWERTY;hw=Automatic\"\n)"), Some(languages)), Some(Layout::Qwerty));
        assert_eq!(layout_from(None, None), None);
    }

    #[test]
    fn touches_connues() {
        assert_eq!(key_code("Return"), Some(40));
        assert_eq!(key_code("up"), Some(82));
        assert_eq!(key_code("f13"), None);
    }
}
