/*
|--------------------------------------------------------------------------
| ABOUT PAGE TEST
|--------------------------------------------------------------------------
| The About page is hand-built HTML, so the two things that can break
| silently are a bad entity and a link pointing somewhere wrong. A stray
| "&" or an unclosed tag makes Telegram reject the whole message, which
| looks like the bot going quiet rather than a formatting bug.
*/

const fs = require("fs");
const path = require("path");

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log(
      "  FAIL  " + label + (detail ? "  -> " + detail : "")
    );
  }
}

const source = fs.readFileSync(
  path.join(__dirname, "index.js"),
  "utf8"
);

// Pull the developer block and the page builder out of the source without
// booting the bot.
const developer = source.match(
  /const DEVELOPER = \{[\s\S]*?\};/
);
const aboutText = source.match(
  /function aboutText\(\) \{[\s\S]*?\n\}/
);
const aboutMenu = source.match(
  /function aboutMenu\(\) \{[\s\S]*?\n\}/
);

console.log("\n== the page is defined ==");

check("DEVELOPER block exists", Boolean(developer));
check("aboutText() exists", Boolean(aboutText));
check("aboutMenu() exists", Boolean(aboutMenu));

if (!developer || !aboutText || !aboutMenu) {
  console.log(
    "\n" + fail + " CHECK(S) FAILED  (" + pass + " passed, " + fail + " failed)"
  );
  process.exit(1);
}

const details = {
  company: developer[0].match(/company:\s*"([^"]+)"/)?.[1],
  telegram: developer[0].match(/telegram:\s*"([^"]+)"/)?.[1],
  whatsapp: developer[0].match(/whatsapp:\s*"([^"]+)"/)?.[1],
  website: developer[0].match(/website:\s*"([^"]+)"/)?.[1],
};

console.log("\n== contact details ==");

check(
  "company is Vynloq Software Solutions",
  details.company === "Vynloq Software Solutions",
  details.company
);
check("telegram is @methsarap", details.telegram === "methsarap", details.telegram);
check(
  "whatsapp is +94753492120",
  details.whatsapp === "+94753492120",
  details.whatsapp
);
check(
  "website is vynloq.web.app",
  details.website === "https://www.vynloq.web.app",
  details.website
);

console.log("\n== every detail is shown on the page ==");

// The page is built from ${DEVELOPER.*} placeholders, so the source is
// checked for the reference rather than the literal value.
for (const field of ["company", "telegram", "whatsapp", "website"]) {
  check(
    field + " is rendered on the page",
    aboutText[0].includes("${DEVELOPER." + field + "}"),
    "no ${DEVELOPOR." + field + "} reference"
  );
}

check(
  "the telegram handle is shown with its @",
  aboutText[0].includes("@${DEVELOPER.telegram}"),
  "@ prefix missing"
);

console.log("\n== the page survives Telegram's HTML parser ==");

// Telegram accepts a small tag set; anything else is rejected outright.
const allowed = /<\/?(b|i|u|s|code|pre|a|tg-spoiler|blockquote)\b[^>]*>/g;
const tags = aboutText[0].match(allowed) || [];

const stripped = aboutText[0].replace(allowed, "");
const stray = stripped.match(/[<>]/g);

check("no unsupported tags", tags.length > 0 && !stray, String(stray));

const opens = (aboutText[0].match(/<b>/g) || []).length;
const closes = (aboutText[0].match(/<\/b>/g) || []).length;
check("every <b> is closed", opens === closes, opens + " open, " + closes + " close");

const iOpens = (aboutText[0].match(/<i>/g) || []).length;
const iCloses = (aboutText[0].match(/<\/i>/g) || []).length;
check("every <i> is closed", iOpens === iCloses, iOpens + " open, " + iCloses + " close");

check(
  "ampersands are escaped as &amp;",
  !/[^\s] &[^\s]/.test(aboutText[0].replace(/&amp;/g, "")),
  "bare ampersand found"
);

console.log("\n== links ==");

// Resolved from the DEVELOPER block, so a wrong handle or number is
// caught here rather than by a dead button in Telegram.
const telegramUrl = "https://t.me/" + details.telegram;
const waDigits = details.whatsapp.replace(/\D/g, "");
const waUrl = "https://wa.me/" + waDigits;

check(
  "telegram button points at the profile",
  aboutMenu[0].includes("https://t.me/") &&
    aboutMenu[0].includes("${DEVELOPER.telegram}"),
  "no https://t.me/${DEVELOPER.telegram}"
);
check(
  "whatsapp button uses wa.me with digits only",
  aboutMenu[0].includes("wa.me/") &&
    aboutMenu[0].includes('DEVELOPER.whatsapp.replace(/\\D/g, "")') &&
    !waUrl.includes("+"),
  waUrl
);
check(
  "whatsapp digits are the real number",
  waDigits === "94753492120",
  waDigits
);
check(
  "website button uses the full https url",
  aboutMenu[0].includes("DEVELOPER.website") &&
    details.website.startsWith("https://"),
  details.website
);
check(
  "every link is built from a verified value",
  telegramUrl === "https://t.me/methsarap" && waUrl === "https://wa.me/94753492120"
);
check(
  "the page itself uses Markup.button.url",
  (aboutMenu[0].match(/Markup\.button\.url/g) || []).length === 3,
  String((aboutMenu[0].match(/Markup\.button\.url/g) || []).length)
);
check(
  "the keyboard also offers a way back into the store",
  aboutMenu[0].includes('"games"') &&
    aboutMenu[0].includes('"support"') &&
    aboutMenu[0].includes('"home"')
);

console.log(
  "\n" +
    (fail === 0
      ? "ALL ABOUT CHECKS PASSED"
      : fail + " CHECK(S) FAILED") +
    "  (" +
    pass +
    " passed, " +
    fail +
    " failed)"
);

process.exit(fail ? 1 : 0);