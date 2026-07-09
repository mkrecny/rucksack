import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSession, recoverSession, startSession, stopSession, writeSession } from "../src/session.mjs";

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

test("startSession restores disablesleep before reusing a stale lid-closed session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-test-"));
  const statePath = path.join(dir, "session.json");
  // A crashed lid-closed session stranded the Mac at disablesleep 1, but the saved
  // baseline was 0. The next pack must restore 0 first — not record 1 as "previous".
  const runner = fakeRunner({ disablesleep: 1 });

  try {
    await writeSession(
      { pid: 9999, startedAt: "2026-07-01T00:00:00.000Z", lidClosed: true, previousDisablesleep: 0 },
      statePath
    );

    const result = await startSession({ runner, statePath, lidClosed: true, dryRun: false });

    assert.equal(result.session.previousDisablesleep, 0);
    assert.deepEqual(result.restoredStale, { from: 1, to: 0, changed: true });
    assert.deepEqual(runner.commands, [
      "alive:9999",
      "pmset -g custom",
      "sudo pmset -a disablesleep 0",
      "pmset -g custom",
      "pmset -g custom",
      "sudo pmset -a disablesleep 1",
      "pmset -g custom"
    ]);
    assert.equal(runner.disablesleep, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startSession refuses to discard a stale lid-closed session when restore fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-test-"));
  const statePath = path.join(dir, "session.json");
  const runner = fakeRunner({ disablesleep: 1, failDisablesleepWrite: true });

  try {
    await writeSession(
      { pid: 9999, startedAt: "2026-07-01T00:00:00.000Z", lidClosed: true, previousDisablesleep: 0 },
      statePath
    );

    await assert.rejects(
      startSession({ runner, statePath, lidClosed: true, dryRun: false }),
      /Refusing to discard/
    );

    const still = await readSession(statePath);
    assert.equal(still.pid, 9999);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startSession dry run previews the stale lid-closed restore without touching pmset", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-test-"));
  const statePath = path.join(dir, "session.json");
  const runner = fakeRunner({ disablesleep: 1 });

  try {
    await writeSession(
      { pid: 9999, startedAt: "2026-07-01T00:00:00.000Z", lidClosed: true, previousDisablesleep: 0 },
      statePath
    );

    const result = await startSession({ runner, statePath, lidClosed: true, dryRun: true });

    assert.deepEqual(result.commands, [
      "sudo pmset -a disablesleep 0   # restore interrupted lid-closed session",
      "caffeinate -dimsu",
      "sudo pmset -a disablesleep 1"
    ]);
    assert.equal(runner.commands.filter((command) => command.startsWith("sudo")).length, 0);
    const still = await readSession(statePath);
    assert.equal(still.pid, 9999);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recoverSession restores the saved setting and clears stale state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-test-"));
  const statePath = path.join(dir, "session.json");
  const runner = fakeRunner({ disablesleep: 1 });

  try {
    await writeSession(
      { pid: 9999, watcherPid: 8888, startedAt: "2026-07-01T00:00:00.000Z", lidClosed: true, previousDisablesleep: 0 },
      statePath
    );

    const result = await recoverSession({ runner, statePath });

    assert.equal(result.recovered, true);
    assert.equal(runner.disablesleep, 0);
    assert.match(result.detail, /disablesleep 0/);
    assert.ok(runner.commands.includes("kill:8888"));
    assert.ok(runner.commands.includes("kill:9999"));
    assert.equal(await readSession(statePath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recoverSession asks before touching a stranded disablesleep with no saved state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rucksack-test-"));
  const statePath = path.join(dir, "session.json");
  const runner = fakeRunner({ disablesleep: 1 });

  try {
    const asked = await recoverSession({ runner, statePath });
    assert.equal(asked.recovered, false);
    assert.equal(asked.needsConfirm, true);
    assert.deepEqual(asked.commands, ["sudo pmset -a disablesleep 0"]);
    assert.equal(runner.disablesleep, 1);

    const forced = await recoverSession({ runner, statePath, force: true });
    assert.equal(forced.recovered, true);
    assert.equal(runner.disablesleep, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function fakeRunner({ disablesleep = 0, alivePid = 4242, failDisablesleepWrite = false } = {}) {
  const runner = {
    commands: [],
    disablesleep,
    async exec(command) {
      runner.commands.push(command);
      if (command === "pmset -g custom") {
        return { command, code: 0, stdout: `disablesleep ${runner.disablesleep}\n`, stderr: "" };
      }
      if (command.startsWith("sudo pmset -a disablesleep ")) {
        if (failDisablesleepWrite) {
          return { command, code: 1, stdout: "", stderr: "pmset: operation not permitted" };
        }
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
      return pid === alivePid;
    },
    kill(pid) {
      runner.commands.push(`kill:${pid}`);
    }
  };
  return runner;
}
