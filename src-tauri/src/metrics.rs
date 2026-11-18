//! Mesure RAM/CPU du harness et de chaque session (processus CLI + ses enfants,
//! dont les serveurs MCP). Appelé par l'UI uniquement quand la fenêtre est visible.

use crate::events::{MetricsSnapshot, ProcStat};
use std::collections::HashMap;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

pub struct Metrics {
    sys: Mutex<Option<System>>,
}

impl Metrics {
    pub fn new() -> Self {
        Self { sys: Mutex::new(System::new().ok()) }
    }

    pub fn snapshot(&self, sessions: &[(String, u32)]) -> MetricsSnapshot {
        let mut guard = self.sys.lock().unwrap();
        let Some(sys) = guard.as_mut() else { return MetricsSnapshot::default() };
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_memory().with_cpu(),
        );
        let procs = sys.processes();
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, p) in procs {
            if let Some(pp) = p.parent() {
                children.entry(pp).or_default().push(*pid);
            }
        }
        let tree = |root: Pid, skip: &[Pid]| -> ProcStat {
            let mut st = ProcStat::default();
            let mut stack = vec![root];
            while let Some(pid) = stack.pop() {
                if skip.contains(&pid) {
                    continue;
                }
                if let Some(p) = procs.get(&pid) {
                    st.rss_mb += p.memory() as f64 / 1_048_576.0;
                    st.cpu += p.cpu_usage();
                    st.procs += 1;
                }
                if let Some(c) = children.get(&pid) {
                    stack.extend(c.iter().copied());
                }
            }
            st
        };
        let roots: Vec<Pid> = sessions.iter().map(|(_, p)| Pid::from_u32(*p)).collect();
        let harness = tree(Pid::from_u32(std::process::id()), &roots);
        let per: Vec<(String, ProcStat)> = sessions
            .iter()
            .map(|(sid, pid)| (sid.clone(), tree(Pid::from_u32(*pid), &[])))
            .collect();
        let total = harness.rss_mb + per.iter().map(|(_, s)| s.rss_mb).sum::<f64>();
        MetricsSnapshot { harness, sessions: per, total_rss_mb: total }
    }
}
