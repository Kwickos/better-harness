# Measurements: Better Harness vs Claude Desktop

Machine: MacBook Pro M1 Pro (8 cores), 16 GB of RAM, macOS 27.0.1. Measured on November 7, 2026.

Tools:
- `top -stats pid,command,cpu,mem`. The MEM column is the physical footprint, the same metric as Activity Monitor.
- `ps` (RSS) for snapshots.

The harness was measured with `scripts/fake-claude.py`, because the account's quota was used up. The cost of the real CLI is given separately.

**Read with care:**
- Desktop was running at the same time: it was displaying the session that wrote this code.
- WindowServer, shared by all apps, can't be attributed to one process.

## Size

| | Claude Desktop 4.23118.0 | Better Harness 0.1.0 |
|---|---:|---:|
| Application | 649 MB | **3.5 MB** |
| The app's own copies of the CLI | 575 MB (2.1.309 + 2.1.317) | 0 (the CLI already installed is reused) |
| Interface JS | ~13 MB for the main process, plus the claude.ai web app | **98 KB** |

## At rest (no generation running)

| | CPU | Memory |
|---|---:|---:|
| Claude Desktop (main + renderer + GPU + helpers), 4 Code sessions open | 8–55% depending on activity | 1.3 GB (RSS) |
| … plus the 4 CLI processes of those sessions | ~0% | 810 MB, plus ~160 MB of MCP servers |
| **Better Harness** (core + WebContent + GPU + Networking), 2 sessions open and suspended | **0.0%** | **≈ 97–122 MB** |
| … CLI processes | 0 (suspended: no process) | **0** |

The harness first used ~1.5% CPU at rest: the memory meter queried the process table every 4 s. That measurement now runs only every 10 s, and only while the window has focus.

## While streaming (window visible, ≈80 deltas/s for 20 s)

| | Average CPU | Memory |
|---|---:|---:|
| Desktop: renderer + GPU (measured at the same time, displaying its own session) | ≈ 40% (19% + 21%) | ≈ 1.1 GB |
| Desktop: initial measurement during a generation (see [ANALYSIS.md](ANALYSIS.md)) | ≈ 62% (45% + 17%), plus 8.5% for the main process | 1.6 GB |
| **Better Harness v1** (one text node per delta, flush every 40 ms) | 21% | WebContent up to 180 MB |
| **Better Harness now** (frozen paragraphs, flush every 50 ms) | **17.6%** (core 3.8 + WebContent 7.6 + GPU 6.2) | WebContent peak 182 MB, **back to 61 MB** after the message |

When the window is hidden or minimized, or another session is displayed, the harness sends **no** deltas: only the final message is rendered. The rendering cost then drops to zero.

## CLI processes

| | Desktop | Better Harness |
|---|---|---|
| Processes per open session | 1, kept as long as the session stays open (137–349 MB) | 0 before the first message; suspended after 10 min of inactivity; 3 alive at most |
| MCP servers | the whole configuration restarted in each session (~40 MB per session here) | chosen per session; real CLI without MCP: **176 MB**, 0 child processes |
| Shutdown | `disclaimer --pgroup` | stdin closed, then SIGTERM and SIGKILL of the **group** (CLI + MCP); checked on suspension and on app quit |

## Not measured

- **WindowServer's share.** Probably lower for the harness (no animation, 20 refreshes/s at most), but not measured.
- **Real model streaming.** Quota used up; the fake CLI reproduces the rate and format of the events.
