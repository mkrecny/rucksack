import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../src/cli.mjs";

test("start refuses to run when no hotspot is configured", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-cli-"));
  const output = capture();
  const errors = capture();

  try {
    const code = await main(["start", "--dry-run", "--state", path.join(dir, "session.json")], {
      stdout: output,
      stderr: errors,
      runner: fakeRunner()
    });

    assert.equal(code, 1);
    assert.match(output.text, /XX Hotspot: No hotspot SSID configured/);
    assert.match(errors.text, /Refusing to start/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pack alias performs a verified dry run when hotspot matches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-cli-"));
  const output = capture();
  const errors = capture();

  try {
    const code = await main(["pack", "--dry-run", "--hotspot", "Phone", "--state", path.join(dir, "session.json")], {
      stdout: output,
      stderr: errors,
      runner: fakeRunner()
    });

    assert.equal(code, 0);
    assert.equal(errors.text, "");
    assert.match(output.text, /caffeinate -dimsu/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pack dry run includes the watchdog when --watch is set", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-cli-"));
  const output = capture();
  const errors = capture();

  try {
    const code = await main(["pack", "--dry-run", "--watch", "--hotspot", "Phone", "--state", path.join(dir, "session.json")], {
      stdout: output,
      stderr: errors,
      runner: fakeRunner()
    });

    assert.equal(code, 0);
    assert.match(output.text, /caffeinate -dimsu/);
    assert.match(output.text, /watch-daemon/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pack automatically includes the watchdog in macOS lid-closed mode", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-cli-"));
  const output = capture();
  const errors = capture();

  try {
    const code = await main(
      ["pack", "--dry-run", "--lid-closed", "--hotspot", "Phone", "--state", path.join(dir, "session.json")],
      { stdout: output, stderr: errors, runner: fakeRunner() }
    );

    assert.equal(code, 0);
    assert.equal(errors.text, "");
    assert.match(output.text, /sudo pmset -a disablesleep 1/);
    assert.match(output.text, /watch-daemon/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("start refuses on non-macOS hosts even with --force", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-cli-"));
  const output = capture();
  const errors = capture();

  try {
    const code = await main(["start", "--force", "--hotspot", "Phone", "--state", path.join(dir, "session.json")], {
      stdout: output,
      stderr: errors,
      runner: fakeRunner({ platform: "linux" })
    });

    assert.equal(code, 1);
    assert.match(errors.text, /requires macOS/);
    assert.equal(output.text, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchdog receives the notify URL via env, never in argv", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-cli-"));
  const statePath = path.join(dir, "session.json");
  const spawns = [];
  const secret = "https://ntfy.sh/secret-topic";

  const runner = {
    platform: "darwin",
    async exec(command) {
      if (command.startsWith("curl ")) return { command, code: 0, stdout: "<HTML>Success</HTML>", stderr: "" };
      if (command === "pmset -g batt") {
        return { command, code: 0, stdout: "Now drawing from 'AC Power'\n -InternalBattery-0\t91%; charged;", stderr: "" };
      }
      if (command === "networksetup -listallhardwareports") {
        return { command, code: 0, stdout: "Hardware Port: Wi-Fi\nDevice: en0\n", stderr: "" };
      }
      if (command === "networksetup -getairportnetwork 'en0'") {
        return { command, code: 0, stdout: "Current Wi-Fi Network: Phone", stderr: "" };
      }
      return { command, code: 0, stdout: "", stderr: "" };
    },
    async commandExists(command) {
      return command === "pmset" || command === "caffeinate";
    },
    spawnDetached(command, args = [], opts = {}) {
      spawns.push({ command, args, opts });
      return { pid: 4242 + spawns.length };
    },
    kill() {},
    isProcessAlive() {
      return false;
    }
  };

  try {
    const code = await main(
      ["pack", "--hotspot", "Phone", "--watch", "--notify-url", secret, "--state", statePath],
      { stdout: capture(), stderr: capture(), runner }
    );

    assert.equal(code, 0);
    const daemon = spawns.find((entry) => entry.args.includes("watch-daemon"));
    assert.ok(daemon, "watch-daemon should be spawned");
    assert.equal(daemon.args.includes("--notify-url"), false);
    assert.equal(daemon.args.some((arg) => String(arg).includes("secret-topic")), false);
    assert.equal(daemon.opts.env.RUCKSACK_NOTIFY_URL, secret);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hotspot connect command joins the requested SSID", async () => {
  const output = capture();
  const errors = capture();

  const code = await main(["hotspot", "connect", "dev-hotspot"], {
    stdout: output,
    stderr: errors,
    runner: fakeRunner({ initialSsid: "Home" })
  });

  assert.equal(code, 0);
  assert.equal(errors.text, "");
  assert.match(output.text, /Connected to dev-hotspot on en0/);
});

function capture() {
  return {
    text: "",
    write(chunk) {
      this.text += chunk;
    }
  };
}

function fakeRunner({ initialSsid = "Phone", platform = "darwin" } = {}) {
  let currentSsid = initialSsid;
  return {
    platform,
    async exec(command) {
      const commands = {
        "pmset -g batt": {
          stdout: "Now drawing from 'AC Power'\n -InternalBattery-0\t91%; charged; 0:00 remaining present: true"
        },
        "networksetup -listallhardwareports": {
          stdout: "Hardware Port: Wi-Fi\nDevice: en0\n"
        },
        "pmset -g custom": {
          stdout: "Battery Power:\n disablesleep 0\n"
        }
      };
      if (command === "networksetup -getairportnetwork 'en0'") {
        return { command, code: 0, stdout: `Current Wi-Fi Network: ${currentSsid}`, stderr: "" };
      }
      if (command === "networksetup -setairportnetwork 'en0' 'dev-hotspot'") {
        currentSsid = "dev-hotspot";
        return { command, code: 0, stdout: "", stderr: "" };
      }
      const result = commands[command] ?? { stdout: "" };
      return { command, code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    async commandExists(command) {
      return command === "pmset" || command === "caffeinate";
    },
    spawnDetached() {
      return { pid: 4242 };
    },
    isProcessAlive() {
      return false;
    }
  };
}
