const fs = require("fs");
const telegraf = require("telegraf");

/*
|--------------------------------------------------------------------------
| DEAD HANDLER SCAN
|--------------------------------------------------------------------------
| Compares every bot.action(...) written in the source against the handlers
| that actually reach the telegraf registry at require() time. A handler
| present in source but missing at runtime is nested inside another block,
| i.e. silently dead code.
*/

telegraf.Telegraf.prototype.launch = function () {};
process.env.BOT_TOKEN = process.env.BOT_TOKEN || "123:FAKE";

const src = fs.readFileSync("./index.js", "utf8");
const lines = src.split("\n");

// source declarations (line-anchored, simple scan)
const srcDecls = [];
lines.forEach((l, i) => {
  const m = l.match(/^bot\.action\(\s*(?:"([^"]+)"|(\/.*\/[gimsuy]*))/);
  if (m) srcDecls.push({ line: i + 1, pat: m[1] ? "lit:" + m[1] : "re:" + m[2] });
});

const runtime = [];
const realAction = telegraf.Telegraf.prototype.action;
telegraf.Telegraf.prototype.action = function (match, ...rest) {
  runtime.push({ pat: typeof match === "string" ? "lit:" + match : "re:" + match, fn: rest[0] });
  return this;
};
telegraf.Telegraf.prototype.on = function () { return this; };
telegraf.Telegraf.prototype.command = function () { return this; };
telegraf.Telegraf.prototype.hears = function () { return this; };

require("./index.js");

telegraf.Telegraf.prototype.action = realAction;

console.log("source bot.action declarations : " + srcDecls.length);
console.log("registered at runtime          : " + runtime.length + "\n");

const runtimeSet = new Set(runtime.map((r) => r.pat));
const counts = {};
for (const r of runtime) counts[r.pat] = (counts[r.pat] || 0) + 1;

const dead = [];
for (const d of srcDecls) {
  if (!runtimeSet.has(d.pat)) dead.push(d);
}

if (dead.length === 0) {
  console.log("no dead handlers");
} else {
  console.log("DEAD HANDLERS (written but never registered):\n");
  for (const d of dead) console.log("  line " + d.line + "  " + d.pat);
}

// duplicate patterns registered twice
console.log("\nDUPLICATE PATTERNS:");
let dupes = false;
for (const [p, n] of Object.entries(counts)) {
  if (n > 1) {
    console.log("  " + p + " registered " + n + " times");
    dupes = true;
  }
}
if (!dupes) console.log("  none");

process.exit(dead.length ? 1 : 0);
