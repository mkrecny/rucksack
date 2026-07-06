import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultStatePath, fileExists } from "./config.mjs";
import { parsePmsetDisablesleep } from "./checks.mjs";
import { runnerHostKind } from "./platform.mjs";

export async function readSession(statePath = defaultStatePath()) {
  if (!(await fileExists(statePath))) return null;
  return JSON.parse(await readFile(statePath, "utf8"));
}

export async function writeSession(session, statePath = defaultStatePath()) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export async function removeSession(statePath = defaultStatePath()) {
  if (await fileExists(statePath)) {
    await rm(statePath);
  }
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
  if (existing && existing.pid) {
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

    await removeSession(statePath);
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
      commands
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
      cleanedStale: Boolean(existing?.pid)
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
