# FABLE.md — Assessment of Rucksack

*Written 2026-07-03. Scope: the core idea and the technical approach, judged on functionality. Security nitpicks and code style deliberately out of scope.*

## The core idea

Rucksack targets a real, recurring moment: a coding agent is mid-task on your laptop, you have to leave, and you want the session to survive the trip — steerable from your phone while the MacBook rides in your backpack on a hotspot.

**The idea is sound, and the niche is genuinely unowned.** Nothing else productizes this moment. The obvious alternatives each miss it: cloud sessions (Codex web, Claude Code on the web) require abandoning local state — running processes, local checkouts, credentials, half-finished worktrees; an always-on desktop plus Tailscale solves a different problem (you're not carrying that machine); and doing it by hand means a fragile mental checklist executed at the worst possible time, while you're rushing out the door.

The checklist shape is also the right shape. This is a one-shot, unattended operation with a high cost of failure in both directions: skip a check and you arrive to a dead session; forget to restore `disablesleep` and your Mac never sleeps again until you notice. Pre-flight verification plus guaranteed restore is exactly how you treat that class of problem, and it is not replicable with a `caffeinate` alias — the alias does the keep-awake but none of the verification and none of the restore discipline.

Two positioning notes worth making explicit in the docs eventually:

- Rucksack's moat is *local state that can't move*. Users whose work lives comfortably in cloud sessions aren't the audience, and that's fine — the audience is everyone whose agent context is entangled with the machine itself.
- The physical constraint is real: a MacBook running lid-closed in a sealed bag has thermal and hotspot-reliability limits no software can fix (iPhone hotspots stop advertising when idle, bags insulate). The tool's job is to maximize the odds and make failures visible, not to promise certainty. The current docs are appropriately honest about this; keep that tone.

## The technical approach

### What's right

The foundation shows real engineering care:

- **Dependency-injected runner** (`src/platform.mjs`) makes every macOS interaction testable without a Mac in the loop; the suite (26 tests before this session, 35 after) exercises real logic, not mocks-testing-mocks.
- **The pmset lifecycle is handled properly**: read the previous `disablesleep` value, refuse to proceed if it can't be read, verify after setting, roll back on failure, restore on stop. This is the part where a bug quietly ruins someone's battery life, and it's the most defensively written code in the repo — correctly so.
- **Stale-session handling** via PID liveness, dry-run support on every mutating command, and a `--yes` gate on the one genuinely dangerous mode.
- **Honest state modeling for the redacted-SSID problem.** Modern macOS hides SSIDs from CLI tools without Location Services permission. Rucksack distinguishes verified-match / not-associated / active-but-redacted / explicitly-trusted rather than collapsing them, and refuses to let redacted pass strict mode by default. The debugging that produced this (see AGENTS.md) was well spent — it turned an OS quirk into a modeled state instead of a lie.
- **Scope discipline.** macOS-first, CLI-first, no daemon/menubar/hotkey until the core earns it. CONCEPT.md gestures at all three; the implementation correctly resisted building them first.

### The gaps (as found; two now addressed)

**1. The value was concentrated before departure, but the risk lives after it.**
Every check ran while you were still standing in your kitchen; the product's promise pays off twenty minutes later on the bus. Before this session, Rucksack had no presence at all during that window — if the hotspot dropped, the Mac hopped networks, or caffeinate died, nothing noticed and nothing recovered. This was the single biggest functional gap, and it's what the new watchdog (below) starts to close.

**2. Checks verified proxies where outcomes are checkable.**
The outcome that matters: *the phone can steer the agent while the Mac is in the bag.* SSID-string match is a proxy (a hotspot with no data plan passes); a status command exiting 0 is a proxy; and the SSID proxy specifically degrades to `--allow-redacted-ssid` ("trust me") on exactly the privacy-configured machines where it's most needed. Fighting the OS for the network's *name* is a losing game; asking "does traffic route right now?" needs no name at all. The new connectivity probe (below) is the first outcome-based check; tailnet reachability (recommended below) would be the second and stronger one.

**3. Normal mode can't actually do the backpack.**
`caffeinate` cannot hold a MacBook awake through a lid close on battery power — its sleep assertion only holds on AC. In the literal scenario the product is named for (lid closed, in a bag, on battery), normal mode delivers nothing; **lid-closed pmset mode is not the risky extra, it is the product.** The README currently presents caffeinate mode as the default flow and lid-closed as the careful exception. The framing should flip: backpack = `--lid-closed`, and the checklist plus restore discipline exist precisely to make that safe.

**4. Remote-agent integration was honest but thin — and the one preset was fictional.**
The configurable `statusCommand`/`startCommand` template is truthful about the ecosystem (the agent CLIs expose no uniform remote-control verbs), but it transferred the research burden to the user, and the shipped codex sample referenced a `codex remote-control status` verb that does not exist. Verified against the actual CLIs on this machine: codex has `remote-control` with `start`/`stop` only (and `start` requires the standalone-installer codex); claude, agy, and grok expose no local remote-control daemon at all — Claude Code's remote steering happens through claude.ai/code, not a verb rucksack can invoke. Additionally, `--start-remotes` ran `startCommand` through `exec` with a 15-second timeout, which would kill exactly the long-running foreground daemon (`codex remote-control`) it was meant to start. Both fixed this session: the preset now uses commands that verifiably work (`pgrep -f 'codex remote-control'` for status, bare `codex remote-control` to start), and `--start-remotes` spawns detached with a grace period before re-checking.

## Changes made this session

All of the ranked recommendations except the deliberately-deferred last one are now implemented:

1. **Internet connectivity probe in `doctor`** (`checkConnectivity`, `src/checks.mjs`). Curls `captive.apple.com/hotspot-detect.html`: pass on the expected body, warn on a captive-portal-shaped response, fail (strict) when nothing routes. Zero configuration, and it gives real assurance in the redacted-SSID case, which previously had none.

2. **A transit watchdog** (`src/watch.mjs`; `--watch` on `start`/`pack`; hidden `watch-daemon` command). A detached process that, every 20s (configurable): rejoins the configured hotspot if the Wi-Fi link drops, restarts `caffeinate` if it died, logs to `watch.log` beside the state file, and exits when the session state is removed. `stop` kills it — watcher first, so it can't resurrect caffeinate mid-teardown.

3. **Phone alerts** (`src/notify.mjs`; `notify.url` / `--notify-url`; `rucksack notify test`). The watchdog POSTs to an ntfy.sh topic or any webhook on link-lost, link-restored, and caffeinate-restart transitions — once per transition, not per failing tick. Verified end-to-end against a local HTTP listener (correct method, title header, body).

4. **Tailnet reachability check** (`checkTailnet`). If Tailscale is installed (PATH or app bundle), `doctor` parses `tailscale status --json`: pass when the backend is Running (reporting the machine's tailnet DNS name — i.e., the address the phone actually uses), warn when stopped, skip when absent; `--require-tailnet` makes it a hard gate. Verified live: correctly warns "backend is Stopped" on this machine.

5. **Remote presets grounded in verified reality, and a working `--start-remotes`.** The codex preset now uses commands that exist (`pgrep -f 'codex remote-control'` / bare `codex remote-control` — see gap 4); `--start-remotes` spawns long-running daemons detached instead of exec-ing them into a 15-second timeout; the README states plainly that claude/agy/grok have no local remote daemon today.

6. **Docs flipped to lid-closed-as-primary.** README and `--help` now present `pack --lid-closed --yes --watch` as the backpack flow and caffeinate mode as lid-open keep-awake, with the "caffeinate can't survive lid-close on battery" fact stated explicitly.

Suite: 46 tests, all passing. Live-verified on this machine: doctor (connectivity pass, tailnet warn), notify round-trip, watchdog spawn with notify-url forwarding, clean teardown.

## Where the leverage is next (ranked)

1. **A dead-man's switch to complement push alerts.** Push-on-failure has an inherent blind spot: if the link is fully dead, the alert can't get out. The inversion fixes it — the watchdog pings a heartbeat URL (healthchecks.io or ntfy-based) every few minutes, and *silence* triggers the phone alert. Small addition to the existing watch loop; closes the last notification gap.

2. **Track the agent-CLI remote surfaces as they mature.** codex's `remote-control` is explicitly experimental, and Claude/agy/grok remote surfaces will likely appear or change; the presets should follow reality as it moves (this session's verification method — inspect the installed CLIs, test the verbs — is the repeatable process).

3. **The CONCEPT.md conveniences** — lid-close auto-trigger, menubar app, hotkey. Right long-term UX (packing should be one gesture), but they multiply whatever the core does, so they belong after the reliability loop has earned trust in real trips. A tool in this category gets one chance: if it silently lets a session die in transit once, it doesn't get a second trip.

## Bottom line

A sound idea in an unowned niche, executed as a disciplined, well-tested v0.1 with unusually careful handling of the dangerous parts. Its main structural weakness was that all its diligence ran before departure while all the risk lived after. That gap is now substantially closed: the session added outcome-based checks (does traffic route; is the tailnet up), a transit watchdog that repairs the link and the keep-awake process, phone alerts on state transitions, presets verified against the CLIs as they actually ship, and docs that own lid-closed mode as the main event. What remains is polish and vigilance: a heartbeat to cover the dead-link blind spot, presets that track the fast-moving agent CLIs, and — only once the loop has proven itself on real trips — the one-gesture packing UX. Rucksack now does something nothing else does: it keeps a promise about what's happening in your backpack, and tells your phone when it can't.
