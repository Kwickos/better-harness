//! Événements envoyés à l'UI. Ce sont des projections compactes des messages
//! stream-json du CLI : l'UI ne reçoit jamais le JSON brut (parfois énorme).

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Block {
    Text { text: String },
    Thinking { text: String },
    Tool { id: String, name: String, summary: String, input: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub name: String,
    pub status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub sid: String,
    pub cli_id: Option<String>,
    pub cwd: String,
    pub title: String,
    pub model: Option<String>,
    pub permission_mode: String,
    /// idle | starting | ready | busy | suspended
    pub state: String,
    pub pid: Option<u32>,
    pub mcp_label: String,
    pub effort: Option<String>,
    pub advisor: Option<String>,
    pub last_active_ms: u64,
    pub pending_permissions: usize,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcStat {
    pub rss_mb: f64,
    pub cpu: f32,
    pub procs: usize,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub harness: ProcStat,
    pub sessions: Vec<(String, ProcStat)>,
    pub total_rss_mb: f64,
}

/// Un artefact publié : son adresse sur claude.ai et, s'il vient d'un fichier, le fichier local.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    pub url: String,
    pub title: Option<String>,
    pub path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UiEvent {
    SessionUpdate {
        session: SessionInfo,
    },
    SessionRemoved {
        sid: String,
    },
    Init {
        sid: String,
        model: String,
        tools: usize,
        mcp: Vec<McpStatus>,
    },
    /// Texte en cours de génération (coalescé côté Rust). `replace` = remplacer
    /// tout le tampon affiché (après un changement de focus).
    Delta {
        sid: String,
        text: String,
        thinking: bool,
        replace: bool,
    },
    Assistant {
        sid: String,
        id: String,
        parent: Option<String>,
        blocks: Vec<Block>,
    },
    ToolResult {
        sid: String,
        tool_use_id: String,
        parent: Option<String>,
        is_error: bool,
        text: String,
        truncated: bool,
        /// Présent quand le résultat structuré désigne un artefact (outil `Artifact`).
        artifact: Option<ArtifactRef>,
    },
    User {
        sid: String,
        text: String,
    },
    Permission {
        sid: String,
        request_id: String,
        tool_name: String,
        title: Option<String>,
        description: Option<String>,
        input: String,
        can_always: bool,
    },
    PermissionDone {
        sid: String,
        request_id: String,
    },
    Status {
        sid: String,
        status: Option<String>,
    },
    RateLimit {
        sid: String,
        status: String,
        resets_at: Option<i64>,
        window: Option<String>,
        /// Fenêtres de limite du compte (`unifiedWindows`) : part utilisée, de 0 à 1, et réinitialisation.
        windows: Option<serde_json::Value>,
    },
    Result {
        sid: String,
        is_error: bool,
        subtype: String,
        text: Option<String>,
        duration_ms: u64,
        cost_usd: f64,
        turns: u64,
        input_tokens: u64,
        output_tokens: u64,
    },
    Notice {
        sid: Option<String>,
        level: String,
        text: String,
    },
    /// Modèles disponibles (réponse à `initialize`), avec leurs niveaux d'effort.
    Capabilities {
        sid: String,
        models: serde_json::Value,
        plan: Option<String>,
    },
    Server {
        server: crate::servers::ServerInfo,
    },
    ServerLog {
        key: String,
        lines: Vec<String>,
    },
    Browser {
        url: String,
        loading: bool,
    },
    /// La page d'un artefact a fini de charger : sa vue peut venir à l'écran.
    ArtifactReady {},
    /// Le pont du simulateur : `ready`, `no-input` (écran sans touches), `error`, `ended`,
    /// et `agent` quand Claude commence à agir sur cet appareil.
    Simulator {
        udid: String,
        state: String,
        message: Option<String>,
    },
}
