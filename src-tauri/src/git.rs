//! Modifications du dossier de travail, lues avec `git`.
//! Rien n'est gardé en mémoire : l'interface redemande l'état quand les fichiers ont pu changer.
//! Les pilotes externes du dépôt (diff.external, textconv, fsmonitor) sont désactivés :
//! ouvrir un projet ne doit lancer aucun programme qu'il aurait configuré.

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const DIFF_MAX: usize = 400 * 1024;
const FILES_MAX: usize = 500;
/// Fichiers non suivis dont on compte les lignes, et taille au-delà de laquelle on renonce.
const COUNT_FILES_MAX: usize = 200;
const COUNT_BYTES_MAX: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub old_path: Option<String>,
    /// M modifié, A ajouté, D supprimé, R renommé, U en conflit, ? non suivi.
    pub status: String,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub root: String,
    pub has_head: bool,
    pub branch: Option<String>,
    pub files: Vec<GitFile>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
}

struct Output {
    ok: bool,
    stdout: Vec<u8>,
    truncated: bool,
}

async fn git(env_path: &str, dir: &Path, args: &[&str], max: usize) -> Result<Output, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .env("PATH", env_path)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Impossible de lancer git : {e}"))?;
    let mut stdout = child.stdout.take().ok_or("Sortie de git indisponible.")?;
    let work = async {
        let mut out = Vec::new();
        (&mut stdout).take(max as u64 + 1).read_to_end(&mut out).await?;
        let truncated = out.len() > max;
        if truncated {
            out.truncate(max);
            let _ = child.start_kill();
        }
        let status = child.wait().await?;
        Ok::<_, std::io::Error>(Output { ok: status.success(), stdout: out, truncated })
    };
    tokio::time::timeout(Duration::from_secs(20), work)
        .await
        .map_err(|_| "git met trop de temps à répondre.".to_string())?
        .map_err(|e| e.to_string())
}

fn text(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn literal(path: &str) -> String {
    format!(":(literal){path}")
}

/// `git status --porcelain=v1 -z` : « XY chemin », suivi de l'ancien chemin pour un renommage.
fn parse_status(raw: &[u8]) -> Vec<GitFile> {
    let mut tokens = raw.split(|b| *b == 0).filter(|t| !t.is_empty());
    let mut files = Vec::new();
    while let Some(entry) = tokens.next() {
        if entry.len() < 4 {
            continue;
        }
        let (x, y) = (entry[0] as char, entry[1] as char);
        let path = String::from_utf8_lossy(&entry[3..]).into_owned();
        let renamed = x == 'R' || y == 'R' || x == 'C' || y == 'C';
        let old_path = if renamed { tokens.next().map(|t| String::from_utf8_lossy(t).into_owned()) } else { None };
        let conflict = x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D');
        let status = if x == '?' {
            "?"
        } else if conflict {
            "U"
        } else if renamed {
            "R"
        } else if x == 'A' {
            "A"
        } else if x == 'D' || y == 'D' {
            "D"
        } else {
            "M"
        };
        files.push(GitFile { path, old_path, status: status.to_string(), added: None, removed: None });
    }
    files
}

/// `git diff --numstat -z` : « ajouts\tretraits\tchemin », ou chemin vide suivi de l'ancien et du nouveau.
fn apply_numstat(raw: &[u8], files: &mut [GitFile]) {
    let mut tokens = raw.split(|b| *b == 0);
    while let Some(entry) = tokens.next() {
        let entry = String::from_utf8_lossy(entry);
        let mut parts = entry.splitn(3, '\t');
        let (Some(a), Some(r), Some(p)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let path = if p.is_empty() {
            let _old = tokens.next();
            tokens.next().map(|t| String::from_utf8_lossy(t).into_owned()).unwrap_or_default()
        } else {
            p.to_string()
        };
        if let Some(f) = files.iter_mut().find(|f| f.path == path) {
            f.added = a.parse().ok();
            f.removed = r.parse().ok();
        }
    }
}

fn count_lines(path: &Path) -> Option<u32> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > COUNT_BYTES_MAX {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u32;
    Some(if bytes.last().is_some_and(|b| *b != b'\n') { newlines + 1 } else { newlines })
}

pub async fn status(env_path: &str, cwd: &str) -> Result<GitStatus, String> {
    let dir = Path::new(cwd);
    if !dir.is_dir() {
        return Ok(GitStatus::default());
    }
    let top = git(env_path, dir, &["rev-parse", "--show-toplevel"], 8192).await?;
    if !top.ok {
        return Ok(GitStatus::default());
    }
    let root = text(&top);
    let root_path = Path::new(&root);
    let has_head = git(env_path, root_path, &["rev-parse", "-q", "--verify", "HEAD"], 256).await?.ok;
    let named = git(env_path, root_path, &["symbolic-ref", "--short", "-q", "HEAD"], 1024).await?;
    let branch = if named.ok {
        Some(text(&named))
    } else {
        let short = git(env_path, root_path, &["rev-parse", "--short", "HEAD"], 256).await?;
        short.ok.then(|| text(&short))
    };

    let listing = git(env_path, root_path, &["status", "--porcelain=v1", "-z", "--untracked-files=all"], 16 * 1024 * 1024).await?;
    if !listing.ok {
        return Err("git status a échoué.".into());
    }
    let mut files = parse_status(&listing.stdout);
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let truncated = listing.truncated || files.len() > FILES_MAX;
    files.truncate(FILES_MAX);

    let base = if has_head { "HEAD" } else { "--cached" };
    let numstat = git(env_path, root_path, &["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", base], 16 * 1024 * 1024).await?;
    apply_numstat(&numstat.stdout, &mut files);
    for f in files.iter_mut().filter(|f| f.status == "?").take(COUNT_FILES_MAX) {
        f.added = count_lines(&root_path.join(&f.path));
        f.removed = f.added.map(|_| 0);
    }
    Ok(GitStatus { is_repo: true, root, has_head, branch, files, truncated })
}

async fn find(env_path: &str, cwd: &str, path: &str) -> Result<(GitStatus, GitFile), String> {
    let st = status(env_path, cwd).await?;
    // Seul un chemin listé par git est accepté : pas de sortie du dépôt possible.
    let file = st.files.iter().find(|f| f.path == path).cloned().ok_or_else(|| format!("{path} n'a plus de modification."))?;
    if Path::new(path).components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
        return Err("Chemin invalide.".into());
    }
    Ok((st, file))
}

pub async fn diff(env_path: &str, cwd: &str, path: &str) -> Result<GitDiff, String> {
    let (st, file) = find(env_path, cwd, path).await?;
    let root = Path::new(&st.root);
    let out = if file.status == "?" {
        // Pour --no-index, git signale une différence par le code de sortie 1 : ce n'est pas une erreur.
        git(env_path, root, &["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", path], DIFF_MAX).await?
    } else {
        let new = literal(path);
        let old = file.old_path.as_deref().map(literal);
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", if st.has_head { "HEAD" } else { "--cached" }, "--", &new];
        if let Some(o) = &old {
            args.push(o);
        }
        let out = git(env_path, root, &args, DIFF_MAX).await?;
        if !out.ok && !out.truncated {
            return Err("git diff a échoué.".into());
        }
        out
    };
    let raw = String::from_utf8_lossy(&out.stdout);
    let text = if out.truncated { raw.rfind('\n').map_or("", |i| &raw[..i]).to_string() } else { raw.into_owned() };
    let binary = text.starts_with("Binary files ") || text.contains("\nBinary files ") || text.contains("\nGIT binary patch");
    Ok(GitDiff { text, truncated: out.truncated, binary })
}

/// Rétablit la dernière version d'un fichier. La version actuelle passe par `trash`, donc rien n'est perdu.
pub async fn discard<F>(env_path: &str, cwd: &str, path: &str, trash: F) -> Result<(), String>
where
    F: Fn(&[PathBuf]) -> Result<(), String>,
{
    let (st, file) = find(env_path, cwd, path).await?;
    let root = Path::new(&st.root);
    let abs = root.join(&file.path);
    let run = |args: Vec<String>| async move {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        match git(env_path, root, &refs, 64 * 1024).await {
            Ok(o) if o.ok => Ok(()),
            Ok(_) => Err(format!("La commande git {} a échoué.", args[0])),
            Err(e) => Err(e),
        }
    };
    let unstage = |p: &str| vec!["rm".to_string(), "--cached".into(), "-q".into(), "-f".into(), "--".into(), literal(p)];
    let restore = |p: &str| vec!["restore".to_string(), "--source=HEAD".into(), "--staged".into(), "--worktree".into(), "--".into(), literal(p)];
    let exists = std::fs::symlink_metadata(&abs).is_ok();
    match file.status.as_str() {
        "U" => Err("Résous d'abord le conflit sur ce fichier.".into()),
        "?" => trash(&[abs]),
        "A" => {
            if exists {
                trash(&[abs])?;
            }
            run(unstage(path)).await
        }
        "R" => {
            let old = file.old_path.as_deref().ok_or("Ancien chemin inconnu.")?;
            if exists {
                trash(&[abs])?;
            }
            run(unstage(path)).await?;
            run(restore(old)).await
        }
        _ => {
            if !st.has_head {
                return Err("Ce dépôt n'a encore aucun commit à rétablir.".into());
            }
            if exists {
                trash(&[abs])?;
            }
            run(restore(path)).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as Sync;

    fn env_path() -> String {
        std::env::var("PATH").unwrap_or_default()
    }

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Sync::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
            .args(args)
            .output()
            .unwrap();
        assert!(ok.status.success(), "git {args:?} : {}", String::from_utf8_lossy(&ok.stderr));
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bh-git-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // /tmp est un lien sur macOS : git renvoie le chemin résolu.
        dir.canonicalize().unwrap()
    }

    fn repo() -> PathBuf {
        let dir = temp_dir("repo");
        sh(&dir, &["init", "-q"]);
        std::fs::write(dir.join("garde.txt"), "un\ndeux\ntrois\n").unwrap();
        std::fs::write(dir.join("suppr.txt"), "a\nb\n").unwrap();
        std::fs::write(dir.join("ancien.txt"), "ligne\n".repeat(20)).unwrap();
        sh(&dir, &["add", "."]);
        sh(&dir, &["commit", "-q", "-m", "base"]);
        dir
    }

    /// Remplace la corbeille : déplace dans un dossier pour vérifier que rien n'est perdu.
    fn fake_trash(bin: PathBuf) -> impl Fn(&[PathBuf]) -> Result<(), String> {
        move |paths: &[PathBuf]| {
            std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
            for p in paths {
                std::fs::rename(p, bin.join(p.file_name().unwrap())).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }

    fn block<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn hors_depot() {
        let dir = temp_dir("plain");
        let st = block(status(&env_path(), dir.to_str().unwrap())).unwrap();
        assert!(!st.is_repo && st.files.is_empty());
        let gone = block(status(&env_path(), "/chemin/qui/n/existe/pas")).unwrap();
        assert!(!gone.is_repo);
    }

    #[test]
    fn statuts_compteurs_et_diff() {
        let dir = repo();
        let cwd = dir.to_str().unwrap();
        std::fs::write(dir.join("garde.txt"), "un\nDEUX\ntrois\nquatre\n").unwrap();
        std::fs::remove_file(dir.join("suppr.txt")).unwrap();
        std::fs::write(dir.join("avec espace é.txt"), "x\ny\nsans fin de ligne").unwrap();
        std::fs::write(dir.join("indexe.txt"), "n\n").unwrap();
        sh(&dir, &["add", "indexe.txt"]);
        sh(&dir, &["mv", "ancien.txt", "nouveau.txt"]);
        std::fs::write(dir.join("binaire.bin"), [0u8, 1, 2, 3]).unwrap();

        let st = block(status(&env_path(), cwd)).unwrap();
        assert!(st.is_repo && st.has_head);
        assert_eq!(st.branch.as_deref(), Some("main"));
        let by = |p: &str| st.files.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p} absent : {:?}", st.files));
        assert_eq!((by("garde.txt").status.as_str(), by("garde.txt").added, by("garde.txt").removed), ("M", Some(2), Some(1)));
        assert_eq!((by("suppr.txt").status.as_str(), by("suppr.txt").removed), ("D", Some(2)));
        assert_eq!((by("avec espace é.txt").status.as_str(), by("avec espace é.txt").added), ("?", Some(3)));
        assert_eq!((by("indexe.txt").status.as_str(), by("indexe.txt").added), ("A", Some(1)));
        assert_eq!((by("nouveau.txt").status.as_str(), by("nouveau.txt").old_path.as_deref()), ("R", Some("ancien.txt")));
        assert_eq!(by("binaire.bin").added, None);

        let d = block(diff(&env_path(), cwd, "garde.txt")).unwrap();
        assert!(d.text.contains("-deux") && d.text.contains("+DEUX") && !d.binary && !d.truncated);
        let new = block(diff(&env_path(), cwd, "avec espace é.txt")).unwrap();
        assert!(new.text.contains("+x"));
        let bin = block(diff(&env_path(), cwd, "binaire.bin")).unwrap();
        assert!(bin.binary, "{}", bin.text);
        let ren = block(diff(&env_path(), cwd, "nouveau.txt")).unwrap();
        assert!(ren.text.contains("rename from ancien.txt") || ren.text.contains("similarity"), "{}", ren.text);
        assert!(block(diff(&env_path(), cwd, "../dehors.txt")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn retablir_garde_une_copie() {
        let dir = repo();
        let cwd = dir.to_str().unwrap();
        let bin = temp_dir("bin");
        let trash = fake_trash(bin.clone());
        std::fs::write(dir.join("garde.txt"), "travail en cours\n").unwrap();
        std::fs::remove_file(dir.join("suppr.txt")).unwrap();
        std::fs::write(dir.join("neuf.txt"), "neuf\n").unwrap();
        std::fs::write(dir.join("indexe.txt"), "n\n").unwrap();
        sh(&dir, &["add", "indexe.txt"]);
        sh(&dir, &["mv", "ancien.txt", "nouveau.txt"]);

        block(discard(&env_path(), cwd, "garde.txt", &trash)).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("garde.txt")).unwrap(), "un\ndeux\ntrois\n");
        assert_eq!(std::fs::read_to_string(bin.join("garde.txt")).unwrap(), "travail en cours\n");

        block(discard(&env_path(), cwd, "suppr.txt", &trash)).unwrap();
        assert!(dir.join("suppr.txt").is_file());

        block(discard(&env_path(), cwd, "neuf.txt", &trash)).unwrap();
        assert!(!dir.join("neuf.txt").exists() && bin.join("neuf.txt").is_file());

        block(discard(&env_path(), cwd, "indexe.txt", &trash)).unwrap();
        assert!(!dir.join("indexe.txt").exists() && bin.join("indexe.txt").is_file());

        block(discard(&env_path(), cwd, "nouveau.txt", &trash)).unwrap();
        assert!(dir.join("ancien.txt").is_file() && !dir.join("nouveau.txt").exists());

        assert!(block(status(&env_path(), cwd)).unwrap().files.is_empty());
        // Un chemin que git ne liste pas est refusé, et rien ne bouge.
        assert!(block(discard(&env_path(), cwd, "garde.txt", &trash)).is_err());
        assert!(block(discard(&env_path(), cwd, "../autre/fichier", &trash)).is_err());
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(bin);
    }

    #[test]
    fn depot_sans_commit() {
        let dir = temp_dir("empty");
        sh(&dir, &["init", "-q"]);
        std::fs::write(dir.join("indexe.txt"), "a\nb\n").unwrap();
        std::fs::write(dir.join("libre.txt"), "c\n").unwrap();
        sh(&dir, &["add", "indexe.txt"]);
        let cwd = dir.to_str().unwrap();
        let st = block(status(&env_path(), cwd)).unwrap();
        assert!(st.is_repo && !st.has_head);
        assert_eq!(st.files.len(), 2);
        assert_eq!(st.files.iter().find(|f| f.path == "indexe.txt").unwrap().added, Some(2));
        let d = block(diff(&env_path(), cwd, "indexe.txt")).unwrap();
        assert!(d.text.contains("+a"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn numstat_de_renommage() {
        let mut files = vec![GitFile { path: "b.txt".into(), old_path: Some("a.txt".into()), status: "R".into(), added: None, removed: None }];
        apply_numstat(b"1\t2\t\0a.txt\0b.txt\0", &mut files);
        assert_eq!((files[0].added, files[0].removed), (Some(1), Some(2)));
    }
}
