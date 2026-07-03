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
    const config = configWithHotspot("perthull");
    const runner = wifiRunner({ ssid: "perthull" });

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
    const config = configWithHotspot("perthull");
    const runner = wifiRunner({ ssid: "", rejoinTo: "perthull" });

    const tick = await watchTick({ runner, config, statePath });

    assert.equal(tick.ok, true);
    assert.ok(runner.commands.includes("networksetup -setairportnetwork 'en0' 'perthull'"));
    assert.match(tick.events.join("\n"), /attempting to rejoin/);
    assert.match(tick.events.join("\n"), /Connected to perthull/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchTick restarts caffeinate when the keep-awake process died", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-watch-"));
  const statePath = path.join(dir, "session.json");

  try {
    await writeSession({ pid: 9999, startedAt: "2026-07-03T00:00:00.000Z", lidClosed: false }, statePath);
    const config = configWithHotspot("perthull");
    const runner = wifiRunner({ ssid: "perthull", alivePids: [], spawnPid: 5151 });

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
      runner: wifiRunner({ ssid: "perthull" }),
      config: configWithHotspot("perthull"),
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
      config: configWithHotspot("perthull"),
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
    assert.match(notifications[0], /perthull/);
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
      runner: wifiRunner({ ssid: "perthull" }),
      config: configWithHotspot("perthull"),
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

function configWithHotspot(ssid) {
  const config = createDefaultConfig();
  config.hotspot.ssid = ssid;
  return config;
}

function wifiRunner({ ssid, rejoinTo = null, rejoinFails = false, alivePids = [4242], spawnPid = 4242 } = {}) {
  const runner = {
    platform: "darwin",
    ssid,
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
