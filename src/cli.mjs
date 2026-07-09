import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOptionOverrides, defaultConfigPath, defaultStatePath, loadConfig, sampleConfig, writeConfig } from "./config.mjs";
import { createRunner, runnerHostKind } from "./platform.mjs";
import { readSession, recoverSession, startSession, stopSession, writeSession } from "./session.mjs";
import { connectHotspot, runDoctor } from "./checks.mjs";
import { buildExposeReport } from "./expose.mjs";
import { sendNotification } from "./notify.mjs";
import { runWatchLoop } from "./watch.mjs";

export async function main(argv = process.argv.slice(2), {
  stdout = process.stdout,
  stderr = process.stderr,
  runner = createRunner()
} = {}) {
  const { command, rest } = parseCommand(argv);
  const { options, positionals } = parseOptions(rest);

  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        stdout.write(helpText());
        return 0;
      case "init":
        return await initCommand(options, stdout);
      case "doctor":
        return await doctorCommand(options, stdout, runner);
      case "start":
      case "pack":
        return await startCommand(options, stdout, stderr, runner);
      case "stop":
      case "unpack":
        return await stopCommand(options, stdout, runner);
      case "recover":
        return await recoverCommand(options, stdout, stderr, runner);
      case "status":
        return await statusCommand(options, stdout, runner);
      case "remote":
        return await remoteCommand(positionals, options, stdout);
      case "hotspot":
        return await hotspotCommand(positionals, options, stdout, stderr, runner);
      case "notify":
        return await notifyCommand(positionals, options, stdout, stderr, runner);
      case "watch-daemon":
        return await watchDaemonCommand(options, runner);
      default:
        stderr.write(`Unknown command: ${command}\n\n${helpText()}`);
        return 1;
    }
  } catch (error) {
    stderr.write(`rucksack: ${error.message}\n`);
    return 1;
  }
}

async function initCommand(options, stdout) {
  const configPath = resolveConfigPath(options);
  const config = sampleConfig({ hotspot: options.hotspot });
  await writeConfig(config, configPath, { force: Boolean(options.force) });
  stdout.write(`Created ${configPath}\n`);
  stdout.write("Edit statusCommand/startCommand for the remote CLIs you use, then pass --remote name or mark it required.\n");
  return 0;
}

async function doctorCommand(options, stdout, runner) {
  const config = await getEffectiveConfig(options);
  const result = await runDoctor(config, runner, {
    startRemotes: Boolean(options["start-remotes"])
  });

  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stdout.write(formatDoctor(result));
  }

  return result.ok ? 0 : 1;
}

async function startCommand(options, stdout, stderr, runner) {
  const config = await getEffectiveConfig(options);
  const host = runnerHostKind(runner);

  if (runner.platform !== "darwin" && host !== "wsl" && !options.dryRun) {
    stderr.write(
      "Rucksack start requires macOS or Windows under WSL: this host has neither caffeinate/pmset nor Windows interop, and --force cannot override that. Use --dry-run to preview the commands.\n"
    );
    return 1;
  }

  if (options["connect-hotspot"]) {
    const connected = await connectHotspot(config, runner, {
      password: options.password,
      dryRun: Boolean(options.dryRun)
    });

    if (!connected.ok) {
      stderr.write(`Hotspot connection failed: ${connected.detail}\n`);
      return 1;
    }

    stdout.write(`${connected.detail}\n`);
  }

  const doctor = await runDoctor(config, runner, {
    startRemotes: Boolean(options["start-remotes"])
  });

  if (!doctor.ok && !options.force) {
    stdout.write(formatDoctor(doctor));
    stderr.write("Refusing to start while required checks are failing. Use --force only if you understand the risk.\n");
    return 1;
  }

  const lidClosed = Boolean(config.power.lidClosed);
  if (lidClosed && !options.yes && !options.dryRun) {
    stderr.write(
      host === "wsl"
        ? "Lid-closed mode changes the Windows lid-close action with elevated powercfg (one UAC prompt). Re-run with --lid-closed --yes after checking ventilation and battery.\n"
        : "Lid-closed mode changes macOS sleep settings with sudo pmset. Re-run with --lid-closed --yes after checking ventilation and battery.\n"
    );
    return 2;
  }

  const exposePorts = config.expose?.ports ?? [];
  let exposeReport = null;
  if (exposePorts.length > 0) {
    try {
      exposeReport = await buildExposeReport(config, runner, exposePorts);
    } catch (error) {
      stderr.write(`Could not resolve phone URLs for --expose: ${error.message}\n`);
    }
  }

  const statePath = resolveStatePath(options);
  const started = await startSession({
    runner,
    statePath,
    lidClosed,
    dryRun: Boolean(options.dryRun),
    metadata: {
      doctorSummary: doctor.summary,
      hotspotSsid: config.hotspot.ssid,
      requiredRemotes: config.remotes
        .filter((remote) => remote.required)
        .map((remote) => remote.name),
      ...(exposeReport?.entries?.length ? { expose: exposeReport.entries } : {})
    }
  });

  const batteryMonitor = config.power?.warnBatteryPercent != null || config.power?.floorBatteryPercent != null;
  const watchEnabled = Boolean(options.watch || config.watch?.enabled || batteryMonitor);

  if (options.dryRun) {
    const commands = [...started.commands];
    if (watchEnabled) {
      commands.push(
        host === "wsl"
          ? "(--watch is not supported on Windows/WSL yet; the session would run without it)"
          : `rucksack watch-daemon --state ${statePath} (detached, log: ${watchLogPath(statePath)})`
      );
    }
    stdout.write("Dry run. Commands that would be used:\n");
    stdout.write(commands.map((command) => `  ${command}`).join("\n"));
    stdout.write("\n");
    writeExposeLines(exposeReport, stdout);
    return 0;
  }

  if (started.alreadyRunning) {
    stdout.write(`Rucksack session already running with ${sessionPidLabel(started.session)}.\n`);
    writeExposeLines(exposeReport, stdout);
    return 0;
  }

  if (started.restoredStale) {
    stdout.write(`Restored an interrupted lid-closed session (disablesleep -> ${started.restoredStale.to}) before starting.\n`);
  }
  if (started.cleanedStale) {
    stdout.write("Cleaned up stale Rucksack session state.\n");
  }
  stdout.write(`Rucksack session started with ${sessionPidLabel(started.session)}.\n`);
  stdout.write(`State saved to ${statePath}\n`);
  writeExposeLines(exposeReport, stdout);

  if (exposeReport?.notifyMessage && config.notify?.url) {
    const sent = await sendNotification(config, runner, exposeReport.notifyMessage);
    if (sent.ok) {
      stdout.write(`Phone URLs pushed to ${config.notify.url}.\n`);
    } else if (!sent.skipped) {
      stderr.write(`Could not push phone URLs: ${sent.detail}\n`);
    }
  }

  if (watchEnabled) {
    if (host === "wsl") {
      stderr.write("The --watch watchdog is not supported on Windows/WSL yet; the session is running without it.\n");
    } else {
      const watcherPid = spawnWatchDaemon({ runner, config, options, statePath });
      if (watcherPid) {
        started.session.watcherPid = watcherPid;
        await writeSession(started.session, statePath);
        stdout.write(`Watchdog running with PID ${watcherPid} (log: ${watchLogPath(statePath)}).\n`);
      } else {
        stderr.write("Could not start the watchdog process; the session is running without it.\n");
      }
    }
  }

  if (lidClosed) {
    stdout.write("Lid-closed mode is active. Run rucksack stop before returning to normal use.\n");
  }
  return 0;
}

function watchLogPath(statePath) {
  return path.join(path.dirname(statePath), "watch.log");
}

function sessionPidLabel(session) {
  return session?.windowsPid
    ? `Windows keep-awake PID ${session.windowsPid}`
    : `caffeinate PID ${session?.pid}`;
}

function writeExposeLines(exposeReport, stdout) {
  for (const line of exposeReport?.lines ?? []) {
    stdout.write(`${line}\n`);
  }
}

function spawnWatchDaemon({ runner, config, options, statePath }) {
  const binPath = fileURLToPath(new URL("../bin/rucksack.mjs", import.meta.url));
  const args = [
    binPath,
    "watch-daemon",
    "--state", statePath,
    "--config", resolveConfigPath(options),
    "--interval", String(config.watch?.intervalSeconds ?? 20)
  ];
  if (config.hotspot?.ssid) args.push("--hotspot", config.hotspot.ssid);
  if (config.hotspot?.allowRedactedSsid) args.push("--allow-redacted-ssid");
  if (config.hotspot?.strict === false) args.push("--no-strict-network");
  if (config.power?.warnBatteryPercent != null) args.push("--warn-battery", String(config.power.warnBatteryPercent));
  if (config.power?.floorBatteryPercent != null) args.push("--sleep-battery", String(config.power.floorBatteryPercent));
  if (config.notify?.url) args.push("--notify-url", config.notify.url);

  try {
    const child = runner.spawnDetached(process.execPath, args);
    return child?.pid ?? null;
  } catch {
    return null;
  }
}

async function watchDaemonCommand(options, runner) {
  const config = await getEffectiveConfig(options);
  const statePath = resolveStatePath(options);
  const logPath = watchLogPath(statePath);
  const requestedInterval = Number(options.interval);
  const intervalSeconds = Number.isFinite(requestedInterval) && requestedInterval > 0
    ? requestedInterval
    : config.watch?.intervalSeconds ?? 20;

  const log = (line) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Logging must never take down the watchdog.
    }
  };

  await runWatchLoop({
    runner,
    config,
    statePath,
    log,
    notify: config.notify?.url
      ? (message) => sendNotification(config, runner, message)
      : null,
    intervalMs: Math.max(5, intervalSeconds) * 1000
  });
  return 0;
}

async function stopCommand(options, stdout, runner) {
  const stopped = await stopSession({
    runner,
    statePath: resolveStatePath(options),
    dryRun: Boolean(options.dryRun)
  });

  if (options.dryRun) {
    if (stopped.commands.length === 0) {
      stdout.write("No active Rucksack session found.\n");
      return 0;
    }
    stdout.write("Dry run. Commands that would be used:\n");
    stdout.write(stopped.commands.map((command) => `  ${command}`).join("\n"));
    stdout.write("\n");
    return 0;
  }

  stdout.write(stopped.stopped ? "Rucksack session stopped.\n" : "No active Rucksack session found.\n");
  return 0;
}

async function recoverCommand(options, stdout, stderr, runner) {
  const result = await recoverSession({
    runner,
    statePath: resolveStatePath(options),
    dryRun: Boolean(options.dryRun),
    force: Boolean(options.yes || options.force)
  });

  if (options.dryRun) {
    if (!result.commands?.length) {
      stdout.write(result.detail ? `${result.detail}\n` : "Nothing to recover.\n");
      return 0;
    }
    stdout.write("Dry run. Commands that would be used:\n");
    stdout.write(`${result.commands.map((command) => `  ${command}`).join("\n")}\n`);
    return 0;
  }

  if (result.detail) {
    (result.needsConfirm ? stderr : stdout).write(`${result.detail}\n`);
  }
  return result.needsConfirm ? 1 : 0;
}

async function statusCommand(options, stdout, runner) {
  const session = await readSession(resolveStatePath(options));
  if (!session) {
    stdout.write(options.json ? `${JSON.stringify({ active: false }, null, 2)}\n` : "No active Rucksack session.\n");
    return 0;
  }

  let active = false;
  if (session.windowsPid) {
    const { isWindowsProcessAlive } = await import("./wsl.mjs");
    active = await isWindowsProcessAlive(runner, Number(session.windowsPid));
  } else if (session.pid) {
    active = runner.isProcessAlive(Number(session.pid));
  }
  const payload = { active, session };
  if (options.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    stdout.write(`${active ? "Active" : "Stale"} Rucksack session\n`);
    stdout.write(`  ${sessionPidLabel(session)}\n`);
    if (session.watcherPid) {
      const watcherAlive = runner.isProcessAlive(Number(session.watcherPid));
      stdout.write(`  watchdog PID: ${session.watcherPid} (${watcherAlive ? "running" : "not running"})\n`);
    }
    stdout.write(`  started: ${session.startedAt}\n`);
    stdout.write(`  lid closed: ${session.lidClosed ? "yes" : "no"}\n`);
    if (session.metadata?.hotspotSsid) {
      stdout.write(`  hotspot: ${session.metadata.hotspotSsid}\n`);
    }
    if (session.metadata?.requiredRemotes?.length) {
      stdout.write(`  required remotes: ${session.metadata.requiredRemotes.join(", ")}\n`);
    }
    for (const entry of session.metadata?.expose ?? []) {
      if (entry?.port && entry?.urls?.length) {
        stdout.write(`  phone URL ${entry.port}: ${entry.urls.join(" · ")}\n`);
      }
    }
    if (!active) {
      stdout.write("  run rucksack stop to clean up this state file\n");
    }
  }
  return active ? 0 : 1;
}

async function remoteCommand(positionals, options, stdout) {
  const subcommand = positionals[0] ?? "list";
  if (subcommand !== "list") {
    stdout.write("Usage: rucksack remote list [--config path]\n");
    return 1;
  }

  const config = await getEffectiveConfig(options);
  for (const remote of config.remotes) {
    stdout.write(`${remote.required ? "*" : "-"} ${remote.name} (${remote.command})\n`);
    stdout.write(`  status: ${remote.statusCommand || "(not configured)"}\n`);
    stdout.write(`  start:  ${remote.startCommand || "(not configured)"}\n`);
  }
  return 0;
}

async function hotspotCommand(positionals, options, stdout, stderr, runner) {
  const subcommand = positionals[0] ?? "help";
  if (subcommand !== "connect") {
    stdout.write("Usage: rucksack hotspot connect [ssid] [--password password] [--dry-run]\n");
    return subcommand === "help" ? 0 : 1;
  }

  const config = await getEffectiveConfig(options);
  const connected = await connectHotspot(config, runner, {
    ssid: positionals[1] ?? options.hotspot,
    password: options.password,
    dryRun: Boolean(options.dryRun)
  });

  if (!connected.ok) {
    stderr.write(`Hotspot connection failed: ${connected.detail}\n`);
    return 1;
  }

  stdout.write(`${connected.detail}\n`);
  return 0;
}

async function notifyCommand(positionals, options, stdout, stderr, runner) {
  const subcommand = positionals[0] ?? "help";
  if (subcommand !== "test") {
    stdout.write("Usage: rucksack notify test [--notify-url url]\n");
    return subcommand === "help" ? 0 : 1;
  }

  const config = await getEffectiveConfig(options);
  const sent = await sendNotification(
    config,
    runner,
    "Rucksack test notification. If this reached your phone, transit alerts will too."
  );

  if (!sent.ok) {
    stderr.write(`Notification failed: ${sent.detail}\n`);
    return 1;
  }

  stdout.write(`${sent.detail}\n`);
  return 0;
}

async function getEffectiveConfig(options) {
  const loaded = await loadConfig(resolveConfigPath(options));
  return applyOptionOverrides(loaded.config, options);
}

function resolveConfigPath(options) {
  if (options.local) return path.join(process.cwd(), "rucksack.config.json");
  return options.config ? path.resolve(String(options.config)) : defaultConfigPath();
}

function resolveStatePath(options) {
  return options.state ? path.resolve(String(options.state)) : defaultStatePath();
}

function parseCommand(argv) {
  if (argv.length === 0) return { command: "help", rest: [] };
  return { command: argv[0], rest: argv.slice(1) };
}

export function parseOptions(argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.replace(/^--?/, "").split("=", 2);
    const key = toOptionKey(rawKey);
    const next = argv[index + 1];
    const takesValue = inlineValue !== undefined || (next && !next.startsWith("-") && !isBooleanOption(key));
    const value = inlineValue !== undefined ? inlineValue : takesValue ? argv[++index] : true;

    if (options[key] === undefined) {
      options[key] = value;
    } else if (Array.isArray(options[key])) {
      options[key].push(value);
    } else {
      options[key] = [options[key], value];
    }
  }

  return { options, positionals };
}

function toOptionKey(key) {
  if (key === "n") return "no-strict-network";
  if (key === "y") return "yes";
  if (key === "dry-run") return "dryRun";
  return key;
}

function isBooleanOption(key) {
  return new Set([
    "dryRun",
    "force",
    "help",
    "json",
    "lid",
    "lid-closed",
    "local",
    "allow-redacted-ssid",
    "no-strict-network",
    "connect-hotspot",
    "require-tailnet",
    "start-remotes",
    "watch",
    "yes"
  ]).has(key);
}

function formatDoctor(result) {
  const lines = ["Rucksack doctor\n"];
  for (const item of result.checks) {
    lines.push(`${symbolFor(item.status)} ${item.label}: ${item.detail}`);
  }
  lines.push("");
  lines.push(
    `Summary: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail, ${result.summary.skip} skip`
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function symbolFor(status) {
  return {
    pass: "OK",
    warn: "!!",
    fail: "XX",
    skip: "--"
  }[status] ?? "??";
}

function helpText() {
  return `Rucksack keeps local coding agents reachable while your MacBook is in transit.

Usage:
  rucksack init [--hotspot "Phone Hotspot"] [--local] [--force]
  rucksack doctor [--hotspot "Phone Hotspot"] [--remote codex] [--expose 3000] [--json]
  rucksack start [--hotspot "Phone Hotspot"] [--remote codex] [--expose 3000] [--start-remotes] [--watch] [--lid-closed --yes] [--dry-run]
  rucksack pack [same options as start]
  rucksack stop [--dry-run]
  rucksack unpack [same options as stop]
  rucksack recover [--yes] [--dry-run]
  rucksack status [--json]
  rucksack hotspot connect [ssid] [--password password] [--dry-run]
  rucksack notify test [--notify-url url]
  rucksack remote list

Core options:
  --config path          Read a specific config file instead of ~/.rucksack/config.json
  --state path           Read or write a specific session state file
  --hotspot ssid         Require the current Wi-Fi network to match this SSID
  --connect-hotspot      Try to connect to the configured hotspot before start/pack checks
  --password password    Password for hotspot connect when it is not already in Keychain
  --allow-redacted-ssid  Trust active Wi-Fi when macOS hides the SSID from CLI tools
  --remote name          Mark a remote provider as required for this run
  --expose port          A dev-server port your phone should reach over the hotspot
                         (repeatable, or comma-separated). doctor checks the bind address
                         and the macOS firewall; pack prints the phone URLs and pushes
                         them to --notify-url.
  --watch                Keep a watchdog running after start: rejoins the hotspot if
                         Wi-Fi drops and restarts caffeinate if it dies (log: ~/.rucksack/watch.log)
  --watch-interval sec   Seconds between watchdog checks (default 20)
  --warn-battery pct     Watchdog pings your phone when battery falls to this % (enables --watch)
  --sleep-battery pct    Safety floor: at this % on battery the watchdog restores normal
                         sleep so the Mac sleeps to preserve work instead of dying (enables --watch)
  --notify-url url       ntfy.sh topic or webhook URL for watchdog alerts to your phone
  --require-tailnet      Fail doctor/start unless Tailscale is installed and running
  --minimum-battery pct  Override the configured battery threshold
  --no-strict-network    Warn instead of fail when the current SSID is not the hotspot
  --lid-closed           Enable pmset disablesleep while the session is active
  --yes                  Confirm sudo pmset use for lid-closed mode
  --force                Start even when required checks fail
  --dry-run              Print commands without changing power/session state

Safety:
  For the backpack scenario use --lid-closed: caffeinate alone cannot keep a MacBook awake
  through a lid close on battery power, so normal (caffeinate) mode is for lid-open use only.
  Lid-closed mode uses sudo pmset and should only be used when you have verified ventilation,
  battery, network, and phone remote control for your MacBook.

Windows/WSL (experimental):
  On a Windows laptop, run Rucksack inside WSL where your agents live. Keep-awake is a hidden
  Windows powershell process (SetThreadExecutionState); --lid-closed sets the Windows
  lid-close action to "Do nothing" with one elevated powercfg write (a single UAC prompt)
  and restores your previous setting on stop. --watch is not supported on WSL yet.
`;
}
