# Agent Handoff

## Project State

Rucksack is currently a local npm CLI plus a small static website. The useful product surface is the CLI:

- `rucksack doctor`
- `rucksack hotspot connect [ssid]`
- `rucksack pack` / `rucksack start`
- `rucksack unpack` / `rucksack stop`
- `rucksack status`

The implementation is intentionally macOS-first. It uses `networksetup`, `ipconfig`, `pmset`, and `caffeinate`.

## Important Files

- `src/cli.mjs`: command routing and user-facing CLI output.
- `src/checks.mjs`: macOS readiness checks, hotspot connection, SSID parsing, and redacted-SSID handling.
- `src/wsl.mjs`: experimental Windows-under-WSL backend (interop doctor checks, SetThreadExecutionState keep-awake, UAC-elevated lid-action write).
- `src/session.mjs`: `caffeinate` lifecycle, state file handling, stale PID cleanup, and lid-closed `pmset` restore.
- `src/config.mjs`: default config and CLI option overrides.
- `test/*.test.mjs`: Node test coverage for CLI, config, checks, and sessions.
- `README.md`: user-facing usage docs.
- `site/`: static website, currently secondary to the tool.

## Current Capabilities

- Verifies macOS support and required power tools.
- Checks battery threshold.
- Verifies the expected hotspot SSID when macOS exposes it.
- Can explicitly attempt hotspot connection with `rucksack hotspot connect SSID`.
- Supports `--connect-hotspot` before `pack/start`.
- Supports configurable remote-agent checks through `statusCommand` and `startCommand`.
- Starts keep-awake mode with `caffeinate -dimsu`.
- Supports explicit lid-closed mode with `--lid-closed --yes`, using `sudo pmset -a disablesleep 1` and restoring the previous setting on stop.
- Records session state and cleans stale state when the prior `caffeinate` PID is gone.
- Probes real internet connectivity in `doctor` via `curl` against `captive.apple.com` (works even when the SSID is redacted; detects captive portals).
- Checks Tailscale in `doctor` (`checkTailnet`): pass when the backend is Running (reports the tailnet DNS name), warn when installed-but-stopped, skip when absent; `--require-tailnet` / `tailnet.required` upgrades warn/skip to fail.
- Optional `--watch` watchdog (`src/watch.mjs` + hidden `watch-daemon` CLI command): a detached process that rejoins the hotspot when Wi-Fi drops, restarts `caffeinate` if it dies, logs to `watch.log` next to the state file, and exits when the session state is removed. `stop` kills it via `session.watcherPid`.
- Phone alerts (`src/notify.mjs`): `notify.url` / `--notify-url` points at an ntfy.sh topic or webhook; the watchdog POSTs on link-lost, link-restored, and caffeinate-restart transitions (once per transition, not per tick). `rucksack notify test` verifies the pipe.
- `--start-remotes` starts a failing remote via `spawnDetachedShell` (long-running foreground daemons work) and re-checks status after a grace period.
- Verified codex reality (2026-07-03): `codex remote-control` has `start`/`stop` but NO `status` verb; `start` requires the standalone installer-managed codex. The working preset is `statusCommand: pgrep -f 'codex remote-control'` + `startCommand: codex remote-control` (bare form runs the daemon in the foreground). claude/agy/grok expose no local remote-control daemon; Claude Code remote steering goes through claude.ai/code.
- Verified non-macOS reality (2026-07-06, WSL2/Ubuntu on Windows): the full test suite, `init`/`status`/`remote list`/`stop`/`--dry-run`, `notify test` (real curl POST), the site dev server (reachable from the Windows browser via WSL2 localhost forwarding), and the installer guard all behave correctly. On hosts that are neither macOS nor WSL, `start`/`pack` refuse even with `--force` (guard in `startCommand`; previously crashed with an unhandled `spawn caffeinate ENOENT`).
- Experimental Windows-under-WSL backend (`src/wsl.mjs`, added 2026-07-06): `detectHostKind`/`runnerHostKind` in `src/platform.mjs` classify the host (`darwin`/`wsl`/other); `runDoctor`, `connectHotspot`, `startSession`, and `stopSession` dispatch to WSL implementations via dynamic import. Keep-awake is a hidden Windows powershell holding `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)`, tracked by its WINDOWS pid (`session.windowsPid`; killing the WSL interop stub would orphan it, so stop uses `Stop-Process` and checks the process name first). Lid-closed mode reads the lid-close action with `powercfg /getactivescheme` + `/qh` (explicit GUIDs — the LIDACTION alias does not resolve in `/query` paths), sets AC+DC to 0 with ONE elevated powershell child (`Start-Process -Verb RunAs`, single UAC prompt), verifies, and restores exact values on stop. All PowerShell goes through `-EncodedCommand` base64(UTF-16LE) so nothing fights zsh quoting. `--watch` and password hotspot joins are unsupported on WSL (netsh joins need a saved profile). Live-verified on this machine: doctor fully green; real `pack`→`status`→`unpack` started and killed the Windows keep-awake PID; the UAC-elevated lid write is covered by mocked tests and needs a human to click the prompt.

- `--expose <port>` (`src/expose.mjs`, added 2026-07-06): the phone and laptop share the hotspot LAN, so exposed dev servers are reachable at `http://<hotspot-ip>:<port>`. Doctor gains per-port checks — listening? loopback-only? (`lsof -iTCP -sTCP:LISTEN` on macOS, `ss -ltn` on WSL) — plus a macOS firewall check (`socketfilterfw --getglobalstate`): enabled → warn about the Allow dialog nobody can click with the lid closed; block-all → fail. Pack resolves the URLs (`ipconfig getifaddr <wifi-device>` + `scutil --get LocalHostName` → `<name>.local`), prints them, stores them in session metadata (`status` re-prints), and pushes them through `notify.url`. On WSL it reports NAT vs mirrored (`wslinfo --networking-mode`) reachability honestly. Expose checks are warn-level by design (except firewall block-all): a loopback-bound dev server should not stop you from leaving. Ports come from `expose.ports` config or repeatable/comma-separated `--expose`.

## Hotspot Debugging Findings

The live hotspot used during development was named `perthull`.

Observed macOS behavior:

- The user manually joined `perthull` from the menu bar.
- `networksetup -getairportnetwork en0` still reported `You are not associated with an AirPort network.`
- `ifconfig en0` and `ipconfig getifaddr en0` showed active Wi-Fi with a `172.20.x.x` address.
- `ipconfig getsummary en0` showed active Wi-Fi, DHCP, router, and Android metered hotspot metadata, but SSID fields were `<redacted>`.
- `system_profiler SPAirPortDataType` also redacted the current network name.

Conclusion: on this machine/session, CLI tools can prove Wi-Fi is active but cannot prove the SSID without additional macOS privacy permission. Rucksack now treats this as a distinct redacted-SSID state.

Use this command when the user has manually confirmed the menu bar is on the hotspot:

```sh
node bin/rucksack.mjs doctor --hotspot perthull --allow-redacted-ssid
```

Expected result in that privacy-redacted state: hotspot check passes with an explicit trust message.

Without `--allow-redacted-ssid`, strict mode should fail because Rucksack cannot prove the SSID.

## Verification Commands

Run the test suite:

```sh
npm test
```

Useful live checks:

```sh
node bin/rucksack.mjs doctor --hotspot perthull
node bin/rucksack.mjs doctor --hotspot perthull --allow-redacted-ssid
node bin/rucksack.mjs pack --hotspot perthull --allow-redacted-ssid --dry-run
node bin/rucksack.mjs hotspot connect perthull
```

The dry-run pack path should print:

```text
Dry run. Commands that would be used:
  caffeinate -dimsu
```

## Safety Notes

- Do not run lid-closed mode casually during debugging. Prefer `--dry-run`.
- `--lid-closed --yes` may prompt for sudo because it changes `pmset disablesleep`.
- If touching hotspot code, preserve the difference between:
  - verified SSID match,
  - not associated,
  - active Wi-Fi with SSID redacted,
  - explicit `--allow-redacted-ssid` trust.
- Do not make redacted SSID pass strict mode by default.

## Known Gaps

- Rucksack does not reliably classify arbitrary available networks as phone hotspots. It connects only to a configured/requested SSID.
- Hotspot discovery can be transient; the manual menu bar join failed once with "network could not be found" and succeeded on retry. iPhone hotspots also stop advertising when the phone is idle, so watchdog rejoin is best-effort.
- Phone alerts depend on a user-supplied ntfy.sh topic or webhook URL; there is no built-in push service, and alerts only fire if the hotspot still routes traffic (a fully dead link means the alert may not get out until the link recovers).
- There is no always-on daemon, menubar app, or hotkey yet.
- Remote-control commands for Codex, Claude, agy, and Grok are configurable templates, not deeply integrated provider adapters.
- The website exists but should not distract from CLI behavior.
