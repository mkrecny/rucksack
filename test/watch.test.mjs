import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWatchLoop, watchTick } from "../src/watch.mjs";
import { readSession, writeSession } from "../src/session.mjs";
import { createDefaultConfig } from "../src/config.mjs";

test("watchTick reports ok while connected to the expected hotspot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");

  try {
    await writeSession({ pid: 4242, startedAt: "2026-07-03T00:00:00.000Z", lidClosed: false }, statePath);
    const config = configWithHotspot("dev-hotspot");
    const runner = wifiRunner({ ssid: "dev-hotspot" });

    const tick = await watchTick({ runner, config, statePath });

    assert.equal(tick.done, false);
    assert.equal(tick.ok, true);
    assert.deepEqual(tick.events, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchTick rejoins the hotspot when Wi-Fi drops", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");

  try {
    await writeSession({ pid: 4242, startedAt: "2026-07-03T00:00:00.000Z", lidClosed: false }, statePath);
    const config = configWithHotspot("dev-hotspot");
    const runner = wifiRunner({ ssid: "", rejoinTo: "dev-hotspot" });

    const tick = await watchTick({ runner, config, statePath });

    assert.equal(tick.ok, true);
    assert.ok(runner.commands.includes("networksetup -setairportnetwork 'en0' 'dev-hotspot'"));
    assert.match(tick.events.join("\n"), /attempting to rejoin/);
    assert.match(tick.events.join("\n"), /Connected to dev-hotspot/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchTick restarts caffeinate when the keep-awake process died", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");

  try {
    await writeSession({ pid: 9999, startedAt: "2026-07-03T00:00:00.000Z", lidClosed: false }, statePath);
    const config = configWithHotspot("dev-hotspot");
    const runner = wifiRunner({ ssid: "dev-hotspot", alivePids: [], spawnPid: 5151 });

    const tick = await watchTick({ runner, config, statePath });

    assert.equal(tick.ok, true);
    assert.match(tick.events.join("\n"), /restarted it with PID 5151/);
    const session = await readSession(statePath);
    assert.equal(session.pid, 5151);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWatchLoop exits when the session state is removed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");
  const logs = [];

  try {
    const result = await runWatchLoop({
      runner: wifiRunner({ ssid: "dev-hotspot" }),
      config: configWithHotspot("dev-hotspot"),
      statePath,
      log: (line) => logs.push(line),
      intervalMs: 1,
      maxTicks: 10
    });

    assert.equal(result.reason, "session-removed");
    assert.equal(result.ticks, 0);
    assert.match(logs.join("\n"), /watch exiting/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWatchLoop notifies once on trouble, not on every failing tick", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");
  const notifications = [];

  try {
    await writeSession({ pid: 4242, startedAt: "2026-07-03T00:00:00.000Z", lidClosed: false }, statePath);

    await runWatchLoop({
      runner: wifiRunner({ ssid: "", rejoinFails: true }),
      config: configWithHotspot("dev-hotspot"),
      statePath,
      notify: async (message) => {
        notifications.push(message);
        return { ok: true };
      },
      intervalMs: 1,
      maxTicks: 3
    });

    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /connection trouble/);
    assert.match(notifications[0], /dev-hotspot/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWatchLoop logs link transitions and stops at maxTicks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");
  const logs = [];

  try {
    await writeSession({ pid: 4242, startedAt: "2026-07-03T00:00:00.000Z", lidClosed: false }, statePath);

    const result = await runWatchLoop({
      runner: wifiRunner({ ssid: "dev-hotspot" }),
      config: configWithHotspot("dev-hotspot"),
      statePath,
      log: (line) => logs.push(line),
      intervalMs: 1,
      maxTicks: 3
    });

    assert.equal(result.reason, "max-ticks");
    assert.equal(result.ticks, 3);
    assert.equal(logs.filter((line) => line === "Link OK.").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchTick restores normal sleep when battery hits the floor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");

  try {
    await writeSession(
      { pid: 4242, startedAt: "2026-07-03T00:00:00.000Z", lidClosed: true, previousDisablesleep: 0 },
      statePath
    );
    const config = configWithHotspot("dev-hotspot");
    config.power.floorBatteryPercent = 10;
    const runner = wifiRunner({ ssid: "dev-hotspot", battPercent: 8, disablesleep: 1 });

    const tick = await watchTick({ runner, config, statePath });

    assert.equal(tick.floorTripped, true);
    assert.match(tick.events.join("\n"), /floor/);
    assert.equal(runner.disablesleep, 0);
    const session = await readSession(statePath);
    assert.equal(session.lidClosed, false);
    assert.ok(session.floorReleased);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchTick warns when battery is low but above the floor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");

  try {
    await writeSession(
      { pid: 4242, startedAt: "2026-07-03T00:00:00.000Z", lidClosed: true, previousDisablesleep: 0 },
      statePath
    );
    const config = configWithHotspot("dev-hotspot");
    config.power.warnBatteryPercent = 20;
    const runner = wifiRunner({ ssid: "dev-hotspot", battPercent: 18 });

    const tick = await watchTick({ runner, config, statePath });

    assert.equal(tick.batteryWarn, true);
    assert.equal(tick.floorTripped, false);
    assert.match(tick.events.join("\n"), /18% and falling/);
    const session = await readSession(statePath);
    assert.equal(session.lidClosed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchTick flags thermal throttling inside the bag", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");

  try {
    await writeSession({ pid: 4242, startedAt: "2026-07-03T00:00:00.000Z", lidClosed: false }, statePath);
    const config = configWithHotspot("dev-hotspot");
    const runner = wifiRunner({ ssid: "dev-hotspot", speedLimit: 70 });

    const tick = await watchTick({ runner, config, statePath });

    assert.equal(tick.thermalThrottled, true);
    assert.match(tick.events.join("\n"), /Thermal pressure/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchTick restores normal sleep when thermal pressure hits lid-closed mode", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");

  try {
    await writeSession(
      { pid: 4242, startedAt: "2026-07-03T00:00:00.000Z", lidClosed: true, previousDisablesleep: 0 },
      statePath
    );
    const config = configWithHotspot("dev-hotspot");
    const runner = wifiRunner({ ssid: "dev-hotspot", speedLimit: 70, disablesleep: 1 });

    const tick = await watchTick({ runner, config, statePath });

    assert.equal(tick.thermalThrottled, true);
    assert.equal(tick.thermalTripped, true);
    assert.equal(runner.disablesleep, 0);
    assert.match(tick.events.join("\n"), /restored normal sleep/);
    const session = await readSession(statePath);
    assert.equal(session.lidClosed, false);
    assert.equal(session.safetyRelease.reason, "thermal-pressure");
    assert.equal(session.safetyRelease.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchTick preserves recovery state when thermal sleep restore fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");

  try {
    await writeSession(
      { pid: 4242, startedAt: "2026-07-03T00:00:00.000Z", lidClosed: true, previousDisablesleep: 0 },
      statePath
    );
    const config = configWithHotspot("dev-hotspot");
    const runner = wifiRunner({ ssid: "dev-hotspot", speedLimit: 70, disablesleep: 1, restoreFails: true });

    const tick = await watchTick({ runner, config, statePath });

    assert.equal(tick.thermalTripped, false);
    assert.match(tick.events.join("\n"), /restoring normal sleep failed/);
    const session = await readSession(statePath);
    assert.equal(session.lidClosed, true);
    assert.equal(session.safetyRelease.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWatchLoop notifies once when the battery floor trips", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");
  const notifications = [];

  try {
    await writeSession(
      { pid: 4242, startedAt: "2026-07-03T00:00:00.000Z", lidClosed: true, previousDisablesleep: 0 },
      statePath
    );
    const config = configWithHotspot("dev-hotspot");
    config.power.floorBatteryPercent = 10;

    await runWatchLoop({
      runner: wifiRunner({ ssid: "dev-hotspot", battPercent: 5, disablesleep: 1 }),
      config,
      statePath,
      notify: async (message) => {
        notifications.push(message);
        return { ok: true };
      },
      intervalMs: 1,
      maxTicks: 3
    });

    assert.equal(notifications.filter((message) => /floor/.test(message)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function configWithHotspot(ssid) {
  const config = createDefaultConfig();
  config.hotspot.ssid = ssid;
  return config;
}

function wifiRunner({
  ssid,
  rejoinTo = null,
  rejoinFails = false,
  alivePids = [4242],
  spawnPid = 4242,
  battPercent = null,
  battSource = "Battery Power",
  speedLimit = 100,
  disablesleep = 0,
  restoreFails = false
} = {}) {
  const runner = {
    platform: "darwin",
    ssid,
    disablesleep,
    commands: [],
    async exec(command) {
      runner.commands.push(command);
      if (command === "networksetup -listallhardwareports") {
        return { command, code: 0, stdout: "Hardware Port: Wi-Fi\nDevice: en0\n", stderr: "" };
      }
      if (command === "networksetup -getairportnetwork 'en0'") {
        return {
          command,
          code: 0,
          stdout: runner.ssid ? `Current Wi-Fi Network: ${runner.ssid}` : "You are not associated with an AirPort network.",
          stderr: ""
        };
      }
      if (command.startsWith("networksetup -setairportnetwork 'en0'")) {
        if (rejoinFails) {
          return { command, code: 1, stdout: "", stderr: "Could not find network" };
        }
        if (rejoinTo) runner.ssid = rejoinTo;
        return { command, code: 0, stdout: "", stderr: "" };
      }
      if (command.startsWith("ipconfig getsummary")) {
        return { command, code: 0, stdout: "InterfaceType : WiFi\nLinkStatusActive : FALSE\n", stderr: "" };
      }
      if (command === "pmset -g batt") {
        if (battPercent === null) return { command, code: 0, stdout: "", stderr: "" };
        return {
          command,
          code: 0,
          stdout: `Now drawing from '${battSource}'\n -InternalBattery-0\t${battPercent}%; discharging; 1:30 remaining present: true`,
          stderr: ""
        };
      }
      if (command === "pmset -g therm") {
        return { command, code: 0, stdout: `CPU_Speed_Limit \t= ${speedLimit}`, stderr: "" };
      }
      if (command === "pmset -g custom") {
        return { command, code: 0, stdout: `disablesleep ${runner.disablesleep}\n`, stderr: "" };
      }
      if (command.startsWith("sudo pmset -a disablesleep ")) {
        if (restoreFails) {
          return { command, code: 1, stdout: "", stderr: "pmset restore failed" };
        }
        runner.disablesleep = Number(command.split(" ").at(-1));
        return { command, code: 0, stdout: "", stderr: "" };
      }
      return { command, code: 0, stdout: "", stderr: "" };
    },
    async commandExists() {
      return true;
    },
    spawnDetached() {
      return { pid: spawnPid };
    },
    isProcessAlive(pid) {
      return alivePids.includes(pid);
    },
    kill() {}
  };
  return runner;
}
