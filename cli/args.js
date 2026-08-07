// Argument parsing for `msync`.
//
// Pure: argv in, a plain object out, so every quirk below is testable without
// running a command. The quirks are deliberate — they are the ones that make a
// CLI feel wrong when they are missing.

export class UsageError extends Error {}

/**
 * Splits argv into a command, positionals, and flags.
 *
 * Supports `--flag value`, `--flag=value`, `--no-flag`, and bare `--flag` as
 * true. Everything after a lone `--` is positional, so a script body or a path
 * that starts with a dash can still be passed.
 */
export function parse(argv) {
  const positionals = [];
  const flags = {};
  let literal = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (literal) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      literal = true;
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    if (!body) throw new UsageError("`--` on its own is not a flag");

    const eq = body.indexOf("=");

    if (eq !== -1) {
      const name = body.slice(0, eq);
      // `--=value` would otherwise create a flag with an empty name, which
      // silently goes nowhere.
      if (!name) throw new UsageError(`missing a flag name in "${token}"`);
      flags[camel(name)] = body.slice(eq + 1);
      continue;
    }

    if (body.startsWith("no-")) {
      flags[camel(body.slice(3))] = false;
      continue;
    }

    const next = argv[i + 1];

    // A flag takes the next token as its value unless that token is itself a
    // flag. `--raw --path x` must not read "--path" as the value of --raw.
    if (next !== undefined && !next.startsWith("--")) {
      flags[camel(body)] = next;
      i += 1;
    } else {
      flags[camel(body)] = true;
    }
  }

  const command = positionals.shift();

  return { command, positionals, flags };
}

/** `--force-parent` and `--forceParent` both reach forceParent. */
function camel(name) {
  return name.replace(/-([a-z0-9])/gi, (_, char) => char.toUpperCase());
}

/**
 * Coerces a CLI string into the JSON value an op expects.
 *
 * Bare words stay strings, so `msync set … Material Neon` works without
 * quoting. Only things that unambiguously parse as JSON become JSON — which is
 * how tagged values like {"__type":"Vector3",…} get through.
 */
export function coerce(text) {
  if (typeof text !== "string") return text;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;

  // A number, but not a version-like or id-like string with leading zeros:
  // "007" is a name, 7 is a number.
  if (/^-?\d+(\.\d+)?$/.test(text) && !/^-?0\d/.test(text)) return Number(text);

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new UsageError(`that looks like JSON but does not parse: ${text}`);
    }
  }

  return text;
}

/**
 * Binds positionals to named op arguments.
 *
 * `required` names that must be present; `optional` names that may follow.
 * Extra positionals are an error rather than being ignored — silently dropping
 * an argument the user typed is how you get "why did nothing happen".
 */
export function bind(command, positionals, { required = [], optional = [] } = {}) {
  if (positionals.length < required.length) {
    const missing = required.slice(positionals.length).join(", ");
    throw new UsageError(`${command} needs ${missing}`);
  }

  const names = [...required, ...optional];

  if (positionals.length > names.length) {
    throw new UsageError(`${command} takes at most ${names.length} argument(s), got ${positionals.length}`);
  }

  const bound = {};
  positionals.forEach((value, index) => {
    bound[names[index]] = coerce(value);
  });

  return bound;
}
