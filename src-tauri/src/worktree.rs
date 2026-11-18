//! Git worktrees for conversations, made the way Claude Desktop makes them: each one lives in
//! `<repo>/.claude/worktrees/<name>`, on its own branch `<prefix>/<name>`.
//! Nothing is lost when one goes away: git deletes a clean worktree, a worktree with changes goes
//! to the Trash, and its branch stays as long as it holds commits of its own.

use crate::i18n::tr;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;

/// Where worktrees go, inside the main checkout of the repository.
pub const DIR: &str = ".claude/worktrees";
/// Files git ignores that a new worktree needs (`.env`…), in gitignore syntax.
const INCLUDE_FILE: &str = ".worktreeinclude";
const INCLUDE_MAX: usize = 2000;
const SLUG_WORDS: usize = 4;
const SLUG_MAX: usize = 32;
const PREFIX_MAX: usize = 40;
/// A checkout can take a while in a large repository.
const CHECKOUT_SECS: u64 = 300;
const QUICK_SECS: u64 = 20;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    /// Main checkout of the repository.
    pub repo: String,
    pub branch: String,
    /// Branch (or commit) the worktree started from.
    pub base: String,
    /// Commit it started from: the branch holds work of its own once it moves past it.
    pub base_commit: String,
    pub created_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeState {
    #[serde(flatten)]
    pub worktree: Worktree,
    pub exists: bool,
    /// Uncommitted changes, untracked files included.
    pub dirty: usize,
    /// Commits made on the branch since the worktree was created.
    pub commits: usize,
}

/// What a folder offers to start a worktree from.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub is_repo: bool,
    pub has_head: bool,
    pub current: Option<String>,
    /// Local branches, the most recently used first.
    pub list: Vec<String>,
}

struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
}

async fn git(env_path: &str, dir: &Path, args: &[&str], secs: u64) -> Result<Out, String> {
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
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(secs), cmd.output())
        .await
        .map_err(|_| tr("git is taking too long to answer.", "git met trop de temps à répondre.").to_string())?
        .map_err(|e| tr(format!("Could not run git: {e}"), format!("Impossible de lancer git : {e}")))?;
    Ok(Out {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).trim_end().to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Runs git and expects it to succeed: the error is git's own message.
async fn must(env_path: &str, dir: &Path, args: &[&str], secs: u64) -> Result<String, String> {
    let out = git(env_path, dir, args, secs).await?;
    if out.ok {
        Ok(out.stdout)
    } else {
        Err(failure(args[0], &out.stderr))
    }
}

fn failure(command: &str, stderr: &str) -> String {
    let detail = stderr.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("");
    let detail = detail.trim_start_matches("fatal: ").trim_start_matches("error: ");
    if detail.is_empty() {
        tr(format!("The git {command} command failed."), format!("La commande git {command} a échoué."))
    } else {
        tr(format!("git {command}: {detail}"), format!("git {command} : {detail}"))
    }
}

fn not_repo() -> String {
    tr("This folder is not a git repository.", "Ce dossier n'est pas un dépôt git.").into()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Common accented letters, so a French title still gives a readable name.
fn ascii(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => "a",
        'ç' => "c",
        'è' | 'é' | 'ê' | 'ë' => "e",
        'ì' | 'í' | 'î' | 'ï' => "i",
        'ñ' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => "o",
        'ù' | 'ú' | 'û' | 'ü' => "u",
        'ý' | 'ÿ' => "y",
        'œ' => "oe",
        'æ' => "ae",
        'ß' => "ss",
        _ => return None,
    })
}

/// The first words of the request, as a folder and branch name: "Fix the login bug" → "fix-the-login-bug".
pub fn slug(text: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            word.push(c);
        } else if let Some(s) = ascii(c) {
            word.push_str(s);
        } else if c == '\'' || c == '’' {
            // Elision: "l'app" stays one word.
        } else if !word.is_empty() {
            words.push(std::mem::take(&mut word));
            if words.len() == SLUG_WORDS {
                break;
            }
        }
    }
    if !word.is_empty() && words.len() < SLUG_WORDS {
        words.push(word);
    }
    let mut out = String::new();
    for w in words {
        if !out.is_empty() && out.len() + 1 + w.len() > SLUG_MAX {
            break;
        }
        if !out.is_empty() {
            out.push('-');
        }
        out.push_str(&w);
    }
    out.truncate(SLUG_MAX);
    if out.is_empty() {
        "session".into()
    } else {
        out
    }
}

/// The prefix the user set, kept to what a branch name allows ("claude" when nothing is left).
pub fn clean_prefix(prefix: &str) -> String {
    let p: String = prefix.trim().trim_matches('/').chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')).take(PREFIX_MAX).collect();
    let p = p.trim_start_matches(|c: char| !c.is_ascii_alphanumeric()).trim_end_matches('.');
    if p.is_empty() {
        "claude".into()
    } else {
        p.to_string()
    }
}

/// The main checkout of the repository a folder belongs to (from a worktree too).
async fn main_root(env_path: &str, dir: &Path) -> Result<PathBuf, String> {
    let list = git(env_path, dir, &["worktree", "list", "--porcelain"], QUICK_SECS).await?;
    if !list.ok {
        return Err(not_repo());
    }
    let mut first = list.stdout.split("\n\n").next().unwrap_or("").lines();
    let root = first.next().and_then(|l| l.strip_prefix("worktree ")).ok_or_else(not_repo)?.to_string();
    if first.any(|l| l == "bare") {
        return Err(tr("Bare repositories have no checkout to start from.", "Un dépôt nu n'a pas de copie de travail d'où partir.").into());
    }
    Ok(PathBuf::from(root))
}

async fn current_branch(env_path: &str, dir: &Path) -> Result<Option<String>, String> {
    let named = git(env_path, dir, &["symbolic-ref", "--short", "-q", "HEAD"], QUICK_SECS).await?;
    Ok(named.ok.then_some(named.stdout).filter(|b| !b.is_empty()))
}

async fn branch_exists(env_path: &str, repo: &Path, branch: &str) -> Result<bool, String> {
    Ok(git(env_path, repo, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")], QUICK_SECS).await?.ok)
}

/// `.claude/worktrees/` stays out of the repository's changes, without touching a tracked file.
async fn exclude(env_path: &str, repo: &Path) -> Result<(), String> {
    let probe = format!("{DIR}/probe");
    if git(env_path, repo, &["check-ignore", "-q", "--no-index", &probe], QUICK_SECS).await?.ok {
        return Ok(());
    }
    let common = must(env_path, repo, &["rev-parse", "--git-common-dir"], QUICK_SECS).await?;
    let file = repo.join(common.trim()).join("info").join("exclude");
    let mut text = std::fs::read_to_string(&file).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!("{DIR}/\n"));
    std::fs::create_dir_all(file.parent().unwrap_or(repo))
        .and_then(|_| std::fs::write(&file, text))
        .map_err(|e| tr(format!("Could not update {}: {e}", file.display()), format!("Impossible de modifier {} : {e}", file.display())))
}

fn inside(rel: &str) -> bool {
    !rel.is_empty() && Path::new(rel).components().all(|c| matches!(c, Component::Normal(_)))
}

/// Copies the untracked files `.worktreeinclude` lists: without its `.env`, a project often can't run.
async fn copy_included(env_path: &str, from: &Path, to: &Path) -> usize {
    if !from.join(INCLUDE_FILE).is_file() {
        return 0;
    }
    let args = ["ls-files", "-z", "--others", "--ignored", "--exclude-from", INCLUDE_FILE];
    let Ok(out) = git(env_path, from, &args, QUICK_SECS).await else { return 0 };
    if !out.ok {
        return 0;
    }
    let files: Vec<String> = out.stdout.split('\0').filter(|p| inside(p)).take(INCLUDE_MAX).map(str::to_string).collect();
    let (from, to) = (from.to_path_buf(), to.to_path_buf());
    tauri::async_runtime::spawn_blocking(move || files.iter().filter(|rel| copy_into(&to, rel, &from.join(rel))).count())
        .await
        .unwrap_or(0)
}

/// Copies one file into the new worktree without ever leaving it. A branch can track a link to any
/// folder: a link on the way stops the copy, and nothing already there is overwritten or followed.
fn copy_into(root: &Path, rel: &str, src: &Path) -> bool {
    let rel = Path::new(rel);
    let Some(name) = rel.file_name() else { return false };
    let mut dir = root.to_path_buf();
    for part in rel.parent().map(Path::components).into_iter().flatten() {
        dir.push(part);
        match std::fs::symlink_metadata(&dir) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return false,
            Err(_) if std::fs::create_dir(&dir).is_ok() => {}
            Err(_) => return false,
        }
    }
    let dst = dir.join(name);
    let Ok(meta) = std::fs::symlink_metadata(src) else { return false };
    if meta.file_type().is_symlink() {
        return std::fs::read_link(src).and_then(|target| std::os::unix::fs::symlink(target, &dst)).is_ok();
    }
    if !meta.is_file() {
        return false;
    }
    let copy = || -> std::io::Result<()> {
        let mut input = std::fs::File::open(src)?;
        // O_EXCL: refuses an existing file, and a link put in its place.
        let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(&dst)?;
        std::io::copy(&mut input, &mut output)?;
        output.set_permissions(meta.permissions())
    };
    copy().is_ok()
}

/// Creates a worktree for a new conversation, from `base` (the folder's current branch by default).
/// Returns it with the number of files copied from `.worktreeinclude`.
pub async fn create(env_path: &str, cwd: &str, base: Option<&str>, prefix: &str, hint: &str) -> Result<(Worktree, usize), String> {
    let dir = Path::new(cwd);
    if !dir.is_dir() {
        return Err(tr(format!("Folder not found: {cwd}"), format!("Dossier introuvable : {cwd}")));
    }
    let top = PathBuf::from(must(env_path, dir, &["rev-parse", "--show-toplevel"], QUICK_SECS).await.map_err(|_| not_repo())?);
    let repo = main_root(env_path, &top).await?;
    let base = match base.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => b.to_string(),
        None => match current_branch(env_path, &top).await? {
            Some(b) => b,
            None => "HEAD".into(),
        },
    };
    let verify = git(env_path, &top, &["rev-parse", "-q", "--verify", "--end-of-options", &format!("{base}^{{commit}}")], QUICK_SECS).await?;
    if !verify.ok {
        return Err(if base == "HEAD" {
            tr("This repository has no commit yet: a worktree starts from one.", "Ce dépôt n'a encore aucun commit : un worktree part d'un commit.").into()
        } else {
            tr(format!("Branch {base} not found."), format!("Branche {base} introuvable."))
        });
    }
    let base_commit = verify.stdout.trim().to_string();
    let base = if base == "HEAD" { base_commit[..base_commit.len().min(7)].to_string() } else { base };
    exclude(env_path, &repo).await?;

    let slug = slug(hint);
    let prefix = clean_prefix(prefix);
    for _ in 0..4 {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let name = format!("{slug}-{}", &id[..6]);
        let mut branch = format!("{prefix}/{name}");
        if !git(env_path, &repo, &["check-ref-format", "--branch", &branch], QUICK_SECS).await?.ok {
            branch = name.clone();
        }
        let path = repo.join(DIR).join(&name);
        if path.exists() || branch_exists(env_path, &repo, &branch).await? {
            continue;
        }
        let path_text = path.to_string_lossy().into_owned();
        must(env_path, &repo, &["worktree", "add", "-b", &branch, &path_text, &base_commit], CHECKOUT_SECS).await?;
        let copied = copy_included(env_path, &top, &path).await;
        let worktree = Worktree {
            path: path_text,
            repo: repo.to_string_lossy().into_owned(),
            branch,
            base,
            base_commit,
            created_ms: now_ms(),
        };
        return Ok((worktree, copied));
    }
    Err(tr("No free name for the worktree.", "Aucun nom libre pour le worktree.").into())
}

/// Commits on the branch since the worktree was created. `None`: the branch no longer exists.
async fn commits(env_path: &str, wt: &Worktree) -> Option<usize> {
    let range = format!("{}..refs/heads/{}", wt.base_commit, wt.branch);
    let out = git(env_path, Path::new(&wt.repo), &["rev-list", "--count", &range], QUICK_SECS).await.ok()?;
    if out.ok {
        out.stdout.trim().parse().ok()
    } else {
        None
    }
}

pub async fn state(env_path: &str, wt: &Worktree) -> WorktreeState {
    let path = Path::new(&wt.path);
    let exists = path.is_dir();
    let dirty = if exists {
        match git(env_path, path, &["status", "--porcelain", "--untracked-files=normal"], QUICK_SECS).await {
            Ok(o) if o.ok => o.stdout.lines().filter(|l| !l.is_empty()).count(),
            _ => 0,
        }
    } else {
        0
    };
    let commits = commits(env_path, wt).await.unwrap_or(0);
    WorktreeState { worktree: wt.clone(), exists, dirty, commits }
}

/// Removes a worktree without losing anything: git deletes it if it is clean, otherwise it goes
/// to the Trash. Its branch goes too when it holds no commit of its own. Returns whether the branch stays.
pub async fn remove<F>(env_path: &str, wt: &Worktree, trash: F) -> Result<bool, String>
where
    F: Fn(&[PathBuf]) -> Result<(), String>,
{
    let repo = Path::new(&wt.repo);
    let path = PathBuf::from(&wt.path);
    if path.exists() {
        // Refused by git when there are changes: they are kept in the Trash.
        let removed = git(env_path, repo, &["worktree", "remove", &wt.path], QUICK_SECS * 3).await.is_ok_and(|o| o.ok);
        if !removed {
            trash(&[path])?;
        }
    }
    let _ = git(env_path, repo, &["worktree", "prune"], QUICK_SECS).await;
    match commits(env_path, wt).await {
        Some(0) => {
            let _ = git(env_path, repo, &["branch", "-D", &wt.branch], QUICK_SECS).await;
            Ok(branch_exists(env_path, repo, &wt.branch).await.unwrap_or(false))
        }
        Some(_) => Ok(true),
        None => Ok(false),
    }
}

/// Puts a removed worktree back in its place (the conversation's transcript is tied to that folder):
/// on its branch if it still exists, otherwise on a new one from the commit it started from.
pub async fn restore(env_path: &str, wt: &Worktree) -> Result<(), String> {
    let repo = Path::new(&wt.repo);
    if !repo.is_dir() {
        return Err(tr(format!("Repository not found: {}", wt.repo), format!("Dépôt introuvable : {}", wt.repo)));
    }
    let _ = git(env_path, repo, &["worktree", "prune"], QUICK_SECS).await;
    if branch_exists(env_path, repo, &wt.branch).await? {
        must(env_path, repo, &["worktree", "add", &wt.path, &wt.branch], CHECKOUT_SECS).await?;
    } else {
        must(env_path, repo, &["worktree", "add", "-b", &wt.branch, &wt.path, &wt.base_commit], CHECKOUT_SECS).await?;
    }
    Ok(())
}

pub async fn branches(env_path: &str, cwd: &str) -> Result<Branches, String> {
    let dir = Path::new(cwd);
    if !dir.is_dir() || !git(env_path, dir, &["rev-parse", "--is-inside-work-tree"], QUICK_SECS).await?.ok {
        return Ok(Branches::default());
    }
    let has_head = git(env_path, dir, &["rev-parse", "-q", "--verify", "HEAD"], QUICK_SECS).await?.ok;
    let current = current_branch(env_path, dir).await?;
    let refs = git(env_path, dir, &["for-each-ref", "--sort=-committerdate", "--count=40", "--format=%(refname:short)", "refs/heads"], QUICK_SECS).await?;
    let list = if refs.ok { refs.stdout.lines().filter(|l| !l.is_empty()).map(str::to_string).collect() } else { vec![] };
    Ok(Branches { is_repo: true, has_head, current, list })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as Sync;

    fn env_path() -> String {
        std::env::var("PATH").unwrap_or_default()
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Sync::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bh-wt-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn repo() -> PathBuf {
        let dir = temp_dir("repo");
        sh(&dir, &["init", "-q"]);
        std::fs::write(dir.join("app.txt"), "one\n").unwrap();
        std::fs::write(dir.join(".gitignore"), ".env\n").unwrap();
        sh(&dir, &["add", "."]);
        sh(&dir, &["commit", "-q", "-m", "base"]);
        dir
    }

    fn block<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    fn fake_trash(bin: PathBuf) -> impl Fn(&[PathBuf]) -> Result<(), String> {
        move |paths: &[PathBuf]| {
            std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
            for p in paths {
                std::fs::rename(p, bin.join(p.file_name().unwrap())).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }

    #[test]
    fn names() {
        assert_eq!(slug("Fix the login bug on Safari please"), "fix-the-login-bug");
        assert_eq!(slug("J'aimerais une vraie gestion des worktrees"), "jaimerais-une-vraie-gestion");
        assert_eq!(slug("Corrige l’écran d’accueil"), "corrige-lecran-daccueil");
        assert_eq!(slug("/compact"), "compact");
        assert_eq!(slug("  ?? "), "session");
        assert_eq!(slug("supercalifragilisticexpialidocious-and-even-more-letters"), "supercalifragilisticexpialidocio");
        assert_eq!(clean_prefix("features"), "features");
        assert_eq!(clean_prefix(" /team/"), "team");
        assert_eq!(clean_prefix("a b"), "ab");
        assert_eq!(clean_prefix("--"), "claude");
    }

    #[test]
    fn create_copy_and_remove() {
        let dir = repo();
        let env = env_path();
        std::fs::write(dir.join(".env"), "SECRET=1\n").unwrap();
        std::fs::write(dir.join(".worktreeinclude"), ".env\n").unwrap();
        let (wt, copied) = block(create(&env, dir.to_str().unwrap(), None, "features", "Fix the login bug")).unwrap();
        assert_eq!(copied, 1);
        assert_eq!(wt.repo, dir.to_string_lossy());
        assert_eq!(wt.base, "main");
        assert!(wt.branch.starts_with("features/fix-the-login-bug-"), "{}", wt.branch);
        assert!(wt.path.starts_with(&format!("{}/.claude/worktrees/fix-the-login-bug-", dir.display())), "{}", wt.path);
        let path = PathBuf::from(&wt.path);
        assert_eq!(std::fs::read_to_string(path.join(".env")).unwrap(), "SECRET=1\n");
        assert_eq!(sh(&path, &["branch", "--show-current"]), wt.branch);
        // The main checkout doesn't see the worktree as a change.
        assert_eq!(sh(&dir, &["status", "--porcelain"]), "?? .worktreeinclude");

        // From the worktree itself, the next one still goes into the main checkout.
        let (other, _) = block(create(&env, &wt.path, None, "", "")).unwrap();
        assert!(other.path.starts_with(&format!("{}/.claude/worktrees/session-", dir.display())), "{}", other.path);
        assert_eq!(other.base, wt.branch);
        assert!(other.branch.starts_with("claude/session-"));

        let st = block(state(&env, &wt));
        assert!(st.exists && st.dirty == 0 && st.commits == 0);
        // Clean and without commits: the folder and the branch go, nothing is lost.
        let bin = temp_dir("bin");
        assert!(!block(remove(&env, &wt, fake_trash(bin.clone()))).unwrap());
        assert!(!path.exists() && std::fs::read_dir(&bin).unwrap().next().is_none());
        assert!(!block(branch_exists(&env, &dir, &wt.branch)).unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn copy_stays_inside() {
        let dir = repo();
        let env = env_path();
        // A branch tracks a link to a folder outside the repository.
        let outside = temp_dir("outside");
        sh(&dir, &["checkout", "-q", "-b", "trap"]);
        std::os::unix::fs::symlink(&outside, dir.join("conf")).unwrap();
        sh(&dir, &["add", "conf"]);
        sh(&dir, &["commit", "-q", "-m", "link"]);
        sh(&dir, &["checkout", "-q", "main"]);
        // Here, `conf` is a real folder, with files `.worktreeinclude` asks to copy.
        std::fs::create_dir(dir.join("conf")).unwrap();
        std::fs::write(dir.join("conf/.env"), "SECRET=1\n").unwrap();
        std::fs::write(dir.join(".env"), "TOP=1\n").unwrap();
        std::fs::write(dir.join(".worktreeinclude"), ".env\n").unwrap();
        let (wt, copied) = block(create(&env, dir.to_str().unwrap(), Some("trap"), "claude", "trap")).unwrap();
        assert_eq!(copied, 1);
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none(), "a file was written outside the worktree");
        assert_eq!(std::fs::read_to_string(Path::new(&wt.path).join(".env")).unwrap(), "TOP=1\n");
        // Nothing already in the worktree is overwritten.
        assert!(!copy_into(Path::new(&wt.path), ".env", &dir.join("conf/.env")));
        assert_eq!(std::fs::read_to_string(Path::new(&wt.path).join(".env")).unwrap(), "TOP=1\n");
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn work_is_kept() {
        let dir = repo();
        let env = env_path();
        let (wt, _) = block(create(&env, dir.to_str().unwrap(), None, "claude", "work")).unwrap();
        let path = PathBuf::from(&wt.path);
        std::fs::write(path.join("app.txt"), "two\n").unwrap();
        sh(&path, &["commit", "-q", "-am", "work"]);
        std::fs::write(path.join("draft.txt"), "draft\n").unwrap();
        let st = block(state(&env, &wt));
        assert_eq!((st.dirty, st.commits), (1, 1));

        // Changes go to the Trash, the branch stays with its commit.
        let bin = temp_dir("bin");
        assert!(block(remove(&env, &wt, fake_trash(bin.clone()))).unwrap());
        assert!(!path.exists());
        assert!(bin.join(path.file_name().unwrap()).join("draft.txt").is_file());
        assert!(block(branch_exists(&env, &dir, &wt.branch)).unwrap());

        // Reopening its conversation puts the worktree back, on its branch.
        block(restore(&env, &wt)).unwrap();
        assert_eq!(std::fs::read_to_string(path.join("app.txt")).unwrap(), "two\n");
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(bin);
    }

    #[test]
    fn restore_without_branch() {
        let dir = repo();
        let env = env_path();
        let (wt, _) = block(create(&env, dir.to_str().unwrap(), None, "claude", "gone")).unwrap();
        block(remove(&env, &wt, fake_trash(temp_dir("bin")))).unwrap();
        block(restore(&env, &wt)).unwrap();
        let path = PathBuf::from(&wt.path);
        assert_eq!(sh(&path, &["branch", "--show-current"]), wt.branch);
        assert_eq!(sh(&path, &["rev-parse", "HEAD"]), wt.base_commit);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bases_and_errors() {
        let dir = repo();
        let env = env_path();
        sh(&dir, &["branch", "release"]);
        let (wt, _) = block(create(&env, dir.to_str().unwrap(), Some("release"), "claude", "from release")).unwrap();
        assert_eq!(wt.base, "release");
        assert!(block(create(&env, dir.to_str().unwrap(), Some("missing"), "claude", "x")).unwrap_err().contains("missing"));
        assert!(block(create(&env, dir.to_str().unwrap(), Some("--help"), "claude", "x")).is_err());

        let b = block(branches(&env, dir.to_str().unwrap())).unwrap();
        assert!(b.is_repo && b.has_head);
        assert_eq!(b.current.as_deref(), Some("main"));
        assert!(b.list.contains(&"release".to_string()) && b.list.contains(&wt.branch));

        let plain = temp_dir("plain");
        assert!(!block(branches(&env, plain.to_str().unwrap())).unwrap().is_repo);
        assert!(block(create(&env, plain.to_str().unwrap(), None, "claude", "x")).is_err());
        let empty = temp_dir("empty");
        sh(&empty, &["init", "-q"]);
        let b = block(branches(&env, empty.to_str().unwrap())).unwrap();
        assert!(b.is_repo && !b.has_head);
        assert!(block(create(&env, empty.to_str().unwrap(), None, "claude", "x")).is_err());
        for d in [dir, plain, empty] {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}
