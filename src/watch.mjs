import { connectHotspot, getCurrentWifiSsid, getWifiDevice, parseBattery, parseThermalPressure } from "./checks.mjs";
import { readSession, releaseLidClosed, writeSession } from "./session.mjs";

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

  // Battery and thermal safety run every tick, before the network checks, so the
  // safety floor can act even when the link is down. These flags ride on every
  // return path below so the loop can notify once per transition.
  const safety = await checkPowerSafety({ runner, config, session, statePath, events });

  const expectedSsid = String(config.hotspot?.ssid ?? "").trim();
  const wifi = await getWifiDevice(runner);
  if (!wifi.ok) {
    events.push(`Wi-Fi device unavailable: ${wifi.detail}`);
    return { done: false, ok: false, events, ...safety };
  }

  const current = await getCurrentWifiSsid(runner, wifi.device);

  if (!expectedSsid) {
    const linkUp = Boolean(current.ok && current.connected);
    if (!linkUp) events.push("Wi-Fi link is down and no hotspot SSID is configured to rejoin.");
    return { done: false, ok: linkUp, events, ...safety };
  }

  const onExpected = current.ok && (
    current.ssid === expectedSsid ||
    (current.connected && current.redacted && Boolean(config.hotspot?.allowRedactedSsid))
  );

  if (onExpected) {
    return { done: false, ok: true, events, ...safety };
  }

  events.push(
    current.ok && current.connected
      ? `Wi-Fi is on ${current.ssid || "an unverifiable network"} instead of ${expectedSsid}; attempting rejoin.`
      : `Wi-Fi link is down; attempting to rejoin ${expectedSsid}.`
  );

  const rejoined = await connectHotspot(config, runner, {});
  events.push(rejoined.ok ? `Rejoin: ${rejoined.detail}` : `Rejoin failed: ${rejoined.detail}`);
  return { done: false, ok: rejoined.ok, events, ...safety };
}

// Continuous battery + thermal monitoring for a sealed laptop. Battery thresholds
// are opt-in (--warn-battery / --sleep-battery). Thermal pressure is always read;
// in lid-closed mode, throttling is a fail-safe that restores normal sleep.
async function checkPowerSafety({ runner, config, session, statePath, events }) {
  const warnAt = numOrNull(config.power?.warnBatteryPercent);
  const floorAt = numOrNull(config.power?.floorBatteryPercent);
  const safetyAlreadyReleased = Boolean(session.safetyRelease?.ok || session.floorReleased?.ok);

  let batteryWarn = false;
  let floorTripped = false;

  if (!safetyAlreadyReleased && (warnAt !== null || floorAt !== null)) {
    const result = await runner.exec("pmset -g batt");
    const battery = result.code === 0 ? parseBattery(result.stdout) : null;
    if (battery) {
      const onBattery = !/AC Power/i.test(battery.source);
      if (onBattery && floorAt !== null && battery.percent <= floorAt) {
        if (session.lidClosed) {
          const released = await releaseLidClosed({ runner, session, statePath, reason: "battery-floor" });
          floorTripped = released.ok;
          batteryWarn = !released.ok;
          events.push(
            released.ok
              ? `Battery ${battery.percent}% reached the ${floorAt}% floor; restored normal sleep (disablesleep ${released.to}) so the Mac can sleep instead of dying.`
              : `Battery ${battery.percent}% reached the ${floorAt}% floor, but restoring normal sleep failed: ${released.detail} Run "rucksack recover".`
          );
        } else {
          batteryWarn = true;
          events.push(`Battery is ${battery.percent}% (at or under the ${floorAt}% floor).`);
        }
      } else if (onBattery && warnAt !== null && battery.percent <= warnAt) {
        batteryWarn = true;
        events.push(`Battery is ${battery.percent}% and falling.`);
      }
    }
  }

  let thermalThrottled = false;
  let thermalTripped = false;
  const therm = await runner.exec("pmset -g therm");
  if (therm.code === 0) {
    const thermal = parseThermalPressure(therm.stdout);
    if (thermal.throttled) {
      thermalThrottled = true;
      if (session.lidClosed && !safetyAlreadyReleased) {
        const released = await releaseLidClosed({ runner, session, statePath, reason: "thermal-pressure" });
        thermalTripped = released.ok;
        events.push(
          released.ok
            ? `Thermal pressure: the CPU is throttled to ${thermal.speedLimit}% inside the bag; restored normal sleep (disablesleep ${released.to}) so the Mac can sleep.`
            : `Thermal pressure: the CPU is throttled to ${thermal.speedLimit}% inside the bag, but restoring normal sleep failed: ${released.detail} Run "rucksack recover".`
        );
      } else {
        events.push(`Thermal pressure: the CPU is throttled to ${thermal.speedLimit}% inside the bag. Check ventilation before the next run.`);
      }
    }
  }

  return { batteryWarn, floorTripped, thermalThrottled, thermalTripped };
}

function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  let lastBatteryWarn = false;
  let lastThermal = false;
  let floorNotified = false;
  let thermalTripNotified = false;

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

    // Safety-floor and low-battery/thermal alerts fire once per transition, not
    // every tick, and independently of link state.
    if (tick.floorTripped && !floorNotified) {
      floorNotified = true;
      const floorEvent = tick.events.find((event) => event.includes("floor"));
      await safeNotify(notify, log, `Rucksack: ${floorEvent ?? "safety floor reached; restored normal sleep behaviour."}`);
    }
    if (tick.batteryWarn && !lastBatteryWarn) {
      const warnEvent = tick.events.find((event) => event.toLowerCase().includes("battery"));
      await safeNotify(notify, log, `Rucksack: ${warnEvent ?? "battery is low and falling."}`);
    }
    lastBatteryWarn = Boolean(tick.batteryWarn);
    if (tick.thermalTripped && !thermalTripNotified) {
      thermalTripNotified = true;
      const thermalEvent = tick.events.find((event) => event.includes("Thermal"));
      await safeNotify(notify, log, `Rucksack: ${thermalEvent ?? "thermal safety tripped; restored normal sleep behaviour."}`);
    } else if (tick.thermalThrottled && !lastThermal) {
      const thermalEvent = tick.events.find((event) => event.includes("Thermal"));
      await safeNotify(notify, log, `Rucksack: ${thermalEvent ?? "thermal pressure detected inside the bag."}`);
    }
    lastThermal = Boolean(tick.thermalThrottled);
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
