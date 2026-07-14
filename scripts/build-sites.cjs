const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const files = [
  { path: "/", source: "index.html", type: "text/html; charset=utf-8" },
  { path: "/index.html", source: "index.html", type: "text/html; charset=utf-8" },
  { path: "/styles.css", source: "styles.css", type: "text/css; charset=utf-8" },
  { path: "/review-engine.js", source: "review-engine.js", type: "application/javascript; charset=utf-8" },
  { path: "/app.js", source: "app.js", type: "application/javascript; charset=utf-8" },
];

const assets = {};
for (const file of files) {
  assets[file.path] = {
    type: file.type,
    body: fs.readFileSync(path.join(root, file.source), "utf8"),
  };
}

const server = `const assets = ${JSON.stringify(assets)};

function normalizedPath(request) {
  const url = new URL(request.url);
  const path = decodeURIComponent(url.pathname || "/");
  if (path === "" || path === "/") return "/";
  return path;
}

function responseFor(path) {
  const asset = assets[path] || assets[path.replace(/\\?.*$/, "")];
  if (!asset) return null;
  return new Response(asset.body, {
    headers: {
      "content-type": asset.type,
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request) {
    const path = normalizedPath(request);
    return responseFor(path) || responseFor("/index.html");
  },
};
`;

fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
fs.mkdirSync(path.join(root, "dist/.openai"), { recursive: true });
fs.writeFileSync(path.join(root, "dist/server/index.js"), server);
fs.copyFileSync(path.join(root, ".openai/hosting.json"), path.join(root, "dist/.openai/hosting.json"));
