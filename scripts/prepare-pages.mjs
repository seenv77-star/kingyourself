import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("index.html", "dist/index.html");
writeFileSync("dist/_routes.json", JSON.stringify({
  version: 1,
  include: ["/api/consult", "/api/consult-attachment", "/admin/*", "/admin"],
  exclude: []
}));
