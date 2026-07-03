import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSession, startSession, stopSession, writeSession } from "../src/session.mjs";

test("startSession dry run reports commands without writing state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-test-"));
  const statePath = path.join(dir, "session.json");

  try {
    const result = await startSession({
      runner: fakeRunner(),
      statePath,
      lidClosed: true,
      dryRun: true
    });

    assert.equal(result.session, null);
    assert.deepEqual(result.commands, ["caffeinate -dimsu", "sudo pmset -a disablesleep 1"]);
    assert.equal(await readSession(statePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startSession writes state and stopSession restores saved lid setting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-test-"));
  const statePath = path.join(dir, "session.json");
  const runner = fakeRunner();

  try {
    const result = await startSession({
      runner,
      statePath,
      lidClosed: true,
      dryRun: false
    });

    assert.equal(result.session.pid, 4242);
    assert.equal(result.session.previousDisablesleep, 0);

    const stopped = await stopSession({ runner, statePath });
    assert.equal(stopped.stopped, true);
    assert.deepEqual(runner.commands, [
      "pmset -g custom",
      "sudo pmset -a disablesleep 1",
      "pmset -g custom",
      "kill:4242",
      "sudo pmset -a disablesleep 0"
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startSession cleans stale state and starts a new caffeinate process", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-test-"));
  const statePath = path.join(dir, "session.json");
  const runner = fakeRunner();

  try {
    await writeSession({ pid: 9999, startedAt: "2026-07-01T00:00:00.000Z", lidClosed: false }, statePath);

    const result = await startSession({
      runner,
      statePath,
      lidClosed: false,
      dryRun: false
    });

    assert.equal(result.cleanedStale, true);
    assert.equal(result.session.pid, 4242);
    assert.deepEqual(runner.commands, ["alive:9999"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function fakeRunner() {
  const runner = {
    commands: [],
    disablesleep: 0,
    async exec(command) {
      runner.commands.push(command);
      if (command === "pmset -g custom") {
        return { command, code: 0, stdout: `disablesleep ${runner.disablesleep}\n`, stderr: "" };
      }
      if (command.startsWith("sudo pmset -a disablesleep ")) {
        runner.disablesleep = Number(command.split(" ").at(-1));
        return { command, code: 0, stdout: "", stderr: "" };
      }
      return { command, code: 0, stdout: "", stderr: "" };
    },
    spawnDetached() {
      return { pid: 4242 };
    },
    isProcessAlive(pid) {
      runner.commands.push(`alive:${pid}`);
      return pid === 4242;
    },
    kill(pid) {
      runner.commands.push(`kill:${pid}`);
    }
  };
  return runner;
}
