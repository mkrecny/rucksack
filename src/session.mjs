import { readFile, rm } from "node:fs/promises";
import { defaultStatePath, fileExists, secureWriteFile } from "./config.mjs";
import { parsePmsetDisablesleep } from "./checks.mjs";
import { runnerHostKind } from "./platform.mjs";

export async function readSession(statePath = defaultStatePath()) {
  if (!(await fileExists(statePath))) return null;
  return JSON.parse(await readFile(statePath, "utf8"));
}

export async function writeSession(session, statePath = defaultStatePath()) {
  await secureWriteFile(statePath, `${JSON.stringify(session, null, 2)}\n`);
}

export async function removeSession(statePath = defaultStatePath()) {
  if (await fileExists(statePath)) {
    await rm(statePath);
  }
}

async function readDisablesleep(runner) {
  const pmset = await runner.exec("pmset -g custom");
  if (pmset.code !== 0) return null;
  return parsePmsetDisablesleep(pmset.stdout);
}

// Restore disablesleep to `target`, verifying the machine actually reports it.
// Returns { ok, changed, from, detail }. Never throws.
async function restoreDisablesleep(runner, target) {
  const before = await readDisablesleep(runner);
  if (before === target) {
    return { ok: true, changed: false, from: before };
  }

  const result = await runner.exec(`sudo pmset -a disablesleep ${target}`, { timeoutMs: 30000 });
  if (result.code !== 0) {
    return { ok: false, changed: false, from: before, detail: (result.stderr || result.stdout || "sudo pmset restore failed").trim() };
  }

  const after = await readDisablesleep(runner);
  if (after !== target) {
    return { ok: false, changed: false, from: before, detail: `pmset did not report disablesleep ${target} after the restore.` };
  }

  return { ok: true, changed: true, from: before };
}

export async function startSession({
  runner,
  statePath = defaultStatePath(),
  lidClosed = false,
  dryRun = false,
  metadata = {}
}) {
  if (runnerHostKind(runner) === "wsl") {
    const { startSessionWsl } = await import("./wsl.mjs");
    return startSessionWsl({ runner, statePath, lidClosed, dryRun, metadata });
  }

  const existing = await readSession(statePath);
  let restoredStale = null;
  let staleRestorePreview = null;

  if (existing && (existing.pid || existing.windowsPid)) {
    const alive = typeof runner.isProcessAlive === "function"
      ? runner.isProcessAlive(Number(existing.pid))
      : true;

    if (alive) {
      return {
        alreadyRunning: true,
        session: existing,
        commands: [],
        cleanedStale: false
      };
    }

    // The old keep-awake process is gone. If it was a lid-closed session, the Mac
    // may still be sleep-disabled — restore the saved setting BEFORE discarding the
    // state, or refuse. Otherwise we would read the leftover disablesleep=1 as the
    // new "previous" baseline and later "restore" the machine into permanent awake.
    if (existing.lidClosed) {
      const target = Number.isInteger(existing.previousDisablesleep) ? existing.previousDisablesleep : 0;
      if (dryRun) {
        staleRestorePreview = `sudo pmset -a disablesleep ${target}   # restore interrupted lid-closed session`;
      } else {
        const restore = await restoreDisablesleep(runner, target);
        if (!restore.ok) {
          throw new Error(
            `Found an interrupted lid-closed session, but restoring the saved sleep setting failed: ${restore.detail} ` +
            `Refusing to discard the session so the Mac is not stranded awake. ` +
            `Restore it manually with "sudo pmset -a disablesleep ${target}", or run "rucksack recover".`
          );
        }
        restoredStale = { from: restore.from, to: target, changed: restore.changed };
      }
    }

    if (!dryRun) {
      await removeSession(statePath);
    }
  }

  const commands = ["caffeinate -dimsu"];
  let previousDisablesleep = null;

  if (lidClosed) {
    commands.push("sudo pmset -a disablesleep 1");
  }

  if (dryRun) {
    return {
      alreadyRunning: false,
      session: null,
      commands: staleRestorePreview ? [staleRestorePreview, ...commands] : commands
    };
  }

  let pid = null;
  if (lidClosed) {
    const pmset = await runner.exec("pmset -g custom");
    if (pmset.code !== 0) {
      throw new Error((pmset.stderr || pmset.stdout || "pmset -g custom failed").trim());
    }

    previousDisablesleep = parsePmsetDisablesleep(pmset.stdout);
    if (previousDisablesleep === null) {
      throw new Error("Could not read the current pmset disablesleep value; refusing lid-closed mode without restore state.");
    }

    const pmsetResult = await runner.exec("sudo pmset -a disablesleep 1", { timeoutMs: 30000 });
    if (pmsetResult.code !== 0) {
      throw new Error((pmsetResult.stderr || pmsetResult.stdout || "sudo pmset failed").trim());
    }

    const verify = await runner.exec("pmset -g custom");
    if (verify.code !== 0 || parsePmsetDisablesleep(verify.stdout) !== 1) {
      await runner.exec(`sudo pmset -a disablesleep ${previousDisablesleep}`, { timeoutMs: 30000 });
      throw new Error("pmset did not report disablesleep 1 after enabling lid-closed mode.");
    }
  }

  try {
    const child = runner.spawnDetached("caffeinate", ["-dimsu"]);
    pid = child.pid;

    const session = {
      pid,
      startedAt: new Date().toISOString(),
      lidClosed,
      previousDisablesleep,
      commands,
      metadata
    };

    await writeSession(session, statePath);
    return {
      alreadyRunning: false,
      session,
      commands,
      cleanedStale: Boolean(existing?.pid || existing?.windowsPid),
      restoredStale
    };
  } catch (error) {
    if (pid) {
      try {
        runner.kill(Number(pid));
      } catch {
        // The process may not have started cleanly.
      }
    }

    if (lidClosed && Number.isInteger(previousDisablesleep)) {
      await runner.exec(`sudo pmset -a disablesleep ${previousDisablesleep}`, { timeoutMs: 30000 });
    }

    throw error;
  }
}

export async function stopSession({
  runner,
  statePath = defaultStatePath(),
  dryRun = false
}) {
  if (runnerHostKind(runner) === "wsl") {
    const { stopSessionWsl } = await import("./wsl.mjs");
    return stopSessionWsl({ runner, statePath, dryRun });
  }

  const session = await readSession(statePath);
  if (!session) {
    return {
      stopped: false,
      commands: []
    };
  }

  const commands = [];
  if (session.watcherPid) {
    commands.push(`kill ${session.watcherPid}`);
  }
  if (session.pid) {
    commands.push(`kill ${session.pid}`);
  }

  if (session.lidClosed) {
    const restoreValue = Number.isInteger(session.previousDisablesleep)
      ? session.previousDisablesleep
      : 0;
    commands.push(`sudo pmset -a disablesleep ${restoreValue}`);
  }

  if (dryRun) {
    return {
      stopped: false,
      session,
      commands
    };
  }

  if (session.watcherPid) {
    try {
      runner.kill(Number(session.watcherPid));
    } catch {
      // The watcher may have already exited on its own.
    }
  }

  if (session.pid) {
    try {
      runner.kill(Number(session.pid));
    } catch {
      // If caffeinate already exited, the state file still needs to be cleaned up.
    }
  }

  if (session.lidClosed) {
    const restoreValue = Number.isInteger(session.previousDisablesleep)
      ? session.previousDisablesleep
      : 0;
    const result = await runner.exec(`sudo pmset -a disablesleep ${restoreValue}`, { timeoutMs: 30000 });
    if (result.code !== 0) {
      throw new Error((result.stderr || result.stdout || "sudo pmset restore failed").trim());
    }
  }

  await removeSession(statePath);
  return {
    stopped: true,
    session,
    commands
  };
}

// Give up lid-closed mode mid-session (e.g. the watchdog hit a battery or
// thermal safety condition): restore the saved disablesleep value so the Mac
// can sleep. A failed restore deliberately leaves lidClosed=true so stop,
// recover, or the next watchdog tick can retry instead of losing recovery state.
export async function releaseLidClosed({ runner, session, statePath, reason = "floor" }) {
  const target = Number.isInteger(session.previousDisablesleep) ? session.previousDisablesleep : 0;
  const restore = await restoreDisablesleep(runner, target);
  const release = { reason, at: new Date().toISOString(), to: target, ok: restore.ok };
  session.safetyRelease = release;
  // Keep the legacy field for existing status consumers and session files.
  if (reason === "battery-floor") session.floorReleased = release;
  if (restore.ok) session.lidClosed = false;
  await writeSession(session, statePath);
  return { ...restore, to: target };
}

// A reassurance utility: safely undo whatever a prior (possibly crashed) session
// left behind — kill leftover processes and, above all, restore the saved
// disablesleep value so the Mac is never stranded awake.
export async function recoverSession({
  runner,
  statePath = defaultStatePath(),
  dryRun = false,
  force = false
}) {
  if (runnerHostKind(runner) === "wsl") {
    const session = await readSession(statePath);
    if (!session) {
      return { recovered: false, nothing: true, commands: [], detail: "No active Rucksack session to recover." };
    }
    const { stopSessionWsl } = await import("./wsl.mjs");
    const stopped = await stopSessionWsl({ runner, statePath, dryRun });
    return { recovered: Boolean(stopped.stopped), wsl: true, session, commands: stopped.commands ?? [] };
  }

  const session = await readSession(statePath);

  if (!session) {
    // No saved state at all. The one dangerous residue we can still detect is
    // disablesleep left stuck at 1 (a crash before state was ever written, or a
    // hand-deleted state file). We cannot know the original value, so 0 (normal)
    // is the safe target — but only act on explicit confirmation.
    const current = await readDisablesleep(runner);
    if (current === 1) {
      const command = "sudo pmset -a disablesleep 0";
      if (dryRun || !force) {
        return {
          recovered: false,
          needsConfirm: true,
          commands: [command],
          detail: `No saved Rucksack session, but disablesleep is currently 1. If Rucksack left it that way, restore normal sleep with "${command}" or re-run "rucksack recover --yes".`
        };
      }
      const restore = await restoreDisablesleep(runner, 0);
      if (!restore.ok) {
        throw new Error(`Could not restore normal sleep: ${restore.detail} Run "${command}" manually.`);
      }
      return { recovered: true, commands: [command], detail: "Restored normal sleep (disablesleep 0). No session state was present." };
    }

    return {
      recovered: false,
      nothing: true,
      commands: [],
      detail: current === null
        ? "No active Rucksack session, and pmset could not be read to double-check sleep settings."
        : "No active Rucksack session, and sleep settings already look normal."
    };
  }

  const target = session.lidClosed
    ? (Number.isInteger(session.previousDisablesleep) ? session.previousDisablesleep : 0)
    : null;

  const commands = [];
  if (session.watcherPid) commands.push(`kill ${session.watcherPid}`);
  if (session.pid) commands.push(`kill ${session.pid}`);
  if (target !== null) commands.push(`sudo pmset -a disablesleep ${target}`);

  if (dryRun) {
    return { recovered: false, dryRun: true, session, commands };
  }

  if (session.watcherPid) {
    try { runner.kill(Number(session.watcherPid)); } catch { /* already gone */ }
  }
  if (session.pid) {
    try { runner.kill(Number(session.pid)); } catch { /* already gone */ }
  }

  let restore = null;
  if (target !== null) {
    restore = await restoreDisablesleep(runner, target);
    if (!restore.ok) {
      throw new Error(
        `Could not restore the saved sleep setting (disablesleep ${target}): ${restore.detail} ` +
        `Session state left in place. Restore manually with "sudo pmset -a disablesleep ${target}".`
      );
    }
  }

  await removeSession(statePath);
  return {
    recovered: true,
    session,
    commands,
    restore,
    detail: target !== null
      ? `Restored the saved sleep setting (disablesleep ${target}) and cleared the session state.`
      : "Cleared the session state."
  };
}
