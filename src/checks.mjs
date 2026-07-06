import { runnerHostKind, shellQuote } from "./platform.mjs";

export const CHECK_STATUS = {
  PASS: "pass",
  WARN: "warn",
  FAIL: "fail",
  SKIP: "skip"
};

export function parseBattery(raw) {
  const percentMatch = String(raw).match(/(\d+)%/);
  const sourceMatch = String(raw).match(/Now drawing from '([^']+)'/);
  const stateMatch = String(raw).match(/;\s*([^;]+);\s*(?:\d+:\d+|no estimate|not charging|charging|charged)/i);

  if (!percentMatch) return null;

  return {
    percent: Number(percentMatch[1]),
    source: sourceMatch?.[1] ?? "Unknown",
    state: stateMatch?.[1]?.trim() ?? "unknown",
    raw: String(raw).trim()
  };
}

export function parseWifiDevice(raw) {
  const blocks = String(raw).split(/\n\s*\n/);
  for (const block of blocks) {
    if (/Hardware Port:\s*Wi-Fi/i.test(block) || /Hardware Port:\s*AirPort/i.test(block)) {
      const device = block.match(/Device:\s*(\S+)/i)?.[1];
      if (device) return device;
    }
  }
  return null;
}

export function parseWifiSsid(raw) {
  const text = String(raw).trim();
  if (!text || /not associated/i.test(text)) return "";
  const current = text.match(/Current Wi-Fi Network:\s*(.+)$/i);
  if (current) return current[1].trim();
  const airport = text.match(/\sSSID:\s*(.+)$/im);
  if (airport) return airport[1].trim();
  return "";
}

export function parseIpconfigWifiSummary(raw) {
  const text = String(raw);
  const valueFor = (name) => text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  const ssid = valueFor("SSID");
  const networkId = valueFor("NetworkID");
  const linkStatus = valueFor("LinkStatusActive");
  const interfaceType = valueFor("InterfaceType");

  return {
    connected: /^true$/i.test(linkStatus),
    interfaceType,
    ssid: isRedactedValue(ssid) ? "" : ssid,
    networkId: isRedactedValue(networkId) ? "" : networkId,
    redacted: isRedactedValue(ssid) || isRedactedValue(networkId),
    raw: text.trim()
  };
}

export function parsePmsetDisablesleep(raw) {
  const match = String(raw).match(/\bdisablesleep\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

export async function getWifiDevice(runner) {
  const ports = await runner.exec("networksetup -listallhardwareports");
  if (ports.code !== 0 || looksLikeCommandFailure(ports)) {
    return {
      ok: false,
      detail: commandFailed("networksetup -listallhardwareports", ports)
    };
  }

  const device = parseWifiDevice(ports.stdout);
  if (!device) {
    return {
      ok: false,
      detail: "Could not find a Wi-Fi device via networksetup."
    };
  }

  return {
    ok: true,
    device
  };
}

export async function getCurrentWifiSsid(runner, device) {
  const ssidResult = await runner.exec(`networksetup -getairportnetwork ${shellQuote(device)}`);
  if (ssidResult.code === 0 && !looksLikeCommandFailure(ssidResult)) {
    const ssid = parseWifiSsid(ssidResult.stdout);
    if (ssid) {
      return {
        ok: true,
        connected: true,
        redacted: false,
        ssid,
        source: "networksetup"
      };
    }
  } else {
    const failure = commandFailed("networksetup -getairportnetwork", ssidResult);
    const fallback = await getCurrentWifiViaIpconfig(runner, device);
    return fallback.ok ? fallback : { ok: false, detail: failure };
  }

  const fallback = await getCurrentWifiViaIpconfig(runner, device);
  if (fallback.ok) return fallback;

  return {
    ok: true,
    connected: false,
    redacted: false,
    ssid: "",
    source: "networksetup"
  };
}

export async function connectHotspot(config, runner, { ssid, password, dryRun = false } = {}) {
  if (runnerHostKind(runner) === "wsl") {
    const { connectHotspotWsl } = await import("./wsl.mjs");
    return connectHotspotWsl(config, runner, { ssid, password, dryRun });
  }

  const expectedSsid = String(ssid ?? config.hotspot?.ssid ?? "").trim();
  if (!expectedSsid) {
    return {
      ok: false,
      command: "",
      detail: "No hotspot SSID configured. Pass an SSID or use --hotspot \"Phone Name\"."
    };
  }

  const wifi = await getWifiDevice(runner);
  if (!wifi.ok) {
    return {
      ok: false,
      command: "",
      detail: wifi.detail
    };
  }

  const current = await getCurrentWifiSsid(runner, wifi.device);
  if (current.ok && current.ssid === expectedSsid) {
    return {
      ok: true,
      alreadyConnected: true,
      device: wifi.device,
      ssid: expectedSsid,
      command: "",
      detail: `Already connected to ${expectedSsid} on ${wifi.device}.`
    };
  }

  const command = [
    "networksetup",
    "-setairportnetwork",
    shellQuote(wifi.device),
    shellQuote(expectedSsid),
    password ? shellQuote(password) : ""
  ].filter(Boolean).join(" ");

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      device: wifi.device,
      ssid: expectedSsid,
      command,
      detail: `Would connect ${wifi.device} to ${expectedSsid}.`
    };
  }

  const joined = await runner.exec(command, { timeoutMs: 30000 });
  if (joined.code !== 0 || looksLikeCommandFailure(joined)) {
    return {
      ok: false,
      device: wifi.device,
      ssid: expectedSsid,
      command,
      detail: commandFailed("networksetup -setairportnetwork", joined)
    };
  }

  const verified = await waitForWifiSsid(runner, wifi.device, expectedSsid);
  if (!verified.ok) {
    return {
      ok: false,
      device: wifi.device,
      ssid: expectedSsid,
      command,
      detail: verified.detail
    };
  }

  if (verified.ssid !== expectedSsid) {
    if (verified.connected && verified.redacted) {
      return {
        ok: true,
        redacted: true,
        verified: false,
        device: wifi.device,
        ssid: expectedSsid,
        command,
        detail: `Connection command completed and Wi-Fi is active on ${wifi.device}, but macOS redacted the SSID so Rucksack cannot prove it is ${expectedSsid}.`
      };
    }

    const currentText = verified.ssid ? `current SSID is ${verified.ssid}` : "Wi-Fi is not associated";
    return {
      ok: false,
      device: wifi.device,
      ssid: expectedSsid,
      command,
      detail: `Connection command completed, but ${currentText}. Make sure the hotspot is discoverable and saved in Keychain, or rerun with --password.`
    };
  }

  return {
    ok: true,
    alreadyConnected: false,
    device: wifi.device,
    ssid: expectedSsid,
    command,
    detail: `Connected to ${expectedSsid} on ${wifi.device}.`
  };
}

export async function runDoctor(config, runner, { startRemotes = false, startGraceMs = 3000 } = {}) {
  const checks = [];

  if (runner.platform !== "darwin") {
    if (runnerHostKind(runner) === "wsl") {
      const { runDoctorWsl } = await import("./wsl.mjs");
      return runDoctorWsl(config, runner, { startRemotes, startGraceMs });
    }

    checks.push(check("macos", "macOS host", CHECK_STATUS.FAIL, "Rucksack supports macOS laptops and, experimentally, Windows laptops via WSL."));
    return summarize(checks);
  }

  checks.push(check("macos", "macOS host", CHECK_STATUS.PASS, "Running on macOS."));
  checks.push(await checkPowerTools(config, runner));
  checks.push(await checkBattery(config, runner));
  checks.push(await checkHotspot(config, runner));
  checks.push(await checkConnectivity(config, runner));
  checks.push(await checkTailnet(config, runner));

  const exposePorts = config.expose?.ports ?? [];
  if (exposePorts.length > 0) {
    const { checkExposedPorts, checkFirewall } = await import("./expose.mjs");
    checks.push(await checkFirewall(config, runner));
    checks.push(...(await checkExposedPorts(config, runner, exposePorts)));
  }

  checks.push(...(await checkRemotes(config, runner, { startRemotes, startGraceMs })));

  return summarize(checks);
}

export async function checkPowerTools(config, runner) {
  const missing = [];
  if (!(await runner.commandExists("caffeinate"))) missing.push("caffeinate");
  if (!(await runner.commandExists("pmset"))) missing.push("pmset");

  if (missing.length > 0) {
    return check(
      "power-tools",
      "Power tools",
      CHECK_STATUS.FAIL,
      `Missing required macOS command${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`
    );
  }

  if (config.power?.lidClosed) {
    const pmset = await runner.exec("pmset -g custom");
    if (pmset.code !== 0) {
      return check("power-tools", "Power tools", CHECK_STATUS.FAIL, commandFailed("pmset -g custom", pmset));
    }
    if (parsePmsetDisablesleep(pmset.stdout) === null) {
      return check(
        "power-tools",
        "Power tools",
        CHECK_STATUS.FAIL,
        "Could not read the current disablesleep setting, so lid-closed mode cannot be restored safely."
      );
    }
    return check("power-tools", "Power tools", CHECK_STATUS.PASS, "caffeinate and pmset are available; lid-closed restore state is readable.");
  }

  return check("power-tools", "Power tools", CHECK_STATUS.PASS, "caffeinate and pmset are available.");
}

export async function checkBattery(config, runner) {
  const result = await runner.exec("pmset -g batt");
  if (result.code !== 0) {
    return check("battery", "Battery", CHECK_STATUS.WARN, commandFailed("pmset -g batt", result));
  }

  const battery = parseBattery(result.stdout);
  if (!battery) {
    return check("battery", "Battery", CHECK_STATUS.WARN, "Could not parse battery percentage from pmset output.");
  }

  const minimum = Number(config.power?.minimumBatteryPercent ?? 35);
  if (battery.percent < minimum && !/AC Power/i.test(battery.source)) {
    return check(
      "battery",
      "Battery",
      CHECK_STATUS.FAIL,
      `${battery.percent}% available; minimum is ${minimum}% before leaving on battery power.`
    );
  }

  return check(
    "battery",
    "Battery",
    CHECK_STATUS.PASS,
    `${battery.percent}% on ${battery.source}.`
  );
}

export async function checkHotspot(config, runner) {
  const expectedSsid = String(config.hotspot?.ssid ?? "").trim();
  const strict = config.hotspot?.strict !== false;

  if (!expectedSsid) {
    return check(
      "hotspot",
      "Hotspot",
      strict ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN,
      "No hotspot SSID configured. Pass --hotspot \"Phone Name\" or run rucksack init."
    );
  }

  const wifi = await getWifiDevice(runner);
  if (!wifi.ok) {
    return check("hotspot", "Hotspot", strict ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN, wifi.detail);
  }

  const current = await getCurrentWifiSsid(runner, wifi.device);
  if (!current.ok) {
    return check("hotspot", "Hotspot", strict ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN, current.detail);
  }

  if (current.ssid === expectedSsid) {
    return check("hotspot", "Hotspot", CHECK_STATUS.PASS, `Connected to ${expectedSsid} on ${wifi.device}.`);
  }

  if (current.connected && current.redacted) {
    if (config.hotspot?.allowRedactedSsid) {
      return check(
        "hotspot",
        "Hotspot",
        CHECK_STATUS.PASS,
        `Wi-Fi is active on ${wifi.device}, but macOS redacted the SSID; trusting it as ${expectedSsid} because allowRedactedSsid is enabled.`
      );
    }

    return check(
      "hotspot",
      "Hotspot",
      strict ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN,
      `Wi-Fi is active on ${wifi.device}, but macOS redacted the SSID so Rucksack cannot verify ${expectedSsid}. Grant Location Services permission to this terminal/Codex process or pass --allow-redacted-ssid.`
    );
  }

  const status = strict ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN;
  const currentText = current.ssid ? `currently connected to ${current.ssid}` : "not associated with Wi-Fi";
  return check("hotspot", "Hotspot", status, `Expected ${expectedSsid}; ${currentText}.`);
}

export const CONNECTIVITY_PROBE_URL = "http://captive.apple.com/hotspot-detect.html";

export async function checkConnectivity(config, runner) {
  const strict = config.hotspot?.strict !== false;
  const result = await runner.exec(`curl -m 8 -sS ${CONNECTIVITY_PROBE_URL}`, { timeoutMs: 12000 });

  if (result.code !== 0) {
    return check(
      "connectivity",
      "Internet",
      strict ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN,
      `No internet on the current network: ${(result.stderr || result.stdout || "probe failed").trim()}`
    );
  }

  if (/Success/i.test(result.stdout)) {
    return check("connectivity", "Internet", CHECK_STATUS.PASS, "Internet probe succeeded (captive.apple.com).");
  }

  return check(
    "connectivity",
    "Internet",
    CHECK_STATUS.WARN,
    "The network answered the probe with an unexpected response; a captive portal may be intercepting traffic."
  );
}

export const TAILSCALE_CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

export async function checkTailnet(config, runner) {
  const required = Boolean(config.tailnet?.required);

  let binary = null;
  for (const candidate of TAILSCALE_CANDIDATES) {
    if (await runner.commandExists(candidate)) {
      binary = candidate;
      break;
    }
  }

  if (!binary) {
    return check(
      "tailnet",
      "Tailnet",
      required ? CHECK_STATUS.FAIL : CHECK_STATUS.SKIP,
      required
        ? "Tailscale is required (--require-tailnet) but is not installed."
        : "Tailscale is not installed; skipping. It is optional: agent remote surfaces (e.g. codex remote-control) work without it. Only needed for direct ssh/VNC from your phone."
    );
  }

  const result = await runner.exec(`${shellQuote(binary)} status --json`, { timeoutMs: 10000 });
  if (result.code !== 0) {
    return check("tailnet", "Tailnet", required ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN, commandFailed("tailscale status", result));
  }

  let status = null;
  try {
    status = JSON.parse(result.stdout);
  } catch {
    // Fall through to the not-running message with an unknown state.
  }

  const backendState = status?.BackendState ?? "unknown";
  if (backendState === "Running") {
    const name = String(status?.Self?.DNSName ?? "").replace(/\.$/, "") || status?.Self?.HostName || "";
    return check(
      "tailnet",
      "Tailnet",
      CHECK_STATUS.PASS,
      `Tailscale is running${name ? `; this Mac is reachable as ${name}` : ""}.`
    );
  }

  return check(
    "tailnet",
    "Tailnet",
    required ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN,
    `Tailscale is installed but the backend is ${backendState}. Run tailscale up so your phone can reach this Mac over the tailnet.`
  );
}

export async function checkRemotes(config, runner, { startRemotes = false, startGraceMs = 3000 } = {}) {
  const remotes = Array.isArray(config.remotes) ? config.remotes : [];
  const checks = [];

  for (const remote of remotes) {
    const name = remote.name;
    const label = `Remote: ${name}`;
    const required = Boolean(remote.required);
    const command = remote.command || name;
    const installed = await runner.commandExists(command);

    if (!installed) {
      checks.push(
        check(
          `remote:${name}`,
          label,
          required ? CHECK_STATUS.FAIL : CHECK_STATUS.SKIP,
          required ? `${command} is required but is not installed.` : `${command} is not installed.`
        )
      );
      continue;
    }

    if (!remote.statusCommand) {
      checks.push(
        check(
          `remote:${name}`,
          label,
          required ? CHECK_STATUS.FAIL : CHECK_STATUS.PASS,
          required
            ? `${command} is installed, but no statusCommand is configured to verify phone remote control.`
            : `${command} is installed. Add statusCommand if you want Rucksack to verify its remote session.`
        )
      );
      continue;
    }

    let statusResult = await runner.exec(remote.statusCommand, { timeoutMs: 10000 });
    if (statusResult.code !== 0 && startRemotes && remote.startCommand) {
      if (typeof runner.spawnDetachedShell === "function") {
        // Remote-control commands are usually long-running daemons; start them
        // detached and give them a moment to come up instead of exec-ing with a
        // timeout that would kill a foreground daemon.
        runner.spawnDetachedShell(remote.startCommand);
        await delay(startGraceMs);
        statusResult = await runner.exec(remote.statusCommand, { timeoutMs: 10000 });
      } else {
        const startResult = await runner.exec(remote.startCommand, { timeoutMs: 15000 });
        if (startResult.code === 0) {
          statusResult = await runner.exec(remote.statusCommand, { timeoutMs: 10000 });
        }
      }
    }

    checks.push(
      check(
        `remote:${name}`,
        label,
        statusResult.code === 0 ? CHECK_STATUS.PASS : required ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN,
        statusResult.code === 0
          ? `${name} remote status command passed.`
          : commandFailed(remote.statusCommand, statusResult)
      )
    );
  }

  return checks;
}

export function summarize(checks) {
  const summary = checks.reduce(
    (acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0, skip: 0 }
  );

  return {
    ok: checks.every((item) => item.status !== CHECK_STATUS.FAIL),
    checks,
    summary
  };
}

function check(id, label, status, detail) {
  return { id, label, status, detail };
}

function commandFailed(command, result) {
  const message = (result.stderr || result.stdout || "").trim();
  return `${command} failed${message ? `: ${message}` : "."}`;
}

async function waitForWifiSsid(runner, device, expectedSsid, { timeoutMs = 12000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await getCurrentWifiSsid(runner, device);

  while (last.ok && !last.redacted && last.ssid !== expectedSsid && Date.now() < deadline) {
    await delay(intervalMs);
    last = await getCurrentWifiSsid(runner, device);
  }

  return last;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeCommandFailure(result) {
  return /AuthorizationCreate\(\) failed|command not found|operation not permitted/i.test(
    `${result.stderr ?? ""}\n${result.stdout ?? ""}`
  );
}

async function getCurrentWifiViaIpconfig(runner, device) {
  const result = await runner.exec(`ipconfig getsummary ${shellQuote(device)}`);
  if (result.code !== 0 || looksLikeCommandFailure(result)) {
    return {
      ok: false,
      detail: commandFailed("ipconfig getsummary", result)
    };
  }

  const summary = parseIpconfigWifiSummary(result.stdout);
  if (!summary.connected) {
    return {
      ok: true,
      connected: false,
      redacted: false,
      ssid: "",
      source: "ipconfig"
    };
  }

  return {
    ok: true,
    connected: true,
    redacted: summary.redacted,
    ssid: summary.ssid || summary.networkId,
    source: "ipconfig"
  };
}

function isRedactedValue(value) {
  return /^<redacted>$/i.test(String(value).trim());
}
