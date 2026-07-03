import test from "node:test";
import assert from "node:assert/strict";
import { applyOptionOverrides, createDefaultConfig, normalizeConfig, sampleConfig } from "../src/config.mjs";
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

test("parseOptions supports repeated options and inline values", () => {
  const parsed = parseOptions(["--hotspot=Phone", "--remote", "codex", "--remote", "claude", "--dry-run"]);

  assert.equal(parsed.options.hotspot, "Phone");
  assert.deepEqual(parsed.options.remote, ["codex", "claude"]);
  assert.equal(parsed.options.dryRun, true);
});
