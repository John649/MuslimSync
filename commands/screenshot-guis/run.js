// Worked example of a custom command.
//
// Everything it uses — `ctx.op` and the ops it calls — is the same surface the
// CLI and an agent use. Nothing here is privileged.

import { mkdirSync } from "node:fs";
import path from "node:path";

export default async function screenshotGuis({ args, ctx, log }) {
  const guis = await ctx.op("ls", { path: "StarterGui" });
  const screens = guis.children.filter((child) => child.class === "ScreenGui");

  if (screens.length === 0) {
    return { captured: 0, note: "no ScreenGuis in StarterGui" };
  }

  const out = path.resolve(args.out);
  mkdirSync(out, { recursive: true });

  const written = [];

  for (const gui of screens) {
    log(`capturing ${gui.name}`);

    // One shot per GUI. The region is the same each time for now — isolating a
    // single GUI subtree needs render-to-image, which capture does not do yet.
    const shot = await ctx.photo({
      region: args.region || undefined,
      out: path.join(out, `${gui.name}.png`),
    });

    written.push(shot.file);
  }

  return { captured: written.length, files: written };
}
