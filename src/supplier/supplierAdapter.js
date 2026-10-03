/*
|--------------------------------------------------------------------------
| SUPPLIER ADAPTER
|--------------------------------------------------------------------------
| Talks to @tikka_auto_top_up_bot.
|
| One order is one command:
|
|   /id <playerId> <PRODUCT>
|
| e.g. /id 11927288867 WEEKLY
|
| There is no multi-step conversation, so this sends that command, waits for
| the reply, and parses it.
|
| Two rules matter here:
|
|   1. An unmapped package is refused rather than sent with a guessed
|      product name, because a wrong name can deliver the wrong thing to a
|      paying customer.
|   2. Requests are serialised. The supplier account has one conversation,
|      so two concurrent top-ups would otherwise read each other's
|      replies.
*/

const { SupplierClient } = require("./supplierClient");
const { SupplierParser } = require("./supplierParser");

class SupplierAdapter {
  constructor(config = {}) {
    this.client = config.client || new SupplierClient();
    this.parser = new SupplierParser(config.parserConfig);

    this.config = {
      commandTemplate:
        config.commandTemplate || "/id {playerId} {product}",

      // Supplier product names, keyed by our package ids. Only names the
      // supplier has confirmed belong here.
      productMapping: config.productMapping || {},

      // Fallback used only when a caller deliberately opts in.
      defaultProductToken: config.defaultProductToken ?? null,

      // A guessed name is worse than no automation, so unmapped packages
      // are refused unless this is turned off.
      strictProductMapping: config.strictProductMapping ?? true,

      responseTimeout: config.responseTimeout || 60000,

      // A reply faster than this is treated as leftover from an earlier
      // command rather than the answer to this one.
      minReplyDelay: config.minReplyDelay ?? 1500,

      productionMode: config.productionMode || false,

      // Optional file for recording raw replies, so the parser can be
      // widened from real traffic.
      replyLogFile: config.replyLogFile ?? null,
    };

    this.isInitialized = false;
    this.testMode = !this.config.productionMode;

    this.queue = Promise.resolve();
  }

  /**
   * Connect to the supplier, unless in test mode.
   */
  async initialize() {
    if (this.isInitialized) {
      return true;
    }

    if (this.testMode) {
      console.log(
        "[SUPPLIER] TEST MODE - no supplier request is sent"
      );
      console.log(
        "[SUPPLIER] Set SUPPLIER_PRODUCTION_MODE=true for real top-ups"
      );
      this.isInitialized = true;
      return true;
    }

    try {
      await this.client.connect();
      this.isInitialized = true;
      return true;
    } catch (error) {
      console.error(
        "[SUPPLIER] Could not connect:",
        error.message
      );
      throw error;
    }
  }

  /**
   * The product name the supplier expects, or null when it is unknown.
   */
  resolveProductToken(order) {
    const mapped =
      this.config.productMapping[order.productKey] ??
      this.config.productMapping[order.productId];

    if (mapped) {
      return String(mapped).trim();
    }

    if (this.config.defaultProductToken) {
      return this.config.defaultProductToken;
    }

    if (this.config.strictProductMapping) {
      return null;
    }

    return String(order.productKey || order.productId || "")
      .trim()
      .toUpperCase();
  }

  /**
   * Can this order be sent automatically?
   */
  canFulfill(order) {
    return Boolean(this.resolveProductToken(order));
  }

  /**
   * Build the supplier command for an order.
   *
   * Throws when the product name is unknown, so the caller parks the order
   * instead of sending an invented command.
   */
  buildCommand(order) {
    const product = this.resolveProductToken(order);

    if (!product) {
      throw new Error(
        `No confirmed supplier product name for package ${
          order.productKey || order.productId || "unknown"
        }`
      );
    }

    return {
      product,
      command: this.config.commandTemplate
        .replace("{playerId}", String(order.playerId).trim())
        .replace("{product}", product),
    };
  }

  /**
   * Send one top-up order.
   */
  async sendTopup(order) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const { command, product } = this.buildCommand(order);

    console.log(`[SUPPLIER] Order ${order.id}: ${command}`);

    // Test mode must never confirm delivery: nothing was sent, so telling
    // a customer their top-up arrived would be a lie.
    if (this.testMode) {
      return {
        success: false,
        status: "processing",
        statusDetail: "test_mode_no_request_sent",
        transactionId: null,
        messageId: null,
        orderId: order.id,
        product,
        rawResponse: null,
      };
    }

    return this.enqueue(async () => {
      let reply;

      try {
        reply = await this.client.sendAndWait(
          command,
          null,
          this.config.responseTimeout,
          this.config.minReplyDelay
        );
      } catch (error) {
        // The command may have reached the supplier, so the outcome is
        // unknown. The caller must not resend on its own.
        return {
          success: false,
          status: "unknown",
          statusDetail: "no_reply_from_supplier",
          transactionId: null,
          messageId: null,
          orderId: order.id,
          product,
          rawResponse: null,
          error: error.message,
        };
      }

      this.logReply(order, reply.text);

      const parsed = this.parser.parse(reply.text);

      console.log(
        `[SUPPLIER] Order ${order.id} reply: ${parsed.status} (${parsed.statusDetail})`
      );

      if (parsed.status === "unknown") {
        console.warn(
          `[SUPPLIER] Unrecognised reply for ${order.id}: ${reply.text}`
        );
      }

      return {
        // Only an explicit success counts.
        success: parsed.status === "success",
        status: parsed.status,
        statusDetail: parsed.statusDetail,
        transactionId: parsed.transactionId,
        // Our command's id is the stable handle for this request.
        messageId: reply.requestMessageId,
        replyMessageId: reply.messageId,
        orderId: order.id,
        product,
        rawResponse: reply.text,
      };
    });
  }

  /**
   * Append a raw reply to the log, so the parser can be tuned from real
   * traffic instead of guessed patterns.
   */
  logReply(order, text) {
    if (!this.config.replyLogFile || !text) {
      return;
    }

    try {
      const fs = require("fs");
      const line = JSON.stringify({
        at: new Date().toISOString(),
        orderId: order.id,
        playerId: order.playerId,
        product: order.productKey,
        reply: text,
      });

      fs.appendFileSync(
        this.config.replyLogFile,
        line + "\n"
      );
    } catch (error) {
      console.error(
        "[SUPPLIER] Could not log the reply:",
        error.message
      );
    }
  }

  /**
   * Run supplier work one request at a time.
   */
  enqueue(task) {
    const run = this.queue.then(task, task);

    this.queue = run.then(
      () => {},
      () => {}
    );

    return run;
  }

  /**
   * The supplier exposes no status lookup, so an in-flight request cannot
   * be resolved automatically. Returning "unknown" keeps the order out of
   * a terminal state instead of guessing.
   */
  async checkTopupStatus() {
    return {
      status: "unknown",
      statusDetail: "no_supplier_status_command",
      reason:
        "The supplier bot has no status lookup; resolve this order manually",
    };
  }

  /**
   * The supplier bot cannot cancel a request.
   */
  async cancelTopup() {
    return {
      success: false,
      reason:
        "The supplier bot cannot cancel a top-up once requested",
    };
  }

  isReady() {
    return (
      this.isInitialized &&
      !this.testMode &&
      this.client.isReady()
    );
  }

  getStatus() {
    return {
      initialized: this.isInitialized,
      testMode: this.testMode,
      ready: this.isReady(),
      supplierBot: this.client.getSupplierBotUsername(),
    };
  }

  /*
  |--------------------------------------------------------------------------
  | SHUTDOWN
  |--------------------------------------------------------------------------
  | The MTProto client keeps its own socket open, so stopping the Telegraf
  | bot alone leaves the process alive and the session half-open. Drop the
  | connection explicitly so a restart resumes cleanly.
  */
  async shutdown() {
    this.isInitialized = false;

    try {
      await this.client.disconnect();
    } catch (error) {
      console.error(
        "[SUPPLIER] Disconnect on shutdown failed:",
        error.message
      );
    }
  }
}

module.exports = { SupplierAdapter };