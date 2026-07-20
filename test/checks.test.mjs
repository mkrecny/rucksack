import test from "node:test";
import assert from "node:assert/strict";
import { CONNECTIVITY_PROBE_URL, checkConnectivity, checkHotspot, checkPowerTools, checkRemotes, checkTailnet, connectHotspot, parseBattery, parseIoregSleepDisabled, parseIpconfigWifiSummary, parsePmsetDisablesleep, parseWifiDevice, parseWifiSsid, runDoctor } from "../src/checks.mjs";
import { createDefaultConfig } from "../src/config.mjs";

test("parseBattery extracts percent, power source, and state", () => {
  const parsed = parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0\t84%; discharging; 5:01 remaining present: true");

  assert.equal(parsed.percent, 84);
  assert.equal(parsed.source, "Battery Power");
  assert.equal(parsed.state, "discharging");
});

test("parseWifiDevice finds the Wi-Fi hardware device", () => {
  const raw = `Hardware Port: Ethernet
Device: en7

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: aa:bb:cc:dd:ee:ff`;

  assert.equal(parseWifiDevice(raw), "en0");
});

test("parseWifiSsid handles networksetup output", () => {
  assert.equal(parseWifiSsid("Current Wi-Fi Network: My iPhone"), "My iPhone");
  assert.equal(parseWifiSsid("You are not associated with an AirPort network."), "");
});

test("parseIpconfigWifiSummary detects active Wi-Fi with redacted SSID", () => {
  const parsed = parseIpconfigWifiSummary(`<dictionary> {
  InterfaceType : WiFi
  LinkStatusActive : TRUE
  NetworkID : <redacted>
  SSID : <redacted>
}`);

  assert.equal(parsed.connected, true);
  assert.equal(parsed.redacted, true);
  assert.equal(parsed.ssid, "");
});

test("parsePmsetDisablesleep extracts the current restore value", () => {
  assert.equal(parsePmsetDisablesleep(" sleep 10\n disablesleep 1\n tcpkeepalive 1"), 1);
  assert.equal(parsePmsetDisablesleep(" sleep 10\n"), null);
});

test("parseIoregSleepDisabled extracts effective Yes and No states", () => {
  assert.equal(parseIoregSleepDisabled('    "SleepDisabled" = Yes'), 1);
  assert.equal(parseIoregSleepDisabled('    "SleepDisabled" = No'), 0);
  assert.equal(parseIoregSleepDisabled('    "System Sleep Timer" = 1'), null);
});

test("checkHotspot fails when strict hotspot SSID does not match", async () => {
  const config = createDefaultConfig();
  config.hotspot.ssid = "Phone";
  const runner = fakeRunner({
    "networksetup -listallhardwareports": { stdout: "Hardware Port: Wi-Fi\nDevice: en0\n" },
    "networksetup -getairportnetwork 'en0'": { stdout: "Current Wi-Fi Network: Home" }
  });

  const result = await checkHotspot(config, runner);

  assert.equal(result.status, "fail");
  assert.match(result.detail, /Expected Phone/);
});

test("checkHotspot fails clearly when networksetup cannot inspect Wi-Fi", async () => {
  const config = createDefaultConfig();
  config.hotspot.ssid = "Phone";
  const runner = fakeRunner({
    "networksetup -listallhardwareports": { stdout: "AuthorizationCreate() failed: -60008\n" }
  });

  const result = await checkHotspot(config, runner);

  assert.equal(result.status, "fail");
  assert.match(result.detail, /AuthorizationCreate/);
});

test("checkHotspot fails by default when no hotspot SSID is configured", async () => {
  const result = await checkHotspot(createDefaultConfig(), fakeRunner({}));

  assert.equal(result.status, "fail");
  assert.match(result.detail, /No hotspot SSID configured/);
});

test("checkHotspot can warn instead of fail when network strictness is disabled", async () => {
  const config = createDefaultConfig();
  config.hotspot.strict = false;

  const result = await checkHotspot(config, fakeRunner({}));

  assert.equal(result.status, "warn");
});

test("checkHotspot explains active Wi-Fi with redacted SSID", async () => {
  const config = createDefaultConfig();
  config.hotspot.ssid = "dev-hotspot";
  const result = await checkHotspot(config, fakeRunner({
    "networksetup -listallhardwareports": { stdout: "Hardware Port: Wi-Fi\nDevice: en0\n" },
    "networksetup -getairportnetwork 'en0'": { stdout: "You are not associated with an AirPort network." },
    "ipconfig getsummary 'en0'": { stdout: "InterfaceType : WiFi\nLinkStatusActive : TRUE\nSSID : <redacted>\nNetworkID : <redacted>\n" }
  }));

  assert.equal(result.status, "fail");
  assert.match(result.detail, /redacted/);
});

test("checkHotspot can trust active Wi-Fi when SSID is redacted", async () => {
  const config = createDefaultConfig();
  config.hotspot.ssid = "dev-hotspot";
  config.hotspot.allowRedactedSsid = true;
  const result = await checkHotspot(config, fakeRunner({
    "networksetup -listallhardwareports": { stdout: "Hardware Port: Wi-Fi\nDevice: en0\n" },
    "networksetup -getairportnetwork 'en0'": { stdout: "You are not associated with an AirPort network." },
    "ipconfig getsummary 'en0'": { stdout: "InterfaceType : WiFi\nLinkStatusActive : TRUE\nSSID : <redacted>\nNetworkID : <redacted>\n" }
  }));

  assert.equal(result.status, "pass");
  assert.match(result.detail, /trusting/);
});

test("checkPowerTools fails when required macOS commands are unavailable", async () => {
  const result = await checkPowerTools(createDefaultConfig(), fakeRunner({
    "command -v 'pmset'": { stdout: "/usr/bin/pmset\n" },
    "command -v 'caffeinate'": { code: 1, stdout: "" }
  }));

  assert.equal(result.status, "fail");
  assert.match(result.detail, /caffeinate/);
});

test("checkPowerTools reads IOPMrootDomain when pmset omits disablesleep", async () => {
  const config = createDefaultConfig();
  config.power.lidClosed = true;
  const result = await checkPowerTools(config, fakeRunner({
    "command -v 'pmset'": { stdout: "/usr/bin/pmset\n" },
    "command -v 'caffeinate'": { stdout: "/usr/bin/caffeinate\n" },
    "pmset -g custom": { stdout: "Battery Power:\n sleep 1\n" },
    "/usr/sbin/ioreg -r -c IOPMrootDomain -d 1": { stdout: '    "SleepDisabled" = No\n' }
  }));

  assert.equal(result.status, "pass");
  assert.match(result.detail, /restore state is readable/);
});

test("connectHotspot connects and verifies the target SSID", async () => {
  const config = createDefaultConfig();
  const runner = statefulWifiRunner("Home");

  const result = await connectHotspot(config, runner, { ssid: "dev-hotspot" });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyConnected, false);
  assert.equal(result.detail, "Connected to dev-hotspot on en0.");
  assert.deepEqual(runner.commands, [
    "networksetup -listallhardwareports",
    "networksetup -getairportnetwork 'en0'",
    "networksetup -setairportnetwork 'en0' 'dev-hotspot'",
    "networksetup -getairportnetwork 'en0'"
  ]);
});

test("connectHotspot does not reconnect when already on the target SSID", async () => {
  const config = createDefaultConfig();
  const runner = statefulWifiRunner("dev-hotspot");

  const result = await connectHotspot(config, runner, { ssid: "dev-hotspot" });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyConnected, true);
  assert.equal(runner.commands.includes("networksetup -setairportnetwork 'en0' 'dev-hotspot'"), false);
});

test("connectHotspot refuses an unverified join when macOS redacts post-join SSID", async () => {
  const config = createDefaultConfig();
  const runner = redactedWifiRunner();

  const result = await connectHotspot(config, runner, { ssid: "dev-hotspot" });

  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.redacted, true);
  assert.match(result.detail, /rerun without --connect-hotspot/);
});

test("checkConnectivity passes when the captive portal probe succeeds", async () => {
  const result = await checkConnectivity(createDefaultConfig(), fakeRunner({
    [`curl -m 8 -sS ${CONNECTIVITY_PROBE_URL}`]: { stdout: "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>" }
  }));

  assert.equal(result.status, "pass");
});

test("checkConnectivity fails in strict mode when the probe cannot reach the internet", async () => {
  const result = await checkConnectivity(createDefaultConfig(), fakeRunner({
    [`curl -m 8 -sS ${CONNECTIVITY_PROBE_URL}`]: { code: 6, stderr: "curl: (6) Could not resolve host" }
  }));

  assert.equal(result.status, "fail");
  assert.match(result.detail, /No internet/);
});

test("checkConnectivity warns when a captive portal intercepts the probe", async () => {
  const result = await checkConnectivity(createDefaultConfig(), fakeRunner({
    [`curl -m 8 -sS ${CONNECTIVITY_PROBE_URL}`]: { stdout: "<html>Hotel Wi-Fi login</html>" }
  }));

  assert.equal(result.status, "warn");
  assert.match(result.detail, /captive portal/);
});

test("checkTailnet skips when Tailscale is not installed", async () => {
  const result = await checkTailnet(createDefaultConfig(), fakeRunner({}));

  assert.equal(result.status, "skip");
});

test("checkTailnet fails when required but not installed", async () => {
  const config = createDefaultConfig();
  config.tailnet.required = true;

  const result = await checkTailnet(config, fakeRunner({}));

  assert.equal(result.status, "fail");
});

test("checkTailnet passes and reports the tailnet name when running", async () => {
  const result = await checkTailnet(createDefaultConfig(), fakeRunner({
    "command -v 'tailscale'": { stdout: "/usr/local/bin/tailscale\n" },
    "'tailscale' status --json": { stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "my-mac.tail1234.ts.net." } }) }
  }));

  assert.equal(result.status, "pass");
  assert.match(result.detail, /my-mac\.tail1234\.ts\.net/);
});

test("checkTailnet warns when installed but stopped", async () => {
  const result = await checkTailnet(createDefaultConfig(), fakeRunner({
    "command -v 'tailscale'": { stdout: "/usr/local/bin/tailscale\n" },
    "'tailscale' status --json": { stdout: JSON.stringify({ BackendState: "Stopped" }) }
  }));

  assert.equal(result.status, "warn");
  assert.match(result.detail, /Stopped/);
});

test("checkRemotes starts a long-running remote detached and re-checks status", async () => {
  const config = createDefaultConfig();
  config.remotes = [{
    name: "codex",
    command: "codex",
    required: true,
    statusCommand: "pgrep -f 'codex remote-control'",
    startCommand: "codex remote-control"
  }];

  let daemonRunning = false;
  const spawned = [];
  const runner = {
    platform: "darwin",
    async exec(command) {
      if (command === "pgrep -f 'codex remote-control'") {
        return { command, code: daemonRunning ? 0 : 1, stdout: daemonRunning ? "123\n" : "", stderr: "" };
      }
      return { command, code: 0, stdout: "", stderr: "" };
    },
    async commandExists() {
      return true;
    },
    spawnDetachedShell(command) {
      spawned.push(command);
      daemonRunning = true;
      return { pid: 777 };
    }
  };

  const checks = await checkRemotes(config, runner, { startRemotes: true, startGraceMs: 1 });

  assert.deepEqual(spawned, ["codex remote-control"]);
  assert.equal(checks[0].status, "pass");
});

test("runDoctor verifies required remote status commands", async () => {
  const config = createDefaultConfig();
  config.hotspot.ssid = "Phone";
  config.remotes = [
    {
      name: "codex",
      command: "codex",
      required: true,
      statusCommand: "codex remote-control status",
      startCommand: ""
    }
  ];
  const runner = fakeRunner({
    "pmset -g batt": { stdout: "Now drawing from 'Battery Power'\n -InternalBattery-0\t91%; discharging; 7:00 remaining present: true" },
    "command -v 'pmset'": { stdout: "/usr/bin/pmset\n" },
    "command -v 'caffeinate'": { stdout: "/usr/bin/caffeinate\n" },
    "networksetup -listallhardwareports": { stdout: "Hardware Port: Wi-Fi\nDevice: en0\n" },
    "networksetup -getairportnetwork 'en0'": { stdout: "Current Wi-Fi Network: Phone" },
    "command -v 'codex'": { stdout: "/usr/local/bin/codex\n" },
    "codex remote-control status": { stdout: "ok\n" },
    [`curl -m 8 -sS ${CONNECTIVITY_PROBE_URL}`]: { stdout: "Success" }
  });

  const result = await runDoctor(config, runner);

  assert.equal(result.ok, true);
  assert.equal(result.summary.fail, 0);
});

function fakeRunner(commands) {
  return {
    platform: "darwin",
    async exec(command) {
      const result = commands[command] ?? { code: 0, stdout: "", stderr: "" };
      return {
        command,
        code: result.code ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? ""
      };
    },
    async commandExists(command) {
      const result = commands[`command -v '${command}'`];
      if (!result) return false;
      return Boolean((result.code ?? 0) === 0 && result.stdout);
    }
  };
}

function redactedWifiRunner() {
  const runner = {
    platform: "darwin",
    commands: [],
    async exec(command) {
      runner.commands.push(command);
      if (command === "networksetup -listallhardwareports") {
        return { command, code: 0, stdout: "Hardware Port: Wi-Fi\nDevice: en0\n", stderr: "" };
      }
      if (command === "networksetup -getairportnetwork 'en0'") {
        return { command, code: 0, stdout: "You are not associated with an AirPort network.", stderr: "" };
      }
      if (command === "networksetup -setairportnetwork 'en0' 'dev-hotspot'") {
        return { command, code: 0, stdout: "", stderr: "" };
      }
      if (command === "ipconfig getsummary 'en0'") {
        return { command, code: 0, stdout: "InterfaceType : WiFi\nLinkStatusActive : TRUE\nSSID : <redacted>\nNetworkID : <redacted>\n", stderr: "" };
      }
      return { command, code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    },
    async commandExists() {
      return true;
    }
  };
  return runner;
}

function statefulWifiRunner(initialSsid) {
  const runner = {
    platform: "darwin",
    ssid: initialSsid,
    commands: [],
    async exec(command) {
      runner.commands.push(command);
      if (command === "networksetup -listallhardwareports") {
        return { command, code: 0, stdout: "Hardware Port: Wi-Fi\nDevice: en0\n", stderr: "" };
      }
      if (command === "networksetup -getairportnetwork 'en0'") {
        return { command, code: 0, stdout: runner.ssid ? `Current Wi-Fi Network: ${runner.ssid}` : "You are not associated with an AirPort network.", stderr: "" };
      }
      if (command === "networksetup -setairportnetwork 'en0' 'dev-hotspot'") {
        runner.ssid = "dev-hotspot";
        return { command, code: 0, stdout: "", stderr: "" };
      }
      return { command, code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    },
    async commandExists() {
      return true;
    }
  };
  return runner;
}
