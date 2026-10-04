/*
|--------------------------------------------------------------------------
| SUPPLIER PARSER
|--------------------------------------------------------------------------
| Turns a reply from the supplier bot into a structured result.
|
| The supplier's wording has never been seen by this code, so the rules are
| deliberately asymmetric:
|
|   - Only an explicitly positive phrase counts as success.
|   - Anything unrecognised stays "unknown", which parks the order for a
|     human instead of guessing.
|
| A false positive here tells a customer their top-up arrived when it did
| not, so the patterns below err towards under-reporting.
*/

/*
| Map the Unicode small-cap and fullwidth letters onto plain ASCII.
|
| The supplier styles parts of a reply as "Tʀᴀɴsᴀᴄᴛɪᴏɴ Vᴇʀɪғɪᴇᴅ", using
| small capitals, IPA lookalikes and a Cyrillic glyph or two. Every pattern
| in the parser is written against ASCII words with \b boundaries, so without
| this the supplier's payment confirmation - the one reply that matters most -
| could not be recognised and a paid top-up was reported as unknown.
|
| NFKD does not help here: these are distinct letters, not accented forms,
| so they survive normalisation unchanged. The table below is therefore
| explicit, keyed by code point. Deriving it by arithmetic is not possible:
| the U+1D00 small-capital block interleaves and skips letters, so A-Z does
| not run consecutively through it. Each entry was checked against the real
| supplier replies.
|
| Folding the whole message, rather than adding a pattern per styled word,
| keeps this working for the words the supplier styles next.
*/
const LATIN_FOLD = {
  // Latin letter small capitals (U+1D00 block, not sequential).
  0x1d00: "a", 0x1d01: "b", 0x1d04: "c", 0x1d05: "d", 0x1d07: "e",
  0x1d29: "h", 0x1d0f: "o", 0x1d16: "p", 0x1d1b: "t", 0x1d20: "v",
  0x1d21: "w", 0x1d22: "x", 0x1d23: "y", 0x1d24: "z", 0x1d25: "s",

  // IPA extensions used as small-capital lookalikes.
  0x0280: "r", // turned r
  0x0274: "n", // small capital eng
  0x026a: "i", // small capital i
  0x026f: "m", // small capital turned m
  0x0254: "o", // open o
  0x0250: "a", // turned a
  0x0251: "a", // latin small letter alpha
  0x025c: "e", // open e
  0x025f: "j", // small capital barred j
  0x029f: "l", // small capital l
  0x028f: "y", // small capital y
  0x0299: "b", // small capital b
  0xa730: "f", // latin letter small capital f

  // Cyrillic small capitals the supplier mixes in.
  0x0493: "r", // Cyrillic small letter rzhe
  0x04cf: "l", // Cyrillic small palochka

  // Latin letter small capital variants.
  0x1d06: "g", 0x1d0a: "k", 0x1d10: "q", 0x1d1c: "u",
};

function isFoldable(code) {
  return (
    Object.prototype.hasOwnProperty.call(LATIN_FOLD, code) ||
    (code >= 0xff01 && code <= 0xff5e)
  );
}

/**
 * Fold a styled message back to comparable ASCII. Non-letter characters are
 * left alone so transaction ids and amounts survive untouched.
 */
function foldUnicodeText(text) {
  let out = "";

  for (const ch of String(text)) {
    const code = ch.codePointAt(0);

    if (code < 128) {
      out += ch;
      continue;
    }

    // Fullwidth ASCII sits a fixed distance above plain ASCII.
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0);
      continue;
    }

    out += Object.prototype.hasOwnProperty.call(LATIN_FOLD, code)
      ? LATIN_FOLD[code]
      : ch;
  }

  return out;
}

class SupplierParser {
  constructor(config = {}) {
    this.patterns = {
      success: config.successPatterns || [
        /\bsuccessful\b/i,
        /\bsuccess\b/i,
        /\bcompleted\b/i,
        /\bcomplete\b/i,
        /\bdelivered\b/i,
        /\btop[\s-]?up\s+(successful|done|complete|completed|delivered)\b/i,
        /\bdone\b/i,
        // The supplier confirms payment as "Transaction Verified" in styled
        // small caps. Folding in parse() turns that into plain ASCII, so
        // these two words are all that is needed for it to match.
        /\bverified\b/i,
        /\bcredited\b/i,
      ],

      invalidPlayer: config.invalidPlayerPatterns || [
        // The supplier writes "found" with the n dropped ("foud") in its
        // styled messages, so foun?d is matched rather than found. A missing
        // player is unambiguous either way, and this is a failure, so
        // tolerating the typo errs towards reporting the problem.
        /player[\s\w]*not[\s\w]*foun?d/i,
        /invalid[\s\w]*player/i,
        /player[\s\w]*invalid/i,
        /wrong[\s\w]*id/i,
        /user[\s\w]*not[\s\w]*found/i,
        /no[\s\w]*such[\s\w]*player/i,
      ],

      insufficientBalance: config.insufficientBalancePatterns || [
        /insufficient/i,
        /not[\s\w]*enough[\s\w]*balance/i,
        /balance[\s\w]*too[\s\w]*low/i,
        /low[\s\w]*balance/i,
        /out[\s\w]*of[\s\w]*stock/i,
      ],

      temporaryError: config.temporaryErrorPatterns || [
        /try[\s\w]*again/i,
        /temporar(il)?y/i,
        /timed?[\s\w]*out/i,
        /rate[\s\w]*limit/i,
        /too[\s\w]*many/i,
        /\bbusy\b/i,
      ],

      processing: config.processingPatterns || [
        /\bprocessing\b/i,
        /\bpending\b/i,
        /in[\s\w]*progress/i,
        /\bqueued\b/i,
        /\bwaiting\b/i,
        /shortly/i,
      ],

      failed: config.failedPatterns || [
        /\bfailed\b/i,
        /\brejected\b/i,
        /\bcancell?ed\b/i,
        /\bdenied\b/i,
        /\bdeclined\b/i,
        /could[\s\w]*not/i,
      ],
    };

    this.transactionIdPatterns =
      config.transactionIdPatterns || [
        /transaction[\s_-]?id[:\s]*([A-Za-z0-9_-]{4,})/i,
        /txn[\s_-]?id[:\s]*([A-Za-z0-9_-]{4,})/i,
        /order[\s_-]?id[:\s]*([A-Za-z0-9_-]{4,})/i,
        /reference[:\s]*([A-Za-z0-9_-]{4,})/i,
        /\btrx[:\s]*([A-Za-z0-9_-]{4,})/i,
      ];
  }

  /**
   * Parse a supplier reply.
   *
   * Never throws: a broken reply must not take the fulfilment down with
   * it.
   */
  parse(text) {
    const source = String(text ?? "");

    const result = {
      raw: source,
      status: "unknown",
      statusDetail: "unrecognised_reply",
      transactionId: null,
      confidence: 0,
    };

    if (!source.trim()) {
      result.statusDetail = "empty_reply";
      return result;
    }

    /*
    | The supplier styles some replies in Unicode small caps, so its payment
    | confirmation arrives as "Tʀᴀɴsᴀᴄᴛɪᴏɴ Vᴇʀɪғɪᴇᴅ". Those are not ASCII
    | letters, so \bword\b never matches them and a top-up that really was
    | paid read as "unknown": the customer is told nothing happened when
    | their money had already moved.
    |
    | Matching is therefore done on a folded copy, which turns the small-cap
    | letters back into plain ASCII. Folding the whole message rather than
    | adding a pattern per styled word keeps this working for every word the
    | supplier chooses to style next.
    */
    const folded = foldUnicodeText(source);

    result.transactionId = this.extractTransactionId(folded);

    // Failure reasons are checked first. A reply like "insufficient
    // balance" also contains the word "balance", and a supplier that
    // answers "try again" must not be read as a refusal.
    if (this.matchesAny(folded, this.patterns.invalidPlayer)) {
      result.status = "failed";
      result.statusDetail = "invalid_player";
      result.confidence = 0.9;
    } else if (
      this.matchesAny(folded, this.patterns.insufficientBalance)
    ) {
      result.status = "failed";
      result.statusDetail = "insufficient_balance";
      result.confidence = 0.9;
    } else if (
      this.matchesAny(folded, this.patterns.temporaryError)
    ) {
      result.status = "processing";
      result.statusDetail = "temporary_error";
      result.confidence = 0.7;
    } else if (this.matchesAny(folded, this.patterns.success)) {
      result.status = "success";
      result.statusDetail = "completed";
      result.confidence = 0.9;
    } else if (this.matchesAny(folded, this.patterns.failed)) {
      result.status = "failed";
      result.statusDetail = "failed";
      result.confidence = 0.8;
    } else if (this.matchesAny(folded, this.patterns.processing)) {
      result.status = "processing";
      result.statusDetail = "processing";
      result.confidence = 0.7;
    }

    return result;
  }

  /**
   * Pull a supplier transaction id out of the reply, if there is one.
   */
  extractTransactionId(text) {
    for (const pattern of this.transactionIdPatterns) {
      const match = text.match(pattern);

      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Does the text match any pattern in the list?
   */
  matchesAny(text, patterns) {
    return patterns.some((pattern) =>
      pattern instanceof RegExp
        ? pattern.test(text)
        : text
            .toLowerCase()
            .includes(String(pattern).toLowerCase())
    );
  }
}

module.exports = { SupplierParser };