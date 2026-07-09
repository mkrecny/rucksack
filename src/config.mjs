import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_VERSION = 1;
export const DEFAULT_REMOTE_NAMES = ["codex", "claude", "agy", "grok"];

export function createDefaultConfig() {
  return {
    version: CONFIG_VERSION,
    hotspot: {
      ssid: "",
      strict: true,
      allowRedactedSsid: false
    },
    power: {
      minimumBatteryPercent: 35,
      lidClosed: false,
      warnBatteryPercent: null,
      floorBatteryPercent: null
    },
    watch: {
      enabled: false,
      intervalSeconds: 20
    },
    notify: {
      url: ""
    },
    tailnet: {
      required: false
    },
    expose: {
      ports: []
    },
    remotes: DEFAULT_REMOTE_NAMES.map((name) => ({
      name,
      command: name,
      required: false,
      statusCommand: "",
      startCommand: ""
    }))
  };
}

export function defaultConfigPath(home = os.homedir()) {
  return path.join(home, ".rucksack", "config.json");
}

export function defaultStatePath(home = os.homedir()) {
  return path.join(home, ".rucksack", "session.json");
}

export async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ~/.rucksack holds a config that may carry an ntfy/webhook URL (a capability
// secret) and a session file with operational details. Keep the directory 0700
// and the files 0600. chmod is best-effort: it is a no-op on filesystems that
// don't support POSIX modes (e.g. some Windows-mounted paths).
export async function ensureSecureDir(dir) {
  await mkdir(dir, { recursive: true });
  try {
    await chmod(dir, 0o700);
  } catch {
    // Best effort; the filesystem may not support POSIX permissions.
  }
}

export async function secureWriteFile(filePath, data) {
  await ensureSecureDir(path.dirname(filePath));
  await writeFile(filePath, data, { mode: 0o600 });
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Best effort; see ensureSecureDir.
  }
}

export function parsePorts(value) {
  const ports = asArray(value)
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => Number(entry.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return [...new Set(ports)];
}

export function normalizeRemote(remote) {
  const name = String(remote?.name ?? "").trim();
  if (!name) {
    throw new Error("Remote entries must include a non-empty name.");
  }

  return {
    name,
    command: String(remote?.command ?? name).trim() || name,
    required: Boolean(remote?.required),
    statusCommand: String(remote?.statusCommand ?? "").trim(),
    startCommand: String(remote?.startCommand ?? "").trim()
  };
}

export function normalizeConfig(input = {}) {
  const defaults = createDefaultConfig();
  const remotesByName = new Map(
    defaults.remotes.map((remote) => [remote.name, { ...remote }])
  );

  for (const remote of Array.isArray(input.remotes) ? input.remotes : []) {
    const normalized = normalizeRemote(remote);
    remotesByName.set(normalized.name, {
      ...(remotesByName.get(normalized.name) ?? {}),
      ...normalized
    });
  }

  const minimumBatteryPercent = Number(
    input.power?.minimumBatteryPercent ?? defaults.power.minimumBatteryPercent
  );
  const watchIntervalSeconds = Number(
    input.watch?.intervalSeconds ?? defaults.watch.intervalSeconds
  );

  return {
    version: Number(input.version ?? defaults.version),
    hotspot: {
      ssid: String(input.hotspot?.ssid ?? defaults.hotspot.ssid).trim(),
      strict: input.hotspot?.strict ?? defaults.hotspot.strict,
      allowRedactedSsid: Boolean(input.hotspot?.allowRedactedSsid ?? defaults.hotspot.allowRedactedSsid)
    },
    power: {
      minimumBatteryPercent: Number.isFinite(minimumBatteryPercent)
        ? minimumBatteryPercent
        : defaults.power.minimumBatteryPercent,
      lidClosed: Boolean(input.power?.lidClosed ?? defaults.power.lidClosed),
      warnBatteryPercent: toPercentOrNull(input.power?.warnBatteryPercent),
      floorBatteryPercent: toPercentOrNull(input.power?.floorBatteryPercent)
    },
    watch: {
      enabled: Boolean(input.watch?.enabled ?? defaults.watch.enabled),
      intervalSeconds: Number.isFinite(watchIntervalSeconds) && watchIntervalSeconds > 0
        ? watchIntervalSeconds
        : defaults.watch.intervalSeconds
    },
    notify: {
      url: String(input.notify?.url ?? defaults.notify.url).trim()
    },
    tailnet: {
      required: Boolean(input.tailnet?.required ?? defaults.tailnet.required)
    },
    expose: {
      ports: parsePorts(input.expose?.ports ?? defaults.expose.ports)
    },
    remotes: [...remotesByName.values()].map(normalizeRemote)
  };
}

export function applyOptionOverrides(config, options = {}) {
  const next = normalizeConfig(config);

  if (typeof options.hotspot === "string" && options.hotspot.trim()) {
    next.hotspot.ssid = options.hotspot.trim();
    next.hotspot.strict = true;
  }

  if (options["no-strict-network"]) {
    next.hotspot.strict = false;
  }

  if (options["allow-redacted-ssid"]) {
    next.hotspot.allowRedactedSsid = true;
  }

  if (options["minimum-battery"] !== undefined) {
    const value = Number(options["minimum-battery"]);
    if (Number.isFinite(value)) {
      next.power.minimumBatteryPercent = value;
    }
  }

  if (options["lid-closed"] || options.lid) {
    next.power.lidClosed = true;
  }

  if (options["warn-battery"] !== undefined) {
    const value = Number(options["warn-battery"]);
    if (Number.isFinite(value)) {
      next.power.warnBatteryPercent = value;
    }
  }

  if (options["sleep-battery"] !== undefined) {
    const value = Number(options["sleep-battery"]);
    if (Number.isFinite(value)) {
      next.power.floorBatteryPercent = value;
    }
  }

  if (options.watch) {
    next.watch.enabled = true;
  }

  if (options["watch-interval"] !== undefined) {
    const value = Number(options["watch-interval"]);
    if (Number.isFinite(value) && value > 0) {
      next.watch.intervalSeconds = value;
    }
  }

  if (typeof options["notify-url"] === "string" && options["notify-url"].trim()) {
    next.notify.url = options["notify-url"].trim();
  }

  if (options["require-tailnet"]) {
    next.tailnet.required = true;
  }

  const requestedPorts = parsePorts(options.expose);
  if (requestedPorts.length > 0) {
    next.expose.ports = [...new Set([...next.expose.ports, ...requestedPorts])];
  }

  const requestedRemotes = asArray(options.remote);
  if (requestedRemotes.length > 0) {
    const byName = new Map(next.remotes.map((remote) => [remote.name, remote]));
    for (const name of requestedRemotes.map((value) => String(value).trim()).filter(Boolean)) {
      const existing = byName.get(name) ?? {
        name,
        command: name,
        required: false,
        statusCommand: "",
        startCommand: ""
      };
      existing.required = true;
      byName.set(name, existing);
    }
    next.remotes = [...byName.values()].map(normalizeRemote);
  }

  return next;
}

export async function loadConfig(configPath = defaultConfigPath()) {
  if (!(await fileExists(configPath))) {
    return {
      config: createDefaultConfig(),
      configPath,
      loaded: false
    };
  }

  const raw = await readFile(configPath, "utf8");
  return {
    config: normalizeConfig(JSON.parse(raw)),
    configPath,
    loaded: true
  };
}

export async function writeConfig(config, configPath = defaultConfigPath(), { force = false } = {}) {
  if (!force && (await fileExists(configPath))) {
    throw new Error(`Config already exists at ${configPath}. Use --force to replace it.`);
  }

  const normalized = normalizeConfig(config);
  await secureWriteFile(configPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function sampleConfig({ hotspot = "" } = {}) {
  const config = createDefaultConfig();
  config.hotspot.ssid = hotspot;
  config.remotes = [
    {
      name: "codex",
      command: "codex",
      required: false,
      statusCommand: "pgrep -f 'codex remote-control'",
      startCommand: "codex remote-control"
    },
    {
      name: "claude",
      command: "claude",
      required: false,
      statusCommand: "pgrep -f 'claude remote-control'",
      startCommand: "claude remote-control"
    },
    {
      name: "agy",
      command: "agy",
      required: false,
      statusCommand: "",
      startCommand: ""
    },
    {
      name: "grok",
      command: "grok",
      required: false,
      statusCommand: "",
      startCommand: ""
    }
  ];
  return normalizeConfig(config);
}

function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// Battery thresholds are opt-in: null/absent means "not monitored". Any other
// finite number in 0..100 is honored; junk falls back to null (off).
function toPercentOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number));
}
