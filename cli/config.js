// Per-project configuration.
//
// A project decides which commands exist in it. Disabling one does not just
// refuse it at the call — it removes it from `msync help`, from the registry an
// agent reads, and from the generated AGENTS.md. An agent cannot misuse a tool
// it was never told about, which is a stronger guarantee than a warning.
//
// Looked up from the working directory upward, so it applies to whatever
// project you are standing in without anything having to be passed.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const FILE = path.join(".muslimsync", "config.json");

export class ConfigError extends Error {}

/**
 * Finds the nearest config, walking up from `from`.
 *
 * Stops at the filesystem root. Returns null when there is none, which is the
 * ordinary case and not a problem.
 */
export function findConfig(from = process.cwd()) {
  let directory = path.resolve(from);

  for (;;) {
    const candidate = path.join(directory, FILE);
    if (existsSync(candidate)) return candidate;

    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Reads a project's config.
 *
 * A malformed config is an error rather than a shrug: silently ignoring it
 * would mean a project that meant to disable `eval` quietly allows it.
 */
export function readConfig(from = process.cwd()) {
  const file = findConfig(from);
  if (!file) return { file: null, disable: [], only: null };

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new ConfigError(`${file} is not valid JSON (${cause.message})`);
  }

  const commands = raw.commands ?? {};
  const disable = commands.disable ?? [];
  const only = commands.only ?? null;

  if (!Array.isArray(disable)) throw new ConfigError(`${file}: commands.disable must be an array`);
  if (only !== null && !Array.isArray(only)) throw new ConfigError(`${file}: commands.only must be an array`);

  if (only && disable.length) {
    // Both together is ambiguous — does `only` win, or does `disable` subtract
    // from it? Rather than pick, say so.
    throw new ConfigError(`${file}: use commands.only or commands.disable, not both`);
  }

  return { file, disable: disable.map(String), only: only?.map(String) ?? null };
}

/**
 * Whether a command is available here.
 *
 * `only` is an allowlist; `disable` is a blocklist. Commands that would leave
 * you unable to ask what happened are never removed — a project that disabled
 * `help` and `doctor` would be one nobody could debug.
 */
const ALWAYS = new Set(["help", "doctor", "commands", "status"]);

export function isEnabled(name, config) {
  if (ALWAYS.has(name)) return true;
  if (config.only) return config.only.includes(name);

  return !config.disable.includes(name);
}

/** The reason a command is unavailable, for an error worth reading. */
export function whyDisabled(name, config) {
  const where = config.file ?? "the project config";

  return config.only
    ? `${name} is not in commands.only (${where})`
    : `${name} is disabled in ${where}`;
}
