import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeConfig, parsePorts } from "../src/config.mjs";
import { runDoctor } from "../src/checks.mjs";
import { readSession } from "../src/session.mjs";
import { main } from "../src/cli.mjs";
import {
  buildExposeReport,
  checkExposedPorts,
  checkFirewall,
  classifyListenAddresses,
  parseFirewallState,
  parseLsofListenAddresses,
  parseSsListenAddresses
} from "../src/expose.mjs";

const LSOF_WILDCARD =
  "COMMAND   PID  USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME\n" +
  "node    12345 myles   23u  IPv6  0xabc      0t0  TCP *:3000 (LISTEN)\n";

const LSOF_LOOPBACK =
  "COMMAND   PID  USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME\n" +
  "node    12345 myles   23u  IPv4  0xabc      0t0  TCP 127.0.0.1:3000 (LISTEN)\n" +
  "node    12345 myles   24u  IPv6  0xabc      0t0  TCP [::1]:3000 (LISTEN)\n";

const SS_OUTPUT =
  "State    Recv-Q   Send-Q     Local Address:Port      Peer Address:Port  Process\n" +
  "LISTEN   0        511            127.0.0.1:3000           0.0.0.0:*\n" +
  "LISTEN   0        4096                   *:30001                *:*\n" +
  "LISTEN   0        511                 [::]:8080              [::]:*\n";

test("parsePorts accepts repeats and comma lists, drops junk, dedupes", () => {
  assert.deepEqual(parsePorts("3000"), [3000]);
  assert.deepEqual(parsePorts(["3000", "5173,8080", "3000"]), [3000, 5173, 8080]);
  assert.deepEqual(parsePorts(["nope", "0", "70000", true]), []);
  assert.deepEqual(parsePorts(undefined), []);
});

test("parseLsofListenAddresses extracts listen addresses", () => {
  assert.deepEqual(parseLsofListenAddresses(LSOF_WILDCARD), ["*:3000"]);
  assert.deepEqual(parseLsofListenAddresses(LSOF_LOOPBACK), ["127.0.0.1:3000", "[::1]:3000"]);
  assert.deepEqual(parseLsofListenAddresses(""), []);
});

test("parseSsListenAddresses matches the exact port only", () => {
  assert.deepEqual(parseSsListenAddresses(SS_OUTPUT, 3000), ["127.0.0.1:3000"]);
  assert.deepEqual(parseSsListenAddresses(SS_OUTPUT, 8080), ["[::]:8080"]);
  assert.deepEqual(parseSsListenAddresses(SS_OUTPUT, 300), []);
});

test("classifyListenAddresses distinguishes loopback-only binds", () => {
  assert.deepEqual(classifyListenAddresses(["127.0.0.1:3000", "[::1]:3000"]), { listening: true, loopbackOnly: true });
  assert.deepEqual(classifyListenAddresses(["127.0.0.1:3000", "*:3000"]), { listening: true, loopbackOnly: false });
  assert.deepEqual(classifyListenAddresses([]), { listening: false, loopbackOnly: false });
});

test("parseFirewallState reads socketfilterfw output", () => {
  assert.equal(parseFirewallState("Firewall is disabled. (State = 0)"), 0);
  assert.equal(parseFirewallState("Firewall is enabled. (State = 1)"), 1);
  assert.equal(parseFirewallState("Firewall is set to block all... (State = 2)"), 2);
  assert.equal(parseFirewallState("something else"), null);
});

test("checkFirewall warns on enabled, fails on block-all", async () => {
  const on = await checkFirewall({}, macRunner({ firewallState: 1 }).runner);
  assert.equal(on.status, "warn");
  assert.match(on.detail, /Allow dialog nobody can click with the lid closed/);

  const off = await checkFirewall({}, macRunner({ firewallState: 0 }).runner);
  assert.equal(off.status, "pass");

  const blockAll = await checkFirewall({}, macRunner({ firewallState: 2 }).runner);
  assert.equal(blockAll.status, "fail");
});

test("checkExposedPorts passes with phone URLs when the bind is reachable", async () => {
  const { runner } = macRunner({ lsof: LSOF_WILDCARD });
  const [result] = await checkExposedPorts(normalizeConfig({}), runner, [3000]);

  assert.equal(result.status, "pass");
  assert.match(result.detail, /listening on \*:3000/);
  assert.match(result.detail, /http:\/\/172\.20\.10\.2:3000 · http:\/\/myles-mbp\.local:3000/);
});

test("checkExposedPorts warns on loopback-only and on silent ports", async () => {
  const loopback = macRunner({ lsof: LSOF_LOOPBACK });
  const [warned] = await checkExposedPorts(normalizeConfig({}), loopback.runner, [3000]);
  assert.equal(warned.status, "warn");
  assert.match(warned.detail, /your phone won't reach it/);
  assert.match(warned.detail, /--host 0\.0\.0\.0/);

  const silent = macRunner({ lsof: null });
  const [quiet] = await checkExposedPorts(normalizeConfig({}), silent.runner, [3000]);
  assert.equal(quiet.status, "warn");
  assert.match(quiet.detail, /Nothing is listening on port 3000 yet/);
  assert.match(quiet.detail, /http:\/\/172\.20\.10\.2:3000/);
});

test("checkExposedPorts on WSL explains NAT vs mirrored networking", async () => {
  const nat = wslExposeRunner({ ss: SS_OUTPUT.replace("127.0.0.1:3000", "0.0.0.0:3000"), mode: null });
  const [natCheck] = await checkExposedPorts(normalizeConfig({}), nat, [3000]);
  assert.equal(natCheck.status, "warn");
  assert.match(natCheck.detail, /WSL NAT networking hides it|netsh portproxy/);

  const mirrored = wslExposeRunner({ ss: SS_OUTPUT.replace("127.0.0.1:3000", "0.0.0.0:3000"), mode: "mirrored" });
  const [mirroredCheck] = await checkExposedPorts(normalizeConfig({}), mirrored, [3000]);
  assert.equal(mirroredCheck.status, "pass");
  assert.match(mirroredCheck.detail, /mirrored networking/);

  const loopback = wslExposeRunner({ ss: SS_OUTPUT, mode: "mirrored" });
  const [loopbackCheck] = await checkExposedPorts(normalizeConfig({}), loopback, [3000]);
  assert.equal(loopbackCheck.status, "warn");
  assert.match(loopbackCheck.detail, /loopback only/);
});

test("runDoctor includes firewall and expose checks when ports are configured", async () => {
  const { runner } = macRunner({ lsof: LSOF_WILDCARD, firewallState: 1 });
  const config = normalizeConfig({ hotspot: { ssid: "Phone" }, expose: { ports: [3000] } });
  const result = await runDoctor(config, runner);

  const ids = result.checks.map((item) => item.id);
  assert.ok(ids.includes("firewall"));
  assert.ok(ids.includes("expose:3000"));
  assert.equal(result.ok, true);
});

test("buildExposeReport composes phone URLs and the ntfy message", async () => {
  const { runner } = macRunner({});
  const report = await buildExposeReport(normalizeConfig({}), runner, [3000, 5173]);

  assert.equal(report.entries.length, 2);
  assert.deepEqual(report.entries[0].urls, ["http://172.20.10.2:3000", "http://myles-mbp.local:3000"]);
  assert.match(report.lines[1], /Phone URL for 5173/);
  assert.match(report.notifyMessage, /^Rucksack packed\. Dev URLs: 3000 → /);
});

test("pack prints phone URLs, stores them in the session, and pushes them to ntfy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-expose-"));
  const statePath = path.join(dir, "session.json");
  const { runner, state } = macRunner({ lsof: LSOF_WILDCARD, firewallState: 0 });

  try {
    const output = capture();
    const errors = capture();
    const code = await main(
      ["pack", "--hotspot", "Phone", "--expose", "3000", "--notify-url", "https://ntfy.sh/test-topic", "--state", statePath],
      { stdout: output, stderr: errors, runner }
    );

    assert.equal(code, 0);
    assert.match(output.text, /Phone URL for 3000: http:\/\/172\.20\.10\.2:3000 · http:\/\/myles-mbp\.local:3000/);
    assert.match(output.text, /Phone URLs pushed to https:\/\/ntfy\.sh\/test-topic/);
    assert.equal(state.notifications.length, 1);
    assert.match(state.notifications[0], /Rucksack packed\. Dev URLs: 3000/);
    assert.match(state.notifications[0], /172\.20\.10\.2:3000/);

    const session = await readSession(statePath);
    assert.equal(session.metadata.expose[0].port, 3000);
    assert.equal(session.metadata.expose[0].urls.length, 2);

    const statusOut = capture();
    await main(["status", "--state", statePath], { stdout: statusOut, stderr: capture(), runner });
    assert.match(statusOut.text, /phone URL 3000: http:\/\/172\.20\.10\.2:3000/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function capture() {
  return {
    text: "",
    write(chunk) {
      this.text += chunk;
    }
  };
}

function macRunner({ lsof = LSOF_WILDCARD, firewallState = 0, ip = "172.20.10.2", host = "myles-mbp" } = {}) {
  const state = { notifications: [] };
  const ok = (stdout) => ({ code: 0, stdout, stderr: "" });

  const runner = {
    platform: "darwin",
    async exec(command) {
      if (command.startsWith("curl -m 10 -sS -X POST")) {
        state.notifications.push(command);
        return ok("");
      }
      if (command.startsWith("curl ")) {
        return ok("<HTML>Success</HTML>");
      }
      if (command === "networksetup -listallhardwareports") {
        return ok("Hardware Port: Wi-Fi\nDevice: en0\n");
      }
      if (command === "networksetup -getairportnetwork 'en0'") {
        return ok("Current Wi-Fi Network: Phone");
      }
      if (command === "pmset -g batt") {
        return ok("Now drawing from 'AC Power'\n -InternalBattery-0\t91%; charged; 0:00 remaining present: true");
      }
      if (command === "ipconfig getifaddr 'en0'") {
        return ip ? ok(`${ip}\n`) : { code: 1, stdout: "", stderr: "" };
      }
      if (command === "scutil --get LocalHostName") {
        return host ? ok(`${host}\n`) : { code: 1, stdout: "", stderr: "" };
      }
      if (command.startsWith("lsof ")) {
        return lsof === null ? { code: 1, stdout: "", stderr: "" } : ok(lsof);
      }
      if (command.includes("socketfilterfw")) {
        return ok(`Firewall is configured. (State = ${firewallState})`);
      }
      return ok("");
    },
    async commandExists(command) {
      return command === "pmset" || command === "caffeinate";
    },
    spawnDetached() {
      return { pid: 4242 };
    },
    kill() {},
    isProcessAlive() {
      return false;
    }
  };

  return { runner, state };
}

function wslExposeRunner({ ss, mode }) {
  return {
    platform: "linux",
    hostKind: "wsl",
    async exec(command) {
      if (command === "ss -ltn") {
        return { code: 0, stdout: ss, stderr: "" };
      }
      if (command === "wslinfo --networking-mode") {
        return mode ? { code: 0, stdout: `${mode}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "not supported" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    async commandExists() {
      return false;
    }
  };
}
