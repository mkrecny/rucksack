// Experimental Windows-under-WSL backend.
//
// The CLI runs inside WSL where the agents live, and reaches the Windows host
// through interop binaries (powershell.exe, powercfg.exe, netsh.exe):
// - keep-awake: a hidden Windows powershell process holding
//   SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED), tracked by its
//   WINDOWS pid (killing the WSL interop stub would orphan the Windows process).
// - lid-closed mode: the "lid close action" power setting, saved and restored
//   like pmset disablesleep on macOS. Writing it is the one elevated step: a
//   single UAC prompt runs all powercfg writes in one elevated child.
// PowerShell scripts travel as -EncodedCommand (base64 UTF-16LE) so nothing
// needs to survive zsh -> powershell quoting.

import { shellQuote } from "./platform.mjs";
import { readSession, removeSession, writeSession } from "./session.mjs";
import { checkExposedPorts } from "./expose.mjs";
import {
  CHECK_STATUS,
  checkConnectivity,
  checkRemotes,
  checkTailnet,
  summarize
} from "./checks.mjs";

export const SUB_BUTTONS_GUID = "4f971e89-eebd-4455-a8de-9e59040e7347";
export const LIDACTION_GUID = "5ca83367-6e45-459f-a27b-476b1d01c936";
export const LID_DO_NOTHING = 0;
// ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
export const KEEP_AWAKE_FLAGS = 2147483649;

export const WINDOWS_TOOLS = {
  powershell: ["powershell.exe", "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"],
  powercfg: ["powercfg.exe", "/mnt/c/Windows/System32/powercfg.exe"],
  netsh: ["netsh.exe", "/mnt/c/Windows/System32/netsh.exe"]
};

export const KEEP_AWAKE_COMMAND_PREVIEW =
  "powershell.exe Start-Process powershell -WindowStyle Hidden (keep-awake: SetThreadExecutionState ES_CONTINUOUS|ES_SYSTEM_REQUIRED)";

export function lidSetCommandPreview(ac, dc) {
  return `powercfg.exe /setdcvalueindex + /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION (dc=${dc} ac=${ac}) + /setactive (one elevated UAC prompt)`;
}

export async function resolveWindowsTool(runner, name) {
  for (const candidate of WINDOWS_TOOLS[name] ?? []) {
    if (await runner.commandExists(candidate)) return candidate;
  }
  return null;
}

export async function resolveWindowsTools(runner) {
  return {
    powershell: await resolveWindowsTool(runner, "powershell"),
    powercfg: await resolveWindowsTool(runner, "powercfg"),
    netsh: await resolveWindowsTool(runner, "netsh")
  };
}

export function encodePowerShellScript(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function powershellCommand(powershellPath, script) {
  return `${shellQuote(powershellPath)} -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellScript(script)}`;
}

export function stripWindowsOutput(raw) {
  return String(raw ?? "").replaceAll("\r", "");
}

export function parseActiveSchemeGuid(raw) {
  return stripWindowsOutput(raw).match(/Power Scheme GUID:\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i)?.[1] ?? null;
}

export function parseLidActionIndexes(raw) {
  const text = stripWindowsOutput(raw);
  const pattern = (anchor) => new RegExp(
    `${anchor}[\\s\\S]*?Current AC Power Setting Index:\\s*0x([0-9a-f]+)[\\s\\S]*?Current DC Power Setting Index:\\s*0x([0-9a-f]+)`,
    "i"
  );
  const match = text.match(pattern(LIDACTION_GUID)) ?? text.match(pattern("GUID Alias:\\s*LIDACTION"));
  if (!match) return null;
  return { ac: parseInt(match[1], 16), dc: parseInt(match[2], 16) };
}

// netsh output is localized; this parses the English field names and treats an
// unparseable-but-present interface as "redacted" rather than "absent".
export function parseNetshInterfaces(raw) {
  const text = stripWindowsOutput(raw);
  if (/There is no wireless interface/i.test(text)) {
    return { hasWifi: false, connected: false, ssid: "", name: "", redacted: false };
  }

  const blocks = text.split(/\n\s*\n/).filter((block) => /^\s*Name\s*:/m.test(block));
  if (blocks.length === 0) {
    return { hasWifi: false, connected: false, ssid: "", name: "", redacted: false };
  }

  const connectedBlock = blocks.find((block) => /^\s*State\s*:\s*connected/im.test(block));
  const block = connectedBlock ?? blocks[0];
  const name = block.match(/^\s*Name\s*:\s*(.+)$/im)?.[1]?.trim() ?? "";
  const ssid = block.match(/^\s*SSID\s*:\s*(.+)$/im)?.[1]?.trim() ?? "";
  const connected = Boolean(connectedBlock);

  return {
    hasWifi: true,
    connected,
    ssid: connected ? ssid : "",
    name,
    redacted: connected && !ssid
  };
}

export function parseWin32Battery(raw) {
  const text = stripWindowsOutput(raw).trim();
  if (!text) return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const battery = Array.isArray(parsed) ? parsed[0] : parsed;
  const percent = Number(battery?.EstimatedChargeRemaining);
  if (!Number.isFinite(percent)) return null;

  const status = Number(battery?.BatteryStatus);
  // Win32_Battery.BatteryStatus: 1 discharging, 4 low, 5 critical; the rest are
  // AC-fed or charging states.
  const discharging = status === 1 || status === 4 || status === 5;
  return { percent, status, discharging };
}

const BATTERY_SCRIPT =
  "Get-CimInstance -ClassName Win32_Battery | Select-Object -Property EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json -Compress";

export function keepAwakeScript() {
  return [
    `Add-Type -Name Power -Namespace Rucksack -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'`,
    `[void][Rucksack.Power]::SetThreadExecutionState([uint32]${KEEP_AWAKE_FLAGS})`,
    `while ($true) { Start-Sleep -Seconds 300 }`
  ].join("\n");
}

export function spawnKeepAwakeScript() {
  return [
    `$p = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${encodePowerShellScript(keepAwakeScript())}')`,
    `$p.Id`
  ].join("\n");
}

export async function startKeepAwake(runner, powershellPath) {
  const result = await runner.exec(powershellCommand(powershellPath, spawnKeepAwakeScript()), { timeoutMs: 30000 });
  const pid = Number(stripWindowsOutput(result.stdout).trim());
  if (result.code !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Could not start the Windows keep-awake process${failureDetail(result)}`);
  }
  return pid;
}

function windowsProcessScript(pid, action) {
  return [
    `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue`,
    action === "stop"
      ? `if ($p -and $p.ProcessName -like 'powershell*') { Stop-Process -Id ${Number(pid)} -Force; 'stopped' } else { 'not-running' }`
      : `if ($p -and $p.ProcessName -like 'powershell*') { 'alive' } else { 'dead' }`
  ].join("\n");
}

export async function isWindowsProcessAlive(runner, pid, powershellPath = null) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  const ps = powershellPath ?? (await resolveWindowsTool(runner, "powershell"));
  if (!ps) return false;
  const result = await runner.exec(powershellCommand(ps, windowsProcessScript(pid, "check")), { timeoutMs: 20000 });
  return result.code === 0 && /alive/.test(stripWindowsOutput(result.stdout));
}

export async function stopKeepAwake(runner, powershellPath, pid) {
  return runner.exec(powershellCommand(powershellPath, windowsProcessScript(pid, "stop")), { timeoutMs: 20000 });
}

export async function readLidAction(runner, powercfgPath) {
  const scheme = await runner.exec(`${shellQuote(powercfgPath)} /getactivescheme`, { timeoutMs: 15000 });
  const schemeGuid = scheme.code === 0 ? parseActiveSchemeGuid(scheme.stdout) : null;
  if (!schemeGuid) {
    return { ok: false, detail: `powercfg /getactivescheme failed${failureDetail(scheme)}` };
  }

  const query = await runner.exec(`${shellQuote(powercfgPath)} /qh ${schemeGuid} ${SUB_BUTTONS_GUID}`, { timeoutMs: 15000 });
  const indexes = query.code === 0 ? parseLidActionIndexes(query.stdout) : null;
  if (!indexes) {
    return { ok: false, detail: `Could not read the lid close action from powercfg${failureDetail(query)}` };
  }

  return { ok: true, schemeGuid, ac: indexes.ac, dc: indexes.dc };
}

export function elevatedLidActionScript(schemeGuid, { ac, dc }) {
  const inner = [
    `& powercfg.exe /setdcvalueindex ${schemeGuid} ${SUB_BUTTONS_GUID} ${LIDACTION_GUID} ${Number(dc)}`,
    `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
    `& powercfg.exe /setacvalueindex ${schemeGuid} ${SUB_BUTTONS_GUID} ${LIDACTION_GUID} ${Number(ac)}`,
    `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
    `& powercfg.exe /setactive ${schemeGuid}`,
    `exit $LASTEXITCODE`
  ].join("\n");

  return [
    `try {`,
    `  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encodePowerShellScript(inner)}')`,
    `  exit $p.ExitCode`,
    `} catch {`,
    `  Write-Error $_.Exception.Message`,
    `  exit 1`,
    `}`
  ].join("\n");
}

export async function setLidAction(runner, powershellPath, schemeGuid, values) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(schemeGuid))) {
    return { ok: false, detail: `Refusing to write lid action with an invalid scheme GUID: ${schemeGuid}` };
  }

  // The UAC prompt waits on the Windows desktop; give the human time to answer.
  const result = await runner.exec(
    powershellCommand(powershellPath, elevatedLidActionScript(schemeGuid, values)),
    { timeoutMs: 180000 }
  );
  if (result.code !== 0) {
    return {
      ok: false,
      detail: `Elevated powercfg write failed${failureDetail(result)} If a UAC prompt appeared and was declined, approve it to change the lid-close action.`
    };
  }
  return { ok: true };
}

export async function runDoctorWsl(config, runner, { startRemotes = false, startGraceMs = 3000 } = {}) {
  const checks = [];
  checks.push(check("host", "Windows/WSL host", CHECK_STATUS.PASS, "Running on Windows under WSL (experimental Windows backend)."));

  const tools = await resolveWindowsTools(runner);
  checks.push(await checkWindowsPowerTools(config, runner, tools));
  checks.push(await checkWindowsBattery(config, runner, tools));
  checks.push(await checkWindowsHotspot(config, runner, tools));
  checks.push(await checkConnectivity(config, runner));
  checks.push(await checkTailnet(config, runner));

  const exposePorts = config.expose?.ports ?? [];
  if (exposePorts.length > 0) {
    checks.push(...(await checkExposedPorts(config, runner, exposePorts)));
  }

  checks.push(...(await checkRemotes(config, runner, { startRemotes, startGraceMs })));

  return summarize(checks);
}

export async function checkWindowsPowerTools(config, runner, tools) {
  const missing = Object.entries(tools)
    .filter(([, path]) => !path)
    .map(([name]) => `${name}.exe`);

  if (missing.length > 0) {
    return check(
      "power-tools",
      "Power tools",
      CHECK_STATUS.FAIL,
      `Missing Windows tool${missing.length === 1 ? "" : "s"} via WSL interop: ${missing.join(", ")}. Check that interop is enabled and the Windows drive is mounted.`
    );
  }

  const probe = await runner.exec(powershellCommand(tools.powershell, "'ok'"), { timeoutMs: 30000 });
  if (probe.code !== 0 || !/ok/.test(stripWindowsOutput(probe.stdout))) {
    return check("power-tools", "Power tools", CHECK_STATUS.FAIL, `powershell.exe did not respond through WSL interop${failureDetail(probe)}`);
  }

  if (config.power?.lidClosed) {
    const lid = await readLidAction(runner, tools.powercfg);
    if (!lid.ok) {
      return check(
        "power-tools",
        "Power tools",
        CHECK_STATUS.FAIL,
        `${lid.detail} Lid-closed mode cannot be restored safely without it.`
      );
    }
    return check(
      "power-tools",
      "Power tools",
      CHECK_STATUS.PASS,
      `powershell.exe, powercfg.exe, and netsh.exe are reachable; lid-close restore state is readable (AC ${lid.ac} / DC ${lid.dc}).`
    );
  }

  return check("power-tools", "Power tools", CHECK_STATUS.PASS, "powershell.exe, powercfg.exe, and netsh.exe are reachable through WSL interop.");
}

export async function checkWindowsBattery(config, runner, tools) {
  if (!tools.powershell) {
    return check("battery", "Battery", CHECK_STATUS.WARN, "Cannot read the battery without powershell.exe interop.");
  }

  const result = await runner.exec(powershellCommand(tools.powershell, BATTERY_SCRIPT), { timeoutMs: 30000 });
  if (result.code !== 0) {
    return check("battery", "Battery", CHECK_STATUS.WARN, `Win32_Battery query failed${failureDetail(result)}`);
  }

  if (!stripWindowsOutput(result.stdout).trim()) {
    return check("battery", "Battery", CHECK_STATUS.SKIP, "Windows reports no battery (desktop?); skipping the charge check.");
  }

  const battery = parseWin32Battery(result.stdout);
  if (!battery) {
    return check("battery", "Battery", CHECK_STATUS.WARN, "Could not parse the Win32_Battery response.");
  }

  const minimum = Number(config.power?.minimumBatteryPercent ?? 35);
  if (battery.percent < minimum && battery.discharging) {
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
    `${battery.percent}% ${battery.discharging ? "on battery power" : "on AC power"}.`
  );
}

export async function checkWindowsHotspot(config, runner, tools) {
  const expectedSsid = String(config.hotspot?.ssid ?? "").trim();
  const strict = config.hotspot?.strict !== false;
  const failStatus = strict ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN;

  if (!expectedSsid) {
    return check("hotspot", "Hotspot", failStatus, "No hotspot SSID configured. Pass --hotspot \"Phone Name\" or run rucksack init.");
  }

  if (!tools.netsh) {
    return check("hotspot", "Hotspot", failStatus, "netsh.exe is not reachable through WSL interop, so the Wi-Fi network cannot be verified.");
  }

  const result = await runner.exec(`${shellQuote(tools.netsh)} wlan show interfaces`, { timeoutMs: 15000 });
  if (result.code !== 0) {
    return check("hotspot", "Hotspot", failStatus, `netsh wlan show interfaces failed${failureDetail(result)}`);
  }

  const wifi = parseNetshInterfaces(result.stdout);
  if (!wifi.hasWifi) {
    return check("hotspot", "Hotspot", failStatus, "Windows reports no wireless interface on this machine.");
  }

  if (wifi.connected && wifi.ssid === expectedSsid) {
    return check("hotspot", "Hotspot", CHECK_STATUS.PASS, `Connected to ${expectedSsid} on ${wifi.name}.`);
  }

  if (wifi.connected && wifi.redacted) {
    if (config.hotspot?.allowRedactedSsid) {
      return check(
        "hotspot",
        "Hotspot",
        CHECK_STATUS.PASS,
        `Wi-Fi is active on ${wifi.name}, but Windows hid the SSID; trusting it as ${expectedSsid} because allowRedactedSsid is enabled.`
      );
    }
    return check(
      "hotspot",
      "Hotspot",
      failStatus,
      `Wi-Fi is active on ${wifi.name}, but Windows hid the SSID so Rucksack cannot verify ${expectedSsid}. Grant location access or pass --allow-redacted-ssid.`
    );
  }

  const currentText = wifi.connected ? `currently connected to ${wifi.ssid}` : "not associated with Wi-Fi";
  return check("hotspot", "Hotspot", failStatus, `Expected ${expectedSsid}; ${currentText}.`);
}

export async function connectHotspotWsl(config, runner, { ssid, password, dryRun = false } = {}) {
  const expectedSsid = String(ssid ?? config.hotspot?.ssid ?? "").trim();
  if (!expectedSsid) {
    return {
      ok: false,
      command: "",
      detail: "No hotspot SSID configured. Pass an SSID or use --hotspot \"Phone Name\"."
    };
  }

  const netsh = await resolveWindowsTool(runner, "netsh");
  if (!netsh) {
    return { ok: false, command: "", detail: "netsh.exe is not reachable through WSL interop." };
  }

  if (password) {
    return {
      ok: false,
      command: "",
      detail: "Windows joins Wi-Fi from saved profiles; connect to the hotspot once from the Windows Wi-Fi menu to save it, then retry without --password."
    };
  }

  const current = await currentWindowsWifi(runner, netsh);
  if (current.ok && current.connected && current.ssid === expectedSsid) {
    return {
      ok: true,
      alreadyConnected: true,
      device: current.name,
      ssid: expectedSsid,
      command: "",
      detail: `Already connected to ${expectedSsid} on ${current.name}.`
    };
  }

  const command = `${shellQuote(netsh)} wlan connect ${shellQuote(`name=${expectedSsid}`)}`;
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      device: current.name ?? "",
      ssid: expectedSsid,
      command,
      detail: `Would connect to ${expectedSsid} via netsh wlan connect.`
    };
  }

  const joined = await runner.exec(command, { timeoutMs: 30000 });
  if (joined.code !== 0 || /There is no profile/i.test(stripWindowsOutput(`${joined.stdout}\n${joined.stderr}`))) {
    return {
      ok: false,
      ssid: expectedSsid,
      command,
      detail: `netsh wlan connect failed${failureDetail(joined)} Connect to the hotspot once from the Windows Wi-Fi menu so a profile is saved.`
    };
  }

  const deadline = Date.now() + 20000;
  let last = current;
  while (Date.now() < deadline) {
    last = await currentWindowsWifi(runner, netsh);
    if (last.ok && last.connected && (last.ssid === expectedSsid || last.redacted)) break;
    await delay(1000);
  }

  if (last.ok && last.connected && last.ssid === expectedSsid) {
    return {
      ok: true,
      alreadyConnected: false,
      device: last.name,
      ssid: expectedSsid,
      command,
      detail: `Connected to ${expectedSsid} on ${last.name}.`
    };
  }

  if (last.ok && last.connected && last.redacted) {
    return {
      ok: true,
      redacted: true,
      verified: false,
      device: last.name,
      ssid: expectedSsid,
      command,
      detail: `Connection command completed and Wi-Fi is active on ${last.name}, but Windows hid the SSID so Rucksack cannot prove it is ${expectedSsid}.`
    };
  }

  const currentText = last.ok && last.connected ? `current SSID is ${last.ssid}` : "Wi-Fi is not associated";
  return {
    ok: false,
    ssid: expectedSsid,
    command,
    detail: `Connection command completed, but ${currentText}. Make sure the hotspot is discoverable and its Windows profile is saved.`
  };
}

async function currentWindowsWifi(runner, netsh) {
  const result = await runner.exec(`${shellQuote(netsh)} wlan show interfaces`, { timeoutMs: 15000 });
  if (result.code !== 0) {
    return { ok: false, detail: `netsh wlan show interfaces failed${failureDetail(result)}` };
  }
  return { ok: true, ...parseNetshInterfaces(result.stdout) };
}

export async function startSessionWsl({
  runner,
  statePath,
  lidClosed = false,
  dryRun = false,
  metadata = {}
}) {
  const existing = await readSession(statePath);
  if (existing && (existing.windowsPid || existing.pid)) {
    const alive = existing.windowsPid
      ? await isWindowsProcessAlive(runner, Number(existing.windowsPid))
      : typeof runner.isProcessAlive === "function"
        ? runner.isProcessAlive(Number(existing.pid))
        : true;

    if (alive) {
      return { alreadyRunning: true, session: existing, commands: [], cleanedStale: false };
    }

    await removeSession(statePath);
  }

  const commands = [KEEP_AWAKE_COMMAND_PREVIEW];
  if (lidClosed) {
    commands.push(lidSetCommandPreview(LID_DO_NOTHING, LID_DO_NOTHING));
  }

  if (dryRun) {
    return { alreadyRunning: false, session: null, commands };
  }

  const tools = await resolveWindowsTools(runner);
  if (!tools.powershell || !tools.powercfg) {
    throw new Error("Windows interop is unavailable: powershell.exe and powercfg.exe must be reachable from WSL.");
  }

  let previousLidAction = null;
  if (lidClosed) {
    const lid = await readLidAction(runner, tools.powercfg);
    if (!lid.ok) {
      throw new Error(`${lid.detail} Refusing lid-closed mode without restore state.`);
    }
    previousLidAction = { schemeGuid: lid.schemeGuid, ac: lid.ac, dc: lid.dc };

    const applied = await setLidAction(runner, tools.powershell, lid.schemeGuid, {
      ac: LID_DO_NOTHING,
      dc: LID_DO_NOTHING
    });
    if (!applied.ok) {
      throw new Error(applied.detail);
    }

    const verify = await readLidAction(runner, tools.powercfg);
    if (!verify.ok || verify.ac !== LID_DO_NOTHING || verify.dc !== LID_DO_NOTHING) {
      await setLidAction(runner, tools.powershell, lid.schemeGuid, { ac: lid.ac, dc: lid.dc });
      throw new Error("powercfg did not report the lid-close action as Do nothing after the elevated write.");
    }
  }

  let windowsPid = null;
  try {
    windowsPid = await startKeepAwake(runner, tools.powershell);

    const session = {
      platform: "wsl",
      windowsPid,
      startedAt: new Date().toISOString(),
      lidClosed,
      previousLidAction,
      commands,
      metadata
    };

    await writeSession(session, statePath);
    return {
      alreadyRunning: false,
      session,
      commands,
      cleanedStale: Boolean(existing?.windowsPid || existing?.pid)
    };
  } catch (error) {
    if (windowsPid) {
      try {
        await stopKeepAwake(runner, tools.powershell, windowsPid);
      } catch {
        // Best effort; the keep-awake process may not have started cleanly.
      }
    }

    if (lidClosed && previousLidAction) {
      await setLidAction(runner, tools.powershell, previousLidAction.schemeGuid, previousLidAction);
    }
    throw error;
  }
}

export async function stopSessionWsl({ runner, statePath, dryRun = false }) {
  const session = await readSession(statePath);
  if (!session) {
    return { stopped: false, commands: [] };
  }

  const restore = restoreLidValues(session);
  const commands = [];
  if (session.watcherPid) {
    commands.push(`kill ${session.watcherPid}`);
  }
  if (session.windowsPid) {
    commands.push(`powershell.exe Stop-Process -Id ${session.windowsPid} (keep-awake)`);
  }
  if (session.lidClosed) {
    commands.push(lidSetCommandPreview(restore.ac, restore.dc));
  }

  if (dryRun) {
    return { stopped: false, session, commands };
  }

  if (session.watcherPid) {
    try {
      runner.kill(Number(session.watcherPid));
    } catch {
      // The watcher may have already exited on its own.
    }
  }

  const tools = await resolveWindowsTools(runner);
  if (!tools.powershell || (session.lidClosed && !tools.powercfg)) {
    throw new Error("Windows interop is unavailable: cannot stop the keep-awake process or restore the lid-close action.");
  }

  if (session.windowsPid) {
    await stopKeepAwake(runner, tools.powershell, Number(session.windowsPid));
  }

  if (session.lidClosed) {
    const schemeGuid = restore.schemeGuid ?? (await readLidAction(runner, tools.powercfg)).schemeGuid;
    const restored = await setLidAction(runner, tools.powershell, schemeGuid, restore);
    if (!restored.ok) {
      throw new Error(restored.detail);
    }
  }

  await removeSession(statePath);
  return { stopped: true, session, commands };
}

function restoreLidValues(session) {
  const previous = session.previousLidAction ?? {};
  return {
    schemeGuid: previous.schemeGuid ?? null,
    // 1 (Sleep) is the Windows default lid action; use it when no saved value exists.
    ac: Number.isInteger(previous.ac) ? previous.ac : 1,
    dc: Number.isInteger(previous.dc) ? previous.dc : 1
  };
}

function check(id, label, status, detail) {
  return { id, label, status, detail };
}

function failureDetail(result) {
  const message = (result.stderr || result.stdout || "").trim();
  return message ? `: ${message}` : ".";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
