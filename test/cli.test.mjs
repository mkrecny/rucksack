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

test("hotspot connect command joins the requested SSID", async () => {
  const output = capture();
  const errors = capture();

  const code = await main(["hotspot", "connect", "perthull"], {
    stdout: output,
    stderr: errors,
    runner: fakeRunner({ initialSsid: "Home" })
  });

  assert.equal(code, 0);
  assert.equal(errors.text, "");
  assert.match(output.text, /Connected to perthull on en0/);
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
        }
      };
      if (command === "networksetup -getairportnetwork 'en0'") {
        return { command, code: 0, stdout: `Current Wi-Fi Network: ${currentSsid}`, stderr: "" };
      }
      if (command === "networksetup -setairportnetwork 'en0' 'perthull'") {
        currentSsid = "perthull";
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
