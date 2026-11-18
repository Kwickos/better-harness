//! Ce que le composer propose après « @ » : fichiers et dossiers du projet,
//! ou contenu d'un chemin absolu quand on en tape un.
//! Le parcours est borné : on s'arrête dès qu'il y a de quoi remplir le menu.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

/// Dossiers jamais proposés : du bruit, et parfois des dizaines de milliers d'entrées.
const SKIP: [&str; 12] = [
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "target",
    ".turbo",
    ".cache",
    "vendor",
    "coverage",
    ".venv",
    "__pycache__",
];
const MAX_RESULTS: usize = 40;
const MAX_DEPTH: usize = 6;
/// Plafond d'entrées lues, pour un dossier immense sans résultat.
const MAX_VISITED: usize = 20_000;

fn is_dir(entry: &std::fs::DirEntry) -> bool {
    // Un lien symbolique n'est pas suivi : il pourrait boucler ou sortir du projet.
    entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
}

/// Chemins relatifs à `root` qui contiennent `query`, les plus courts d'abord. Un dossier finit par `/`.
fn search_project(root: &Path, query: &str) -> Vec<String> {
    let needle = query.to_lowercase();
    let mut results = Vec::new();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut visited = 0;
    'walk: while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_VISITED || results.len() >= MAX_RESULTS {
                break 'walk;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SKIP.contains(&name.as_str()) {
                continue;
            }
            let path = entry.path();
            let dir_entry = is_dir(&entry);
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
            let shown = if dir_entry { format!("{rel}/") } else { rel };
            if needle.is_empty() || shown.to_lowercase().contains(&needle) {
                results.push(shown);
            }
            if dir_entry && depth < MAX_DEPTH {
                queue.push_back((path, depth + 1));
            }
        }
    }
    results.sort_by_key(|p: &String| p.chars().count());
    results
}

/// Contenu d'un dossier désigné par un chemin absolu : `/a/b/` liste `b`, `/a/b/c` filtre sur `c`.
fn browse(typed: &str, home: &Path) -> Vec<String> {
    let expanded: PathBuf = match typed.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if typed == "~" => home.to_path_buf(),
        None => PathBuf::from(typed),
    };
    let lists_children = typed.ends_with('/') || typed == "~";
    let (parent, prefix) = if lists_children {
        (expanded, String::new())
    } else {
        let name = expanded.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        (expanded.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("/")), name)
    };
    let Ok(entries) = std::fs::read_dir(&parent) else { return vec![] };
    let mut found: Vec<(bool, String)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.to_lowercase().starts_with(&prefix) || (name.starts_with('.') && !prefix.starts_with('.')) {
                return None;
            }
            let dir_entry = is_dir(&e);
            let full = e.path().to_string_lossy().into_owned();
            Some((dir_entry, if dir_entry { format!("{full}/") } else { full }))
        })
        .collect();
    // Les dossiers d'abord : on navigue vers eux.
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    found.truncate(MAX_RESULTS);
    found.into_iter().map(|(_, p)| p).collect()
}

pub fn search(cwd: &str, query: &str) -> Vec<String> {
    if query.starts_with('/') || query.starts_with("~/") || query == "~" {
        return browse(query, &dirs::home_dir().unwrap_or_default());
    }
    let root = Path::new(cwd);
    if root.is_dir() {
        search_project(root, query)
    } else {
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> PathBuf {
        let root = std::env::temp_dir().join(format!("bh-mentions-{}", uuid::Uuid::new_v4()));
        for dir in ["src/ui", "node_modules/lib", ".git/objects", "dossier avec espace"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in ["src/main.ts", "src/ui/menu.ts", "node_modules/lib/index.js", ".git/objects/x", ".env", "README.md", "dossier avec espace/note.md"] {
            std::fs::write(root.join(file), "").unwrap();
        }
        root
    }

    #[test]
    fn recherche_dans_le_projet() {
        let root = tree();
        let all = search_project(&root, "");
        assert!(all.contains(&"src/".to_string()), "{all:?}");
        assert!(all.contains(&"src/ui/menu.ts".to_string()), "{all:?}");
        assert!(all.contains(&"dossier avec espace/note.md".to_string()), "{all:?}");
        // Le bruit et les fichiers cachés restent dehors.
        assert!(!all.iter().any(|p| p.contains("node_modules") || p.contains(".git") || p.contains(".env")), "{all:?}");
        // Les plus courts d'abord.
        assert!(all.windows(2).all(|w| w[0].chars().count() <= w[1].chars().count()), "{all:?}");

        assert_eq!(search_project(&root, "MENU"), ["src/ui/menu.ts"]);
        assert_eq!(search_project(&root, "src/ui/"), ["src/ui/", "src/ui/menu.ts"]);
        assert!(search_project(&root, "introuvable").is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn resultats_bornes() {
        let root = std::env::temp_dir().join(format!("bh-mentions-many-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for i in 0..120 {
            std::fs::write(root.join(format!("f{i}.txt")), "").unwrap();
        }
        assert_eq!(search_project(&root, "").len(), MAX_RESULTS);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn chemin_absolu() {
        let root = tree();
        let base = root.to_string_lossy().into_owned();
        let listed = browse(&format!("{base}/"), &root);
        assert_eq!(listed.first().map(String::as_str), Some(format!("{base}/dossier avec espace/").as_str()), "{listed:?}");
        assert!(listed.contains(&format!("{base}/README.md")), "{listed:?}");
        assert!(!listed.iter().any(|p| p.ends_with(".env")), "{listed:?}");
        assert_eq!(browse(&format!("{base}/sr"), &root), [format!("{base}/src/")]);
        assert_eq!(browse(&format!("{base}/.en"), &root), [format!("{base}/.env")]);
        assert_eq!(browse("~/sr", &root), [format!("{base}/src/")]);
        assert!(browse("/chemin/qui/n/existe/pas/", &root).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }
}
