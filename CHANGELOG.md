# Changelog

All notable changes to Rucksack are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Automatic thermal sleep fail-safe.** macOS lid-closed mode now starts the
  watchdog automatically. If `pmset -g therm` reports CPU throttling, Rucksack
  restores the saved `disablesleep` value so the Mac can sleep and alerts the phone.
- A concise comparison with native agent remotes, `caffeinate`, Amphetamine, and
  Adrafinil near the top of the README.

### Fixed
- macOS lid-closed mode now falls back to `IOPMrootDomain.SleepDisabled` when
  newer macOS releases omit `disablesleep` from `pmset -g`, preserving verified
  baseline capture and restore checks.
- `--connect-hotspot` no longer treats any active Wi-Fi connection as a
  successful join when macOS redacts the SSID. It stops and asks for manual
  verification before `--allow-redacted-ssid` can be used on a subsequent run.
- Failed battery/thermal sleep restoration no longer marks lid-closed mode as
  released. Recovery state is preserved so the watchdog or `rucksack recover`
  can retry.
- Corrected the pinned installer examples so `RUCKSACK_REF` is passed to `bash`,
  not only to the `curl` process on the other side of the pipe.

## [0.2.0] - 2026-07-09

Safety, security, and monitoring pass (from an external code review).

### Fixed
- **Stale lid-closed recovery.** When a previous session's `caffeinate` had died,
  `start` discarded the state without restoring `disablesleep` first — a lid-closed
  session could leave the Mac sleep-disabled and record that leftover state as the
  new baseline. `start` now restores the saved value before reusing stale state and
  **refuses** (with a manual-recovery hint) if the restore fails. Dry-run no longer
  mutates state.

### Added
- **`rucksack recover`** — kill leftover processes and restore the saved
  `disablesleep`; asks before forcing normal sleep when no state is present.
- **Continuous battery monitoring** in the watchdog: `--warn-battery <pct>` pings
  your phone; `--sleep-battery <pct>` is a safety floor that restores normal sleep
  so the Mac sleeps to preserve work instead of dying. Both auto-enable `--watch`.
- **Thermal monitoring** in the watchdog: pings once when macOS throttles the CPU
  under thermal pressure inside the bag.
- **Claude remote-control preset** (`claude remote-control`), now that Claude Code
  ships it, plus Codex/Claude phone-pairing setup guides.
- **`rucksack version`** and versioned installs via `RUCKSACK_REF` (pin a tag).
- **CI**: GitHub Actions runs the test suite on Ubuntu and macOS (Node 20 and 22).

### Security
- `~/.rucksack/` is created `0700`; `config.json`, `session.json`, and `watch.log`
  are written `0600`.
- The notify URL is no longer passed in the watchdog's `argv` (visible to `ps`);
  it travels via the environment (`RUCKSACK_NOTIFY_URL`) or the `0600` config file.

### Changed
- Softened "restores your exact previous setting" to the saved value (one
  `pmset -a` int cannot snapshot per-power-source profiles).
- Rewrote the "heat stays modest" copy: agent reasoning is network-bound, but the
  commands agents run can peg the CPU — test your workload, keep vents clear.

## [0.1.0] - 2026-07-06

Initial release.

### Added
- `doctor`, `pack`/`start`, `unpack`/`stop`, `status`, `hotspot connect`,
  `notify test`, `remote list`.
- Lid-closed "backpack mode" on macOS via `sudo pmset disablesleep`, saved and
  restored on stop.
- Optional `--watch` watchdog (hotspot rejoin + `caffeinate` restart) and phone
  alerts via ntfy.sh.
- `--expose <port>`: phone-reachable dev-server URLs over the hotspot.
- Experimental Windows-under-WSL backend (keep-awake via `SetThreadExecutionState`;
  lid-close action via one UAC-elevated `powercfg` write).

[0.2.0]: https://github.com/mkrecny/rucksack/releases/tag/v0.2.0
[0.1.0]: https://github.com/mkrecny/rucksack/releases/tag/v0.1.0
