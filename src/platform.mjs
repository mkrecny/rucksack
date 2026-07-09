import { exec } from "node:child_process";
import { spawn } from "node:child_process";
import os from "node:os";

export function detectHostKind({
  platform = process.platform,
  release = os.release(),
  env = process.env
} = {}) {
  if (platform !== "linux") return platform;
  if (/microsoft/i.test(release) || env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "wsl";
  return platform;
}

export function runnerHostKind(runner) {
  return runner?.hostKind ?? runner?.platform ?? process.platform;
}

export function createRunner({
  platform = process.platform,
  env = process.env,
  shell = process.env.SHELL || "/bin/zsh",
  hostKind
} = {}) {
  return {
    platform,
    hostKind: hostKind ?? detectHostKind({ platform, env }),
    env,
    async exec(command, { timeoutMs = 7000 } = {}) {
      return new Promise((resolve) => {
        exec(
          command,
          {
            env,
            shell,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024
          },
          (error, stdout, stderr) => {
            resolve({
              command,
              code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
              signal: error?.signal ?? null,
              stdout: stdout ?? "",
              stderr: stderr ?? ""
            });
          }
        );
      });
    },
    async commandExists(command) {
      if (!command) return false;
      const result = await this.exec(`command -v ${shellQuote(command)}`);
      return result.code === 0 && result.stdout.trim().length > 0;
    },
    spawnDetached(command, args = [], { env: envOverride } = {}) {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        env: envOverride ?? env
      });
      child.unref();
      return { pid: child.pid };
    },
    spawnDetachedShell(command) {
      const child = spawn(shell, ["-c", command], {
        detached: true,
        stdio: "ignore",
        env
      });
      child.unref();
      return { pid: child.pid };
    },
    kill(pid) {
      process.kill(pid, "SIGTERM");
    },
    isProcessAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
  };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
