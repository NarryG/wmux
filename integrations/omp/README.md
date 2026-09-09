# wmux ↔ Oh My Pi bridge

The OMP extension sends deterministic lifecycle signals to wmux while `omp` runs inside a wmux pane.

## What it provides

- `session_start` → `agent.session_start`
- `agent_start` → `agent.activity`
- `agent_end` → `agent.stop` (unless OMP schedules a continuation)
- exact pane routing through `WMUX_PTY_ID`, `WMUX_SURFACE_ID`, and `WMUX_WORKSPACE_ID`
- daemon-first delivery with authenticated main-process fallback
- resume-binding spool when wmux is temporarily unavailable

The bridge is best-effort, fire-and-forget, and never blocks or fails an OMP turn.

## Installation

`wmux setup-hooks` installs or refreshes the extension at:

```text
~/.omp/agent/extensions/wmux.ts
```

The installer preserves a same-name file that does not carry the wmux ownership marker. Restart OMP after installation so it discovers the refreshed extension.

For a source checkout, the bridge can be loaded explicitly while testing:

```powershell
omp --extension C:\path\to\wmux\integrations\omp\wmux.ts
```

## Verification

Run `wmux setup-hooks --status` and check the `ompExtension` row. Then start `omp` inside a wmux pane, submit a prompt, and verify the pane changes to running and returns to waiting when `agent_end` fires.
