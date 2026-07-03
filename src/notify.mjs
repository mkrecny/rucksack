import { shellQuote } from "./platform.mjs";

export async function sendNotification(config, runner, message) {
  const url = String(config.notify?.url ?? "").trim();
  if (!url) {
    return {
      ok: false,
      skipped: true,
      detail: "No notify.url configured. Set notify.url to an ntfy.sh topic or webhook URL, or pass --notify-url."
    };
  }

  const command = [
    "curl -m 10 -sS -X POST",
    `-H ${shellQuote("Title: Rucksack")}`,
    `--data-binary ${shellQuote(message)}`,
    shellQuote(url)
  ].join(" ");

  const result = await runner.exec(command, { timeoutMs: 15000 });
  if (result.code !== 0) {
    return {
      ok: false,
      skipped: false,
      detail: (result.stderr || result.stdout || "notification request failed").trim()
    };
  }

  return { ok: true, skipped: false, detail: `Notification sent to ${url}.` };
}
