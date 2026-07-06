// --expose: make a dev-server port tappable from the phone that hosts the hotspot.
//
// The phone and the laptop share the hotspot's tiny LAN, so "localhost:3000 on
// the phone" is really http://<laptop-hotspot-ip>:3000 (or <name>.local). This
// module finds those endpoints, checks that the port is actually reachable
// (listening, and not bound to loopback only), and flags the macOS firewall
// trap: with the lid closed, nobody can click the Allow dialog that the first
// inbound connection may pop.

import { runnerHostKind, shellQuote } from "./platform.mjs";
import { CHECK_STATUS, getWifiDevice } from "./checks.mjs";

export const FIREWALL_COMMAND = "/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate";

export function parseLsofListenAddresses(raw) {
  const addresses = [];
  for (const line of String(raw ?? "").split("\n")) {
    const match = line.match(/TCP\s+(\S+)\s+\(LISTEN\)/i);
    if (match) addresses.push(match[1]);
  }
  return [...new Set(addresses)];
}

export function parseSsListenAddresses(raw, port) {
  const addresses = [];
  for (const line of String(raw ?? "").split("\n")) {
    if (!/^\s*LISTEN\b/i.test(line)) continue;
    const columns = line.trim().split(/\s+/);
    const local = columns[3] ?? "";
    if (new RegExp(`:${port}$`).test(local)) addresses.push(local);
  }
  return [...new Set(addresses)];
}

export function classifyListenAddresses(addresses) {
  const isLoopback = (address) => {
    const host = address.slice(0, address.lastIndexOf(":"));
    return host === "localhost" || host === "[::1]" || host.startsWith("127.");
  };

  return {
    listening: addresses.length > 0,
    loopbackOnly: addresses.length > 0 && addresses.every(isLoopback)
  };
}

export function parseFirewallState(raw) {
  const match = String(raw ?? "").match(/State\s*=\s*(\d)/);
  return match ? Number(match[1]) : null;
}

export async function getPhoneEndpoints(runner) {
  let ip = "";
  let device = "";
  const wifi = await getWifiDevice(runner);
  if (wifi.ok) {
    device = wifi.device;
    const address = await runner.exec(`ipconfig getifaddr ${shellQuote(wifi.device)}`);
    if (address.code === 0) ip = address.stdout.trim();
  }

  let host = "";
  const scutil = await runner.exec("scutil --get LocalHostName");
  if (scutil.code === 0) host = scutil.stdout.trim();

  return { ip, host, device };
}

export function phoneUrlsForPort(endpoints, port) {
  const urls = [];
  if (endpoints.ip) urls.push(`http://${endpoints.ip}:${port}`);
  if (endpoints.host) urls.push(`http://${endpoints.host}.local:${port}`);
  return urls;
}

export async function checkFirewall(config, runner) {
  const result = await runner.exec(FIREWALL_COMMAND, { timeoutMs: 10000 });
  if (result.code !== 0) {
    return check("firewall", "Firewall", CHECK_STATUS.WARN, `Could not read the macOS firewall state${failureDetail(result)}`);
  }

  const state = parseFirewallState(result.stdout);
  if (state === 0) {
    return check("firewall", "Firewall", CHECK_STATUS.PASS, "The macOS application firewall is off; exposed ports won't hit an Allow dialog.");
  }
  if (state === 1) {
    return check(
      "firewall",
      "Firewall",
      CHECK_STATUS.WARN,
      "The macOS application firewall is on: the first inbound connection to a new dev server can pop an Allow dialog nobody can click with the lid closed. Open the phone URL once before you zip, or pre-allow the binary in System Settings → Network → Firewall."
    );
  }
  if (state === 2) {
    return check(
      "firewall",
      "Firewall",
      CHECK_STATUS.FAIL,
      "The macOS firewall is set to block ALL incoming connections, so your phone cannot reach exposed ports. Turn block-all off, or drop --expose."
    );
  }

  return check("firewall", "Firewall", CHECK_STATUS.WARN, "Could not parse the macOS firewall state.");
}

export async function checkExposedPorts(config, runner, ports) {
  if (runnerHostKind(runner) === "wsl") {
    return checkExposedPortsWsl(config, runner, ports);
  }

  const endpoints = await getPhoneEndpoints(runner);
  const checks = [];

  for (const port of ports) {
    const result = await runner.exec(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { timeoutMs: 10000 });
    const addresses = result.code === 0 ? parseLsofListenAddresses(result.stdout) : [];
    const { listening, loopbackOnly } = classifyListenAddresses(addresses);
    const urls = phoneUrlsForPort(endpoints, port);
    const urlText = urls.length > 0 ? urls.join(" · ") : "(phone URL unavailable — not on Wi-Fi?)";

    if (!listening) {
      checks.push(check(
        `expose:${port}`,
        `Expose: ${port}`,
        CHECK_STATUS.WARN,
        `Nothing is listening on port ${port} yet. When the dev server starts, bind 0.0.0.0 so the phone can reach ${urlText}.`
      ));
    } else if (loopbackOnly) {
      checks.push(check(
        `expose:${port}`,
        `Expose: ${port}`,
        CHECK_STATUS.WARN,
        `Port ${port} is bound to loopback only (${addresses.join(", ")}) — your phone won't reach it. Restart the dev server with --host 0.0.0.0 (or its equivalent).`
      ));
    } else {
      checks.push(check(
        `expose:${port}`,
        `Expose: ${port}`,
        CHECK_STATUS.PASS,
        `Port ${port} is listening on ${addresses.join(", ")}. Phone URLs: ${urlText}`
      ));
    }
  }

  return checks;
}

async function checkExposedPortsWsl(config, runner, ports) {
  const listeners = await runner.exec("ss -ltn", { timeoutMs: 10000 });
  const mode = await wslNetworkingMode(runner);
  const checks = [];

  for (const port of ports) {
    const addresses = listeners.code === 0 ? parseSsListenAddresses(listeners.stdout, port) : [];
    const { listening, loopbackOnly } = classifyListenAddresses(addresses);

    if (!listening) {
      checks.push(check(
        `expose:${port}`,
        `Expose: ${port}`,
        CHECK_STATUS.WARN,
        `Nothing is listening on port ${port} inside WSL yet.`
      ));
    } else if (loopbackOnly) {
      checks.push(check(
        `expose:${port}`,
        `Expose: ${port}`,
        CHECK_STATUS.WARN,
        `Port ${port} is bound to loopback only (${addresses.join(", ")}) — your phone won't reach it. Restart the dev server with --host 0.0.0.0 (or its equivalent).`
      ));
    } else if (mode === "mirrored") {
      checks.push(check(
        `expose:${port}`,
        `Expose: ${port}`,
        CHECK_STATUS.PASS,
        `Port ${port} is listening on ${addresses.join(", ")}; WSL mirrored networking should carry the Windows Wi-Fi IP to your phone.`
      ));
    } else {
      checks.push(check(
        `expose:${port}`,
        `Expose: ${port}`,
        CHECK_STATUS.WARN,
        `Port ${port} is listening on ${addresses.join(", ")}, but WSL NAT networking hides it from the hotspot. Enable mirrored networking (networkingMode=mirrored in .wslconfig) or add a netsh portproxy on the Windows side.`
      ));
    }
  }

  return checks;
}

async function wslNetworkingMode(runner) {
  const result = await runner.exec("wslinfo --networking-mode", { timeoutMs: 10000 });
  return result.code === 0 ? result.stdout.trim().toLowerCase() : "nat";
}

export async function buildExposeReport(config, runner, ports) {
  if (runnerHostKind(runner) === "wsl") {
    return {
      entries: [],
      lines: [
        `--expose on Windows/WSL: phone reachability depends on WSL networking (mirrored vs NAT). Run rucksack doctor --expose ${ports.join(",")} for the verdict.`
      ],
      notifyMessage: ""
    };
  }

  const endpoints = await getPhoneEndpoints(runner);
  const entries = ports.map((port) => ({ port, urls: phoneUrlsForPort(endpoints, port) }));
  const lines = entries.map(({ port, urls }) =>
    `Phone URL for ${port}: ${urls.length > 0 ? urls.join(" · ") : "(unavailable — not on Wi-Fi?)"}`
  );

  const withUrls = entries.filter((entry) => entry.urls.length > 0);
  const notifyMessage = withUrls.length > 0
    ? `Rucksack packed. Dev URLs: ${withUrls.map((entry) => `${entry.port} → ${entry.urls.join(" ")}`).join(" | ")}`
    : "";

  return { entries, lines, notifyMessage };
}

function check(id, label, status, detail) {
  return { id, label, status, detail };
}

function failureDetail(result) {
  const message = (result.stderr || result.stdout || "").trim();
  return message ? `: ${message}` : ".";
}
