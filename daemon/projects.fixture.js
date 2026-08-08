// The scratch directory the projects tests build in.
//
// Shared because projects.test.js outgrew the line cap and split in two, and
// both halves need the same thing: a real directory on disk, thrown away at the
// end. `freshRoot` is called from beforeEach so each test gets its own, and
// every root ever handed out is registered for `cleanupRoots`.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const created = [];

/** A directory with a project file in it. Extra keys are merged into the file. */
export function makeProject(directory, project = {}) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "default.project.json"),
    JSON.stringify({ name: path.basename(directory), tree: { $className: "DataModel" }, ...project }, null, 2),
  );
  return directory;
}

/** A new temp root, resolved through any symlink so path comparisons hold. */
export function freshRoot() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "msync-projects-")));
  created.push(root);
  return root;
}

export function cleanupRoots() {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
  created.length = 0;
}
