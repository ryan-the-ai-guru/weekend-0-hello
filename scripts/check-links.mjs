#!/usr/bin/env node
/**
 * Verifies that every root-relative href/src in the site resolves to a file
 * that exists, and that every in-page #anchor has a matching id.
 *
 * Run: node scripts/check-links.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".aws-sam"]);

function htmlFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...htmlFiles(full));
    } else if (entry.endsWith(".html")) {
      found.push(full);
    }
  }
  return found;
}

const pages = htmlFiles(root);
const failures = [];

for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const relative = page.slice(root.length + 1);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const target = match[1];

    // External, protocol-relative, inline data and mail links are out of scope.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;

    if (target.startsWith("#")) {
      const anchor = target.slice(1);
      if (anchor && !ids.has(anchor)) {
        failures.push(`${relative}: anchor ${target} has no matching id`);
      }
      continue;
    }

    if (!target.startsWith("/")) {
      failures.push(`${relative}: ${target} is not root-relative`);
      continue;
    }

    const [beforeFragment, fragment] = target.split("#");
    const pathPart = beforeFragment.split("?")[0];
    const onDisk = join(root, pathPart === "/" ? "/index.html" : pathPart);

    if (!existsSync(onDisk)) {
      failures.push(`${relative}: ${target} -> missing ${pathPart}`);
      continue;
    }

    if (fragment) {
      const targetHtml = readFileSync(onDisk, "utf8");
      const targetIds = new Set(
        [...targetHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
      );
      if (!targetIds.has(fragment)) {
        failures.push(`${relative}: ${target} -> no #${fragment} in ${pathPart}`);
      }
    }
  }
}

console.log(`Checked ${pages.length} page(s).`);
if (failures.length) {
  console.error(`\n${failures.length} broken link(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("All internal links resolve.");
