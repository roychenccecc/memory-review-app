import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 4173);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const CALENDAR_PATH = path.join(DATA_DIR, "calendar.ics");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ics": "text/calendar; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CALENDAR_PATH)) {
  fs.writeFileSync(CALENDAR_PATH, emptyCalendar(), "utf8");
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "POST" && url.pathname === "/api/calendar") {
      const body = await readBody(request, 5 * 1024 * 1024);
      if (!body.includes("BEGIN:VCALENDAR") || !body.includes("END:VCALENDAR")) {
        send(response, 400, "Invalid ICS calendar content", "text/plain; charset=utf-8");
        return;
      }
      fs.writeFileSync(CALENDAR_PATH, body, "utf8");
      sendJson(response, {
        ok: true,
        calendarPath: "/calendar.ics",
        eventCount: (body.match(/BEGIN:VEVENT/g) || []).length,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/calendar.ics") {
      send(response, 200, request.method === "HEAD" ? "" : fs.readFileSync(CALENDAR_PATH), MIME[".ics"]);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "Method Not Allowed", "text/plain; charset=utf-8");
      return;
    }

    const filePath = resolveStaticPath(url.pathname);
    if (!filePath) {
      send(response, 404, "Not Found", "text/plain; charset=utf-8");
      return;
    }

    const content = request.method === "HEAD" ? "" : fs.readFileSync(filePath);
    send(response, 200, content, MIME[path.extname(filePath)] || "application/octet-stream");
  } catch (error) {
    send(response, 500, error.stack || String(error), "text/plain; charset=utf-8");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`复习管理器已启动: http://127.0.0.1:${PORT}/`);
  console.log(`苹果日历订阅地址: http://127.0.0.1:${PORT}/calendar.ics`);
});

function resolveStaticPath(pathname) {
  let cleanPath = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (cleanPath === "memory-review-app") cleanPath = "";
  if (cleanPath.startsWith("memory-review-app/")) {
    cleanPath = cleanPath.slice("memory-review-app/".length);
  }
  const relative = cleanPath === "" ? "index.html" : cleanPath;
  const fullPath = path.join(ROOT, relative);
  const normalizedRoot = `${path.resolve(ROOT)}${path.sep}`;
  const normalizedPath = path.resolve(fullPath);
  if (!normalizedPath.startsWith(normalizedRoot)) return null;
  if (!fs.existsSync(normalizedPath)) return null;
  const stat = fs.statSync(normalizedPath);
  if (stat.isDirectory()) return path.join(normalizedPath, "index.html");
  return normalizedPath;
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response, data) {
  send(response, 200, JSON.stringify(data), MIME[".json"]);
}

function send(response, status, content, contentType) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "http://127.0.0.1:4173",
  });
  response.end(content);
}

function emptyCalendar() {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Memory Review//Local App//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:复习提醒",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
