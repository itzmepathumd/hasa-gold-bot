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
      ],

      invalidPlayer: config.invalidPlayerPatterns || [
        /player[\s\w]*not[\s\w]*found/i,
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

    result.transactionId = this.extractTransactionId(source);

    // Failure reasons are checked first. A reply like "insufficient
    // balance" also contains the word "balance", and a supplier that
    // answers "try again" must not be read as a refusal.
    if (this.matchesAny(source, this.patterns.invalidPlayer)) {
      result.status = "failed";
      result.statusDetail = "invalid_player";
      result.confidence = 0.9;
    } else if (
      this.matchesAny(source, this.patterns.insufficientBalance)
    ) {
      result.status = "failed";
      result.statusDetail = "insufficient_balance";
      result.confidence = 0.9;
    } else if (
      this.matchesAny(source, this.patterns.temporaryError)
    ) {
      result.status = "processing";
      result.statusDetail = "temporary_error";
      result.confidence = 0.7;
    } else if (this.matchesAny(source, this.patterns.success)) {
      result.status = "success";
      result.statusDetail = "completed";
      result.confidence = 0.9;
    } else if (this.matchesAny(source, this.patterns.failed)) {
      result.status = "failed";
      result.statusDetail = "failed";
      result.confidence = 0.8;
    } else if (this.matchesAny(source, this.patterns.processing)) {
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