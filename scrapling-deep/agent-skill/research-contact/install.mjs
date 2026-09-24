#!/usr/bin/env node
/**
 * install.mjs — portable installer for the research-contact skill.
 *
 * Copies this skill folder into a pi skills directory so pi discovers it.
 * Works on Windows / macOS / Linux and does not depend on where the package
 * was unpacked.
 *
 * Usage:
 *   node install.mjs                     # install into the default pi skills dir
 *   node install.mjs --dest <dir>        # install into a custom skills root
 *   node install.mjs --name <name>       # install under a different folder name
 *   node install.mjs --force             # overwrite an existing install
 *   node install.mjs --list              # show where it would install, then exit
 *
 * Default destination resolution (first match wins):
 *   1. --dest <dir>
 *   2. $PI_SKILLS_DIR
 *   3. ~/.pi/agent/skills
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_NAME_DEFAULT = "research-contact";

const SKIP = new Set(["node_modules", ".git", "package-lock.json"]);

function parseArgs(argv) {
  const out = { dest: null, name: SKILL_NAME_DEFAULT, force: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dest") out.dest = argv[++i];
    else if (a === "--name") out.name = argv[++i];
    else if (a === "--force") out.force = true;
    else if (a === "--list") out.list = true;
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

function defaultSkillsRoot() {
  if (process.env.PI_SKILLS_DIR) return resolve(process.env.PI_SKILLS_DIR);
  return join(homedir(), ".pi", "agent", "skills");
}

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (SKIP.has(entry)) continue;
    const s = join(src, entry);
    const d = join(dst, entry);
    const st = statSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else cpSync(s, d);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      [
        "research-contact installer",
        "",
        "  node install.mjs [--dest <skills-root>] [--name <folder>] [--force] [--list]",
        "",
        "  --dest   pi skills root (default: $PI_SKILLS_DIR or ~/.pi/agent/skills)",
        "  --name   destination folder name (default: research-contact)",
        "  --force  overwrite an existing install",
        "  --list   print the resolved destination and exit",
      ].join("\n"),
    );
    return;
  }

  const root = args.dest ? resolve(args.dest) : defaultSkillsRoot();
  const dest = join(root, args.name);

  console.log(`source      : ${HERE}`);
  console.log(`skills root : ${root}`);
  console.log(`destination : ${dest}`);

  if (args.list) return;

  if (existsSync(dest)) {
    if (!args.force) {
      console.error(
        `\n✗ ${dest} already exists. Re-run with --force to overwrite.`,
      );
      process.exit(1);
    }
    console.log("removing existing install (--force)…");
    rmSync(dest, { recursive: true, force: true });
  }

  console.log("copying…");
  copyTree(HERE, dest);

  console.log(`\n✓ Installed research-contact → ${dest}`);
  console.log("\nNext steps:");
  console.log("  • Verify pi sees it:   pi --print --no-session \"name the research-contact files\"");
  console.log("  • Optional LinkedIn:   node " + join(dest, "scripts", "linkedin.mjs") + " status");
}

main();