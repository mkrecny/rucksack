import test from "node:test";
import assert from "node:assert/strict";
import { sendNotification } from "../src/notify.mjs";
import { createDefaultConfig } from "../src/config.mjs";

test("sendNotification reports skipped when no url is configured", async () => {
  const result = await sendNotification(createDefaultConfig(), { async exec() {} }, "hello");

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
});

test("sendNotification posts the message to the configured url", async () => {
  const config = createDefaultConfig();
  config.notify.url = "https://ntfy.sh/my-rucksack";
  const commands = [];
  const runner = {
    async exec(command) {
      commands.push(command);
      return { command, code: 0, stdout: "", stderr: "" };
    }
  };

  const result = await sendNotification(config, runner, "Rucksack: link lost");

  assert.equal(result.ok, true);
  assert.equal(commands.length, 1);
  assert.match(commands[0], /^curl /);
  assert.match(commands[0], /'Rucksack: link lost'/);
  assert.match(commands[0], /'https:\/\/ntfy\.sh\/my-rucksack'/);
});

test("sendNotification surfaces curl failures", async () => {
  const config = createDefaultConfig();
  config.notify.url = "https://ntfy.sh/my-rucksack";
  const runner = {
    async exec(command) {
      return { command, code: 6, stdout: "", stderr: "curl: (6) Could not resolve host" };
    }
  };

  const result = await sendNotification(config, runner, "hello");

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.match(result.detail, /Could not resolve host/);
});
