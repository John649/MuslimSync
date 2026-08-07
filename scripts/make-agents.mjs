// Writes AGENTS.md from the command registry.
//
// Generated rather than hand-written so the command table cannot drift from the
// CLI: a list of commands maintained by hand is wrong the first time a command
// changes, and nobody notices until an agent calls one that no longer exists.
// `npm run check` fails if the file on disk disagrees with this.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderAgentsMd } from "../cli/agents.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "AGENTS.md");

// repo: true adds the contributing rules, which belong to this repository and
// are never installed into someone else's project.
writeFileSync(OUT, renderAgentsMd({ repo: true }));
console.log(`wrote ${path.relative(ROOT, OUT)}`);
