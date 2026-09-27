import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AgentAction } from "./action.js";
import { summarize } from "./action.js";
import { loadConfig } from "./config.js";
import { evaluate } from "./reflex.js";
import { c } from "./ui.js";

/**
 * Local dashboard + HTTP API. Any agent or ADE can call POST /v1/check with an AgentAction;
 * GET /events streams every decision (from any adapter) via Server-Sent Events, tailing the JSONL log.
 */
export function serve(port: number, root: string) {
  const cfg = loadConfig();
  const logFile = cfg.logFile || path.join(process.cwd(), ".agent-reflex-decisions.jsonl");
  if (!cfg.logFile) cfg.logFile = logFile;
  const clients = new Set<http.ServerResponse>();

  // Tail the log so hook processes (separate PIDs) show up live.
  let offset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  let pending = "";
  setInterval(() => {
    if (!fs.existsSync(logFile)) return;
    const size = fs.statSync(logFile).size;
    if (size < offset) offset = 0;
    if (size === offset) return;
    const fd = fs.openSync(logFile, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const chunk = pending + buf.toString("utf8");
    const lines = chunk.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) for (const res of clients) res.write(`data: ${line}\n\n`);
  }, 150);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") return res.end();

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(fs.readFileSync(path.join(root, "dashboard", "index.html")));
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const history = Number(url.searchParams.get("history") ?? 0);
      if (history && fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-history);
        for (const line of lines) if (line.trim()) res.write(`data: ${line}\n\n`);
      }
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/check") {
      try {
        const body = await readBody(req);
        const action = JSON.parse(body) as AgentAction;
        if (!action.tool || typeof action.input !== "object") throw new Error("Expected { tool, input, task?, cwd?, agent? }");
        action.agent ??= "http";
        const verdict = await evaluate(action, cfg);
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ summary: summarize(action), ...verdict }));
      } catch (err) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: (err as Error).message }));
      }
    }

    res.statusCode = 404;
    res.end("not found");
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`${c.green("●")} agent-reflex dashboard  ${c.bold(`http://localhost:${port}`)}`);
    console.log(c.gray(`  POST /v1/check  ·  GET /events (SSE)  ·  tailing ${logFile}`));
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (d) => {
      data += d;
      if (data.length > 1_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
