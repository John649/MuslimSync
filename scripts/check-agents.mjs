// Fails if AGENTS.md is out of date with the command registry.
//
// The same idea as the file-size gate: the generated file is committed so a
// reader (and an agent that only has the repo) sees it without running
// anything, and this makes sure the committed copy is the real one.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderAgentsMd } from "../cli/agents.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(ROOT, "AGENTS.md");

let current = "";
try {
  current = readFileSync(file, "utf8");
} catch {
  console.error("AGENTS.md is missing. Run: npm run gen:agents");
  process.exit(1);
}

if (current !== renderAgentsMd({ repo: true })) {
  console.error("AGENTS.md is out of date with the command registry. Run: npm run gen:agents");
  process.exit(1);
}

console.log("AGENTS.md: up to date");
