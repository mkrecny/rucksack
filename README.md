<p align="center">
  <img src="site/assets/hero.jpg" alt="An anime hacker crosses a rain-slick neon street, glowing rucksack in the foreground, terminal logs streaming on their phone" width="100%">
</p>

<h1 align="center">🎒 RUCKSACK</h1>

<p align="center"><strong>Pack your agents.</strong><br>
Your coding agents keep working — lid closed, in the bag, on your phone's hotspot.</p>

<p align="center">
  <img alt="macOS" src="https://img.shields.io/badge/macOS-only-37f2ff?style=flat-square">
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A5%2020-9dff00?style=flat-square">
  <img alt="Zero deps" src="https://img.shields.io/badge/runtime%20deps-0-ff2d95?style=flat-square">
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-e8f0ff?style=flat-square">
</p>

```sh
curl -fsSL https://rucksack.sh/install | bash
```

> The one-liner goes live with [rucksack.sh](https://rucksack.sh). Until then: `git clone` this repo, `npm install && npm link`, done.

---

You kicked off a long agent run. Codex is mid-refactor, Claude is grinding through a migration — and you have to leave. Close the lid and macOS kills everything. Rucksack is the ritual for walking out the door anyway:

- **Checks everything first** — battery, hotspot, *real* internet (captive-portal probe), your agent remotes. Nine checks, one command.
- **Keeps the Mac awake with the lid closed** — `sudo pmset` with your previous setting saved, verified, and restored on stop. Not a hack; a lifecycle.
- **Watches the link while you move** — a watchdog rejoins the hotspot when Wi-Fi drops and revives the keep-awake process if it dies.
- **Pings your phone when something breaks** — link lost, link restored, process revived. One ntfy.sh URL, zero infrastructure.

## The run

<table>
  <tr>
    <td width="25%"><img src="site/assets/panel1.jpg" alt="Panel 1: the hacker at a desk of glowing terminals glances at the clock, rucksack hanging empty on the chair"><br><sub><b>01 · DEADLINE</b><br>19:42. The agents are mid-refactor. You have to leave.</sub></td>
    <td width="25%"><img src="site/assets/panel2.jpg" alt="Panel 2: hands slide a glowing laptop into a canvas rucksack while a phone shows five green OK checks"><br><sub><b>02 · PACK</b><br><code>rucksack pack --lid-closed --yes --watch</code> — every check green. Zip it.</sub></td>
    <td width="25%"><img src="site/assets/panel3.jpg" alt="Panel 3: striding through a neon subway, glowing rucksack on their back, logs streaming on the phone"><br><sub><b>03 · TRANSIT</b><br>Hotspot drops? The watchdog rejoins and pings your phone.</sub></td>
    <td width="25%"><img src="site/assets/panel4.jpg" alt="Panel 4: at a dawn-lit café the laptop reopens to a completed task list, rucksack slumped beside the stool"><br><sub><b>04 · ARRIVAL</b><br>Arrive. Unpack. The work never stopped.</sub></td>
  </tr>
</table>

## Loadout

```sh
rucksack doctor                          # nine readiness checks, one verdict
rucksack pack --lid-closed --yes --watch # backpack mode: pmset + watchdog
rucksack notify test                     # prove the phone alerts work
rucksack hotspot connect "My iPhone"     # join the hotspot from Keychain
rucksack status                          # what's running, what's watching
rucksack unpack                          # stop, restore sleep settings, clean up
```

`pack`/`unpack` are the travel aliases for `start`/`stop`. Every mutating command takes `--dry-run`.

## Install (today, by hand)

```sh
git clone https://github.com/mkrecny/rucksack.git
cd rucksack
npm install
npm link
rucksack init --hotspot "My iPhone"
rucksack doctor
```

Requires macOS and Node 20+. No runtime dependencies — the CLI is plain Node against `pmset`, `caffeinate`, `networksetup`, and `curl`.

## Field manual

### Doctor

```sh
rucksack doctor --remote codex
```

Checks macOS, power tools, battery threshold, hotspot SSID, real internet reachability (via `captive.apple.com` — works even when macOS redacts the SSID), Tailscale (optional — see below), and each configured agent remote.

On newer macOS versions, SSID access can be privacy-redacted for terminal processes. If `doctor` says Wi-Fi is active but the SSID is redacted, either grant Location Services access to your terminal or opt in with `--allow-redacted-ssid` — the connectivity probe still gives you real assurance the link works.

### Lid-closed mode (backpack mode)

This is the mode the project is named for. On battery power, macOS sleeps a laptop when the lid closes and `caffeinate` cannot prevent it — so for the bag, Rucksack uses `sudo pmset -a disablesleep 1` and saves the previous setting so `rucksack stop` restores it exactly. Plain `caffeinate` mode is for lid-open use.

```sh
rucksack start --hotspot "My iPhone" --remote codex --lid-closed --yes
rucksack stop
```

### The watchdog

`--watch` keeps a watchdog running after you leave. Every 20 seconds (configurable with `--watch-interval` or `watch.intervalSeconds`) it rejoins the hotspot if Wi-Fi dropped, restarts `caffeinate` if it died, and logs to `watch.log` next to the session state file. `rucksack stop` shuts it down with the rest of the session.

### Phone alerts

Point `notify.url` (or `--notify-url`) at an [ntfy.sh](https://ntfy.sh) topic — or any webhook that accepts a POSTed text body — and subscribe to that topic on your phone. The watchdog pings you on link-lost, link-restored, and process-revived transitions.

```sh
rucksack notify test --notify-url https://ntfy.sh/your-private-topic
rucksack pack --hotspot "My iPhone" --lid-closed --yes --watch --notify-url https://ntfy.sh/your-private-topic
```

### Tailnet (optional)

Tailscale is entirely optional. Agent CLIs with their own remote surfaces (such as `codex remote-control`, or Claude Code steered through claude.ai/code) make outbound connections only — your phone never needs to reach the Mac directly. A tailnet only matters if you want direct access from the phone (ssh, Termius, screen sharing). If Tailscale *is* installed, `doctor` verifies the backend is running and reports the Mac's tailnet name; without it the check simply skips. Pass `--require-tailnet` only if the tailnet is part of your own workflow.

### Config

Default path: `~/.rucksack/config.json` (create it with `rucksack init --hotspot "My iPhone"`).

```json
{
  "version": 1,
  "hotspot": {
    "ssid": "My iPhone",
    "strict": true,
    "allowRedactedSsid": false
  },
  "power": {
    "minimumBatteryPercent": 35,
    "lidClosed": false
  },
  "watch": {
    "enabled": false,
    "intervalSeconds": 20
  },
  "notify": {
    "url": ""
  },
  "tailnet": {
    "required": false
  },
  "remotes": [
    {
      "name": "codex",
      "command": "codex",
      "required": false,
      "statusCommand": "pgrep -f 'codex remote-control'",
      "startCommand": "codex remote-control"
    }
  ]
}
```

Remote-control commands stay configurable because each agent CLI exposes different verbs. The codex preset reflects what the CLI actually ships today: `codex remote-control` runs the daemon (there is no `status` verb, so `pgrep` checks the process). Claude, agy, and Grok currently expose no local remote-control daemon for Rucksack to verify — Claude Code sessions are steered remotely through claude.ai/code instead. With `--start-remotes`, Rucksack starts a missing remote detached (so long-running daemons work) and re-checks after a grace period.

## Straight talk

- **A laptop in a bag is a laptop in a bag.** Agent work is mostly network-bound, so heat stays modest — but check ventilation and battery before you zip. Rucksack checks with you; it can't bend thermodynamics.
- **Alerts ride the same link.** If the hotspot is fully dead, the "it's dead" ping queues until something routes. A heartbeat dead-man's switch is on the roadmap.
- **iPhone hotspots are moody.** They stop advertising when idle, so watchdog rejoin is best-effort. Keep the phone awake-ish for best results.

## Website

The landing page lives in `site/` — same art, same energy.

```sh
npm run dev   # http://127.0.0.1:4175
```

The dev server serves `site/install.sh` at `/install`, so once the site is deployed to rucksack.sh the one-liner works as advertised. Set `RUCKSACK_REPO` to install from a fork.

## Current scope

- macOS only.
- The only background process is the optional `--watch` watchdog; no always-on daemon.
- No menubar app or global hotkey yet — the reliability loop earns trust first.

## License

MIT. Art generated with Gemini (Nano Banana Pro).
