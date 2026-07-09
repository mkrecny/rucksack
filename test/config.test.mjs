import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyOptionOverrides, createDefaultConfig, normalizeConfig, sampleConfig, writeConfig } from "../src/config.mjs";
import { parseOptions } from "../src/cli.mjs";

test("normalizeConfig keeps default remotes and merges configured remotes", () => {
  const config = normalizeConfig({
    remotes: [{ name: "codex", required: true, statusCommand: "codex remote-control status" }]
  });

  assert.equal(config.remotes.find((remote) => remote.name === "codex").required, true);
  assert.ok(config.remotes.find((remote) => remote.name === "claude"));
});

test("applyOptionOverrides sets hotspot and required remotes", () => {
  const config = applyOptionOverrides(createDefaultConfig(), {
    hotspot: "Phone",
    remote: ["codex", "grok"],
    "minimum-battery": "50",
    "lid-closed": true
  });

  assert.equal(config.hotspot.ssid, "Phone");
  assert.equal(config.power.minimumBatteryPercent, 50);
  assert.equal(config.power.lidClosed, true);
  assert.equal(applyOptionOverrides(createDefaultConfig(), { "allow-redacted-ssid": true }).hotspot.allowRedactedSsid, true);
  assert.equal(config.remotes.find((remote) => remote.name === "codex").required, true);
  assert.equal(config.remotes.find((remote) => remote.name === "grok").required, true);
});

test("sampleConfig includes a working codex remote-control preset", () => {
  const config = sampleConfig({ hotspot: "Phone" });
  const codex = config.remotes.find((remote) => remote.name === "codex");

  assert.equal(config.hotspot.ssid, "Phone");
  assert.equal(codex.required, false);
  assert.equal(codex.statusCommand, "pgrep -f 'codex remote-control'");
  assert.equal(codex.startCommand, "codex remote-control");
});

test("normalizeConfig defaults notify and tailnet settings", () => {
  const config = normalizeConfig({});

  assert.equal(config.notify.url, "");
  assert.equal(config.tailnet.required, false);
});

test("applyOptionOverrides sets notify url and tailnet requirement", () => {
  const config = applyOptionOverrides(createDefaultConfig(), {
    "notify-url": "https://ntfy.sh/my-rucksack",
    "require-tailnet": true
  });

  assert.equal(config.notify.url, "https://ntfy.sh/my-rucksack");
  assert.equal(config.tailnet.required, true);
});

test("normalizeConfig and overrides handle battery thresholds", () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.power.warnBatteryPercent, null);
  assert.equal(defaults.power.floorBatteryPercent, null);

  const configured = normalizeConfig({ power: { warnBatteryPercent: 25, floorBatteryPercent: 200 } });
  assert.equal(configured.power.warnBatteryPercent, 25);
  assert.equal(configured.power.floorBatteryPercent, 100); // clamped to 0..100

  const overridden = applyOptionOverrides(createDefaultConfig(), { "warn-battery": "20", "sleep-battery": "10" });
  assert.equal(overridden.power.warnBatteryPercent, 20);
  assert.equal(overridden.power.floorBatteryPercent, 10);
});

test("writeConfig writes the config file with 0600 permissions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-cfg-"));
  const configPath = path.join(dir, "nested", "config.json");

  try {
    await writeConfig(createDefaultConfig(), configPath);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(dir, "nested"))).mode & 0o777, 0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseOptions supports repeated options and inline values", () => {
  const parsed = parseOptions(["--hotspot=Phone", "--remote", "codex", "--remote", "claude", "--dry-run"]);

  assert.equal(parsed.options.hotspot, "Phone");
  assert.deepEqual(parsed.options.remote, ["codex", "claude"]);
  assert.equal(parsed.options.dryRun, true);
});
