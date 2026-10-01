const telegraf = require("telegraf");

/*
|--------------------------------------------------------------------------
| ROUTE CHECK
|--------------------------------------------------------------------------
| Uses the REAL telegraf registry (not source parsing) to confirm every
| callback we emit is routed to a handler, and that literal handlers win
| over broader regexes that were registered earlier.
*/

telegraf.Telegraf.prototype.launch = function () {};
process.env.BOT_TOKEN = process.env.BOT_TOKEN || "123:FAKE";

const registered = [];

const realAction = telegraf.Telegraf.prototype.action;
telegraf.Telegraf.prototype.action = function (match, ...rest) {
  registered.push({ match, fn: rest[0] });
  return this;
};
telegraf.Telegraf.prototype.on = function () {
  return this;
};
telegraf.Telegraf.prototype.command = function () {
  return this;
};
telegraf.Telegraf.prototype.hears = function () {
  return this;
};

require("./index.js");

function firstMatch(data) {
  for (let i = 0; i < registered.length; i++) {
    const m = registered[i].match;
    if (typeof m === "string" ? m === data : m.test(data)) return i;
  }
  return -1;
}

function findExact(data) {
  return registered.findIndex(
    (r) => typeof r.match === "string" && r.match === data
  );
}

const cases = process.argv.slice(2);
let bad = 0;

console.log("handlers registered: " + registered.length + "\n");

for (const d of cases) {
  const first = firstMatch(d);
  const exact = findExact(d);

  if (first === -1) {
    console.log("NO HANDLER   " + d);
    bad++;
    continue;
  }

  const winner = registered[first];
  const isExact = exact !== -1 && exact === first;

  if (exact !== -1 && !isExact) {
    console.log(
      "SHADOWED     " +
        d +
        " -> caught by " +
        String(winner.match) +
        " at index " +
        first +
        " instead of its own handler"
    );
    bad++;
  } else {
    console.log(
      "OK           " +
        d +
        " -> " +
        (isExact ? "literal handler" : "regex handler " + String(winner.match))
    );
  }
}

console.log(bad ? "\n" + bad + " PROBLEM(S)" : "\nALL ROUTES OK");
process.exit(bad ? 1 : 0);
