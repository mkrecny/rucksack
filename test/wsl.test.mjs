import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectHostKind } from "../src/platform.mjs";
import { normalizeConfig } from "../src/config.mjs";
import { connectHotspot, runDoctor } from "../src/checks.mjs";
import { readSession, startSession, stopSession, writeSession } from "../src/session.mjs";
import { main } from "../src/cli.mjs";
import {
  encodePowerShellScript,
  parseActiveSchemeGuid,
  parseLidActionIndexes,
  parseNetshInterfaces,
  parseWin32Battery,
  runDoctorWsl,
  startSessionWsl,
  stopSessionWsl
} from "../src/wsl.mjs";

const SCHEME_GUID = "381b4222-f694-41f0-9685-ff5bb260df2e";

test("detectHostKind spots WSL by kernel release or environment", () => {
  assert.equal(detectHostKind({ platform: "darwin", release: "23.0.0", env: {} }), "darwin");
  assert.equal(detectHostKind({ platform: "linux", release: "6.18.33.2-microsoft-standard-WSL2", env: {} }), "wsl");
  assert.equal(detectHostKind({ platform: "linux", release: "6.8.0-generic", env: { WSL_DISTRO_NAME: "Ubuntu" } }), "wsl");
  assert.equal(detectHostKind({ platform: "linux", release: "6.8.0-generic", env: {} }), "linux");
});

test("encodePowerShellScript produces the UTF-16LE base64 PowerShell expects", () => {
  const encoded = encodePowerShellScript("'ok'");
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), "'ok'");
});

test("parseActiveSchemeGuid reads powercfg /getactivescheme output", () => {
  const raw = `Power Scheme GUID: ${SCHEME_GUID}  (Balanced)\r\n`;
  assert.equal(parseActiveSchemeGuid(raw), SCHEME_GUID);
  assert.equal(parseActiveSchemeGuid("no guid here"), null);
});

test("parseLidActionIndexes reads the LIDACTION block", () => {
  const indexes = parseLidActionIndexes(qhOutput({ lidAc: 1, lidDc: 2 }));
  assert.deepEqual(indexes, { ac: 1, dc: 2 });
  assert.equal(parseLidActionIndexes("Power Scheme GUID: whatever"), null);
});

test("parseNetshInterfaces handles connected, hidden, and missing Wi-Fi", () => {
  const connected = parseNetshInterfaces(netshOutput("dev-hotspot"));
  assert.equal(connected.connected, true);
  assert.equal(connected.ssid, "dev-hotspot");
  assert.equal(connected.name, "Wi-Fi");
  assert.equal(connected.redacted, false);

  const hidden = parseNetshInterfaces(netshOutput(""));
  assert.equal(hidden.connected, true);
  assert.equal(hidden.redacted, true);

  const disconnected = parseNetshInterfaces(
    "\r\n    Name                   : Wi-Fi\r\n    State                  : disconnected\r\n\r\n"
  );
  assert.equal(disconnected.hasWifi, true);
  assert.equal(disconnected.connected, false);

  const none = parseNetshInterfaces("There is no wireless interface on the system.\r\n");
  assert.equal(none.hasWifi, false);
});

test("parseWin32Battery maps charge and discharging states", () => {
  assert.deepEqual(parseWin32Battery('{"EstimatedChargeRemaining":100,"BatteryStatus":2}'), {
    percent: 100,
    status: 2,
    discharging: false
  });
  assert.equal(parseWin32Battery('[{"EstimatedChargeRemaining":47,"BatteryStatus":1}]').discharging, true);
  assert.equal(parseWin32Battery(""), null);
  assert.equal(parseWin32Battery("not json"), null);
});

test("runDoctorWsl passes end to end against Windows interop", async () => {
  const { runner } = wslRunner();
  const result = await runDoctorWsl(config({ ssid: "dev-hotspot" }), runner);

  assert.equal(result.ok, true);
  assert.equal(result.summary.fail, 0);
  const byId = Object.fromEntries(result.checks.map((item) => [item.id, item]));
  assert.equal(byId.host.status, "pass");
  assert.equal(byId["power-tools"].status, "pass");
  assert.equal(byId.battery.status, "pass");
  assert.match(byId.battery.detail, /100% on AC power/);
  assert.equal(byId.hotspot.status, "pass");
  assert.equal(byId.connectivity.status, "pass");
  assert.equal(byId.tailnet.status, "skip");
});

test("runDoctor routes WSL hosts to the Windows backend", async () => {
  const { runner } = wslRunner();
  const result = await runDoctor(config({ ssid: "dev-hotspot" }), runner);
  assert.equal(result.checks[0].id, "host");
  assert.match(result.checks[0].detail, /Windows under WSL/);
});

test("runDoctorWsl fails on hotspot mismatch and low battery", async () => {
  const { runner } = wslRunner({ ssid: "Home", battery: { EstimatedChargeRemaining: 20, BatteryStatus: 1 } });
  const result = await runDoctorWsl(config({ ssid: "dev-hotspot" }), runner);

  assert.equal(result.ok, false);
  const byId = Object.fromEntries(result.checks.map((item) => [item.id, item]));
  assert.equal(byId.hotspot.status, "fail");
  assert.match(byId.hotspot.detail, /Expected dev-hotspot; currently connected to Home/);
  assert.equal(byId.battery.status, "fail");
  assert.match(byId.battery.detail, /20% available; minimum is 35%/);
});

test("runDoctorWsl requires readable lid state for lid-closed mode", async () => {
  const { runner } = wslRunner();
  const result = await runDoctorWsl(config({ ssid: "dev-hotspot", lidClosed: true }), runner);
  const powerTools = result.checks.find((item) => item.id === "power-tools");
  assert.equal(powerTools.status, "pass");
  assert.match(powerTools.detail, /lid-close restore state is readable \(AC 1 \/ DC 1\)/);
});

test("connectHotspot on WSL previews a netsh join", async () => {
  const { runner } = wslRunner({ ssid: "Home" });
  const result = await connectHotspot(config({ ssid: "dev-hotspot" }), runner, { dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.match(result.command, /netsh\.exe' wlan connect 'name=dev-hotspot'/);
});

test("startSessionWsl dry run previews keep-awake and the single UAC write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-wsl-"));
  const { runner } = wslRunner();

  try {
    const started = await startSessionWsl({
      runner,
      statePath: path.join(dir, "session.json"),
      lidClosed: true,
      dryRun: true
    });

    assert.equal(started.session, null);
    assert.equal(started.commands.length, 2);
    assert.match(started.commands[0], /SetThreadExecutionState ES_CONTINUOUS\|ES_SYSTEM_REQUIRED/);
    assert.match(started.commands[1], /LIDACTION.*one elevated UAC prompt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startSessionWsl saves the lid action, applies Do nothing, and stopSessionWsl restores it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-wsl-"));
  const statePath = path.join(dir, "session.json");
  const { runner, state } = wslRunner();

  try {
    const started = await startSession({ runner, statePath, lidClosed: true });

    assert.equal(started.alreadyRunning, false);
    assert.equal(started.session.platform, "wsl");
    assert.equal(started.session.windowsPid, 31337);
    assert.deepEqual(started.session.previousLidAction, { schemeGuid: SCHEME_GUID, ac: 1, dc: 1 });
    assert.equal(state.lidAc, 0);
    assert.equal(state.lidDc, 0);
    assert.equal(state.elevatedWrites.length, 1);
    assert.equal(state.keepAwakeRunning, true);

    const persisted = await readSession(statePath);
    assert.equal(persisted.windowsPid, 31337);

    const stopped = await stopSession({ runner, statePath });
    assert.equal(stopped.stopped, true);
    assert.equal(state.keepAwakeRunning, false);
    assert.equal(state.lidAc, 1);
    assert.equal(state.lidDc, 1);
    assert.equal(state.elevatedWrites.length, 2);
    assert.equal(await readSession(statePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startSessionWsl surfaces a declined UAC prompt and starts nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-wsl-"));
  const statePath = path.join(dir, "session.json");
  const { runner, state } = wslRunner({ elevatedFails: true });

  try {
    await assert.rejects(
      startSessionWsl({ runner, statePath, lidClosed: true }),
      /Elevated powercfg write failed.*UAC/s
    );
    assert.equal(state.keepAwakeStarts, 0);
    assert.equal(await readSession(statePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startSessionWsl restores the lid action when keep-awake fails to start", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-wsl-"));
  const statePath = path.join(dir, "session.json");
  const { runner, state } = wslRunner({ keepAwakeFails: true });

  try {
    await assert.rejects(
      startSessionWsl({ runner, statePath, lidClosed: true }),
      /Could not start the Windows keep-awake process/
    );
    assert.equal(state.lidAc, 1);
    assert.equal(state.lidDc, 1);
    assert.equal(state.elevatedWrites.length, 2);
    assert.equal(await readSession(statePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopSessionWsl dry run lists keep-awake stop and the elevated restore", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-wsl-"));
  const statePath = path.join(dir, "session.json");
  const { runner } = wslRunner();

  try {
    await writeSession(
      {
        platform: "wsl",
        windowsPid: 31337,
        lidClosed: true,
        previousLidAction: { schemeGuid: SCHEME_GUID, ac: 1, dc: 2 }
      },
      statePath
    );

    const stopped = await stopSessionWsl({ runner, statePath, dryRun: true });
    assert.equal(stopped.stopped, false);
    assert.match(stopped.commands[0], /Stop-Process -Id 31337/);
    assert.match(stopped.commands[1], /LIDACTION \(dc=2 ac=1\).*UAC/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI pack/status/unpack work end to end on a WSL host", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-wsl-"));
  const statePath = path.join(dir, "session.json");
  const { runner, state } = wslRunner();

  try {
    const packOut = capture();
    const packErr = capture();
    const packCode = await main(["pack", "--hotspot", "dev-hotspot", "--watch", "--state", statePath], {
      stdout: packOut,
      stderr: packErr,
      runner
    });

    assert.equal(packCode, 0);
    assert.match(packOut.text, /Rucksack session started with Windows keep-awake PID 31337/);
    assert.match(packErr.text, /--watch watchdog is not supported on Windows\/WSL yet/);
    assert.equal(state.keepAwakeRunning, true);

    const statusOut = capture();
    const statusCode = await main(["status", "--state", statePath], {
      stdout: statusOut,
      stderr: capture(),
      runner
    });
    assert.equal(statusCode, 0);
    assert.match(statusOut.text, /Active Rucksack session/);
    assert.match(statusOut.text, /Windows keep-awake PID 31337/);

    const stopOut = capture();
    const stopCode = await main(["unpack", "--state", statePath], {
      stdout: stopOut,
      stderr: capture(),
      runner
    });
    assert.equal(stopCode, 0);
    assert.match(stopOut.text, /Rucksack session stopped/);
    assert.equal(state.keepAwakeRunning, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function config({ ssid = "", lidClosed = false } = {}) {
  return normalizeConfig({
    hotspot: { ssid },
    power: { lidClosed }
  });
}

function capture() {
  return {
    text: "",
    write(chunk) {
      this.text += chunk;
    }
  };
}

function netshOutput(ssid) {
  const ssidLine = ssid === "" ? "" : `    SSID                   : ${ssid}\r\n`;
  return (
    "\r\n" +
    "    Name                   : Wi-Fi\r\n" +
    "    Description            : Intel(R) Wireless\r\n" +
    "    State                  : connected\r\n" +
    ssidLine +
    "    BSSID                  : aa:bb:cc:dd:ee:ff\r\n" +
    "    Radio type             : 802.11ac\r\n" +
    "    Signal                 : 81%\r\n" +
    "\r\n"
  );
}

function qhOutput({ lidAc, lidDc }) {
  const hex = (value) => `0x${value.toString(16).padStart(8, "0")}`;
  return (
    `Power Scheme GUID: ${SCHEME_GUID}  (Balanced)\r\n` +
    "  GUID Alias: SCHEME_BALANCED\r\n" +
    "  Subgroup GUID: 4f971e89-eebd-4455-a8de-9e59040e7347  (Power buttons and lid)\r\n" +
    "    Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Lid close action)\r\n" +
    "      GUID Alias: LIDACTION\r\n" +
    "      Possible Setting Index: 000\r\n" +
    "      Possible Setting Friendly Name: Do nothing\r\n" +
    "      Possible Setting Index: 001\r\n" +
    "      Possible Setting Friendly Name: Sleep\r\n" +
    `    Current AC Power Setting Index: ${hex(lidAc)}\r\n` +
    `    Current DC Power Setting Index: ${hex(lidDc)}\r\n`
  );
}

function wslRunner({
  ssid = "dev-hotspot",
  battery = { EstimatedChargeRemaining: 100, BatteryStatus: 2 },
  lidAc = 1,
  lidDc = 1,
  keepAwakePid = 31337,
  elevatedFails = false,
  keepAwakeFails = false
} = {}) {
  const state = {
    ssid,
    battery,
    lidAc,
    lidDc,
    keepAwakePid,
    keepAwakeRunning: false,
    keepAwakeStarts: 0,
    elevatedWrites: []
  };

  const ok = (stdout) => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr) => ({ code: 1, stdout: "", stderr });

  const runner = {
    platform: "linux",
    hostKind: "wsl",
    async exec(command) {
      if (command.startsWith("curl ")) {
        return ok("<HTML><BODY>Success</BODY></HTML>");
      }
      if (command.includes("netsh.exe") && command.includes("show interfaces")) {
        return ok(netshOutput(state.ssid));
      }
      if (command.includes("netsh.exe") && command.includes("wlan connect")) {
        state.ssid = command.match(/name=([^']+)/)?.[1] ?? state.ssid;
        return ok("Connection request was completed successfully.\r\n");
      }
      if (command.includes("powercfg.exe") && command.includes("/getactivescheme")) {
        return ok(`Power Scheme GUID: ${SCHEME_GUID}  (Balanced)\r\n`);
      }
      if (command.includes("powercfg.exe") && command.includes("/qh")) {
        return ok(qhOutput(state));
      }
      if (command.includes("-EncodedCommand")) {
        const script = decodeEncoded(command);
        if (script === "'ok'") return ok("ok\r\n");
        if (script.includes("Win32_Battery")) {
          return ok(state.battery === null ? "" : JSON.stringify(state.battery));
        }
        if (script.includes("-Verb RunAs")) {
          state.elevatedWrites.push(script);
          if (elevatedFails) return fail("The operation was canceled by the user.");
          const inner = decodeEncoded(script.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1]);
          state.lidDc = Number(inner.match(/\/setdcvalueindex \S+ \S+ \S+ (\d+)/)[1]);
          state.lidAc = Number(inner.match(/\/setacvalueindex \S+ \S+ \S+ (\d+)/)[1]);
          return ok("");
        }
        if (script.includes("Start-Process")) {
          state.keepAwakeStarts += 1;
          if (keepAwakeFails) return fail("This command cannot be run.");
          state.keepAwakeRunning = true;
          return ok(`${state.keepAwakePid}\r\n`);
        }
        if (script.includes("Stop-Process")) {
          const wasRunning = state.keepAwakeRunning;
          state.keepAwakeRunning = false;
          return ok(wasRunning ? "stopped\r\n" : "not-running\r\n");
        }
        if (script.includes("Get-Process")) {
          return ok(state.keepAwakeRunning ? "alive\r\n" : "dead\r\n");
        }
      }
      return ok("");
    },
    async commandExists(command) {
      return ["powershell.exe", "powercfg.exe", "netsh.exe"].includes(command);
    },
    spawnDetached() {
      throw new Error("WSL sessions must not spawn local detached processes");
    },
    kill() {},
    isProcessAlive() {
      return false;
    }
  };

  return { runner, state };
}

function decodeEncoded(value) {
  const encoded = value.includes("-EncodedCommand")
    ? value.split("-EncodedCommand")[1].trim().split(/\s/)[0]
    : value;
  return Buffer.from(encoded, "base64").toString("utf16le");
}
