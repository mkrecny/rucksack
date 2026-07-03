import { connectHotspot, getCurrentWifiSsid, getWifiDevice } from "./checks.mjs";
import { readSession, writeSession } from "./session.mjs";

export async function watchTick({ runner, config, statePath }) {
  const session = await readSession(statePath);
  if (!session) {
    return { done: true, reason: "session-removed", ok: false, events: [] };
  }

  const events = [];

  if (session.pid && typeof runner.isProcessAlive === "function" && !runner.isProcessAlive(Number(session.pid))) {
    const child = runner.spawnDetached("caffeinate", ["-dimsu"]);
    session.pid = child.pid;
    await writeSession(session, statePath);
    events.push(`caffeinate was not running; restarted it with PID ${child.pid}`);
  }

  const expectedSsid = String(config.hotspot?.ssid ?? "").trim();
  const wifi = await getWifiDevice(runner);
  if (!wifi.ok) {
    events.push(`Wi-Fi device unavailable: ${wifi.detail}`);
    return { done: false, ok: false, events };
  }

  const current = await getCurrentWifiSsid(runner, wifi.device);

  if (!expectedSsid) {
    const linkUp = Boolean(current.ok && current.connected);
    if (!linkUp) events.push("Wi-Fi link is down and no hotspot SSID is configured to rejoin.");
    return { done: false, ok: linkUp, events };
  }

  const onExpected = current.ok && (
    current.ssid === expectedSsid ||
    (current.connected && current.redacted && Boolean(config.hotspot?.allowRedactedSsid))
  );

  if (onExpected) {
    return { done: false, ok: true, events };
  }

  events.push(
    current.ok && current.connected
      ? `Wi-Fi is on ${current.ssid || "an unverifiable network"} instead of ${expectedSsid}; attempting rejoin.`
      : `Wi-Fi link is down; attempting to rejoin ${expectedSsid}.`
  );

  const rejoined = await connectHotspot(config, runner, {});
  events.push(rejoined.ok ? `Rejoin: ${rejoined.detail}` : `Rejoin failed: ${rejoined.detail}`);
  return { done: false, ok: rejoined.ok, events };
}

export async function runWatchLoop({
  runner,
  config,
  statePath,
  log = () => {},
  notify = null,
  intervalMs = 20000,
  maxTicks = Infinity,
  delay = defaultDelay
}) {
  let ticks = 0;
  let lastOk = null;

  log(`Watch started (checking every ${Math.round(intervalMs / 1000)}s).`);

  while (true) {
    let tick;
    try {
      tick = await watchTick({ runner, config, statePath });
    } catch (error) {
      log(`Watch tick failed: ${error.message}`);
      tick = { done: false, ok: false, events: [] };
    }

    if (tick.done) {
      log("Session state removed; watch exiting.");
      return { ticks, reason: tick.reason ?? "done" };
    }

    for (const event of tick.events) {
      log(event);
    }
    const restartEvent = tick.events.find((event) => event.includes("caffeinate"));
    if (tick.ok && restartEvent) {
      await safeNotify(notify, log, `Rucksack: ${restartEvent}`);
    }
    if (tick.ok !== lastOk) {
      log(tick.ok ? "Link OK." : "Link NOT OK.");
      if (!tick.ok) {
        await safeNotify(notify, log, `Rucksack: connection trouble. ${tick.events.join(" ") || "The link is not OK."}`);
      } else if (lastOk === false) {
        await safeNotify(notify, log, "Rucksack: link restored.");
      }
      lastOk = tick.ok;
    }

    ticks += 1;
    if (ticks >= maxTicks) {
      return { ticks, reason: "max-ticks" };
    }

    await delay(intervalMs);
  }
}

async function safeNotify(notify, log, message) {
  if (typeof notify !== "function") return;
  try {
    const sent = await notify(message);
    if (sent && sent.ok === false && !sent.skipped) {
      log(`Notification failed: ${sent.detail}`);
    }
  } catch (error) {
    log(`Notification failed: ${error.message}`);
  }
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
