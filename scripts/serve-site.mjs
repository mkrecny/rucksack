#!/usr/bin/env node

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "site");
const port = Number(readOption("--port") ?? process.env.PORT ?? 4175);

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".sh": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml"
};

// Pretty routes: `curl rucksack.sh/install | bash`
const rewrites = {
  "/install": "/install.sh"
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const safePath = path
    .normalize(rewrites[url.pathname] ?? decodeURIComponent(url.pathname))
    .replace(/^(\.\.[/\\])+/, "");
  const requested = path.join(root, safePath === "/" ? "index.html" : safePath);

  if (!requested.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const info = await stat(requested);
    const filePath = info.isDirectory() ? path.join(requested, "index.html") : requested;
    response.writeHead(200, {
      "content-type": types[path.extname(filePath)] ?? "application/octet-stream"
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Rucksack site running at http://127.0.0.1:${port}`);
});

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
