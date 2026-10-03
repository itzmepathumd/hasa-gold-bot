/*
|--------------------------------------------------------------------------
| SUPPLIER CLIENT
|--------------------------------------------------------------------------
| Connects a normal Telegram user account to the supplier bot over MTProto
| (GramJS) and exchanges messages with it.
|
| The supplier only answers real user accounts, so this needs its own
| phone number and a one-time login code. The resulting session is saved so
| the code is needed once. No credential is ever logged.
*/

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

class SupplierClient {
  constructor(config = {}) {
    this.client = null;

    this.sessionFile =
      config.sessionFile ||
      path.join(__dirname, "..", "..", "supplier_session.json");

    this.supplierBotUsername = (
      config.supplierBotUsername ??
      process.env.SUPPLIER_BOT_USERNAME ??
      ""
    ).replace(/^@/, "");

    this.isConnected = false;
    this.isAuthorized = false;

    // requestId -> { filter, resolve }
    this.pendingRequests = new Map();

    // Answers that arrived before anything was asked for. A supplier bot
    // often greets new chats, and that greeting must not be mistaken for
    // the reply to an order.
    this.staleReplies = [];
  }

  /**
   * Connect and authorize.
   */
  async connect() {
    const apiId = Number(process.env.TG_API_ID);
    const apiHash = process.env.TG_API_HASH;
    const phoneNumber = process.env.TG_PHONE_NUMBER;

    if (!apiId || !apiHash || !phoneNumber) {
      throw new Error(
        "Missing TG_API_ID, TG_API_HASH or TG_PHONE_NUMBER"
      );
    }

    if (!this.supplierBotUsername) {
      throw new Error("Missing SUPPLIER_BOT_USERNAME");
    }

    this.client = new TelegramClient(
      new StringSession(this.loadSession()),
      apiId,
      apiHash,
      { connectionRetries: 5 }
    );

    this.client.on("connected", () => {
      this.isConnected = true;
    });

    this.client.on("disconnected", () => {
      this.isConnected = false;
    });

    this.client.on("error", (error) => {
      console.error(
        "[SUPPLIER] Client error:",
        error?.message || error
      );
    });

    await this.client.start({
      phoneNumber: async () => phoneNumber,
      password: async () =>
        process.env.TG_2FA_PASSWORD || "",
      phoneCode: async () => this.loginCode(),
    });

    this.persistSessionOnChange();

    this.isAuthorized = await this.client.checkAuthorization();

    if (!this.isAuthorized) {
      throw new Error(
        "Telegram authorization did not complete"
      );
    }

    this.client.addEventHandler(
      (event) => this.handleMessage(event),
      NewMessage({ from: this.supplierBotUsername })
    );

    console.log(
      `[SUPPLIER] Connected to @${this.supplierBotUsername}`
    );

    return true;
  }

  /**
   * Read the saved session string.
   */
  loadSession() {
    if (!fs.existsSync(this.sessionFile)) {
      return "";
    }

    try {
      const data = JSON.parse(
        fs.readFileSync(this.sessionFile, "utf8")
      );

      return data.sessionString || "";
    } catch (error) {
      console.warn(
        "[SUPPLIER] Saved session unreadable:",
        error.message
      );

      return "";
    }
  }

  /**
   * Save the session whenever it changes.
   *
   * TelegramClient overwrites session.save during start(), so this is
   * installed after that has happened.
   */
  persistSessionOnChange() {
    const session = this.client.session;

    if (!session || typeof session.save !== "function") {
      console.warn(
        "[SUPPLIER] Session cannot be saved; the login code will be needed again"
      );
      return;
    }

    const original = session.save.bind(session);

    session.save = (noMigrate) => {
      const sessionString = original(noMigrate);

      try {
        fs.writeFileSync(
          this.sessionFile,
          JSON.stringify({ sessionString }, null, 2)
        );
      } catch (error) {
        console.error(
          "[SUPPLIER] Could not save the session:",
          error.message
        );
      }

      return sessionString;
    };
  }

  /**
   * The one-time login code Telegram sends to the account.
   */
  loginCode() {
    const code = process.env.SUPPLIER_LOGIN_CODE;

    if (!code) {
      throw new Error(
        "Set SUPPLIER_LOGIN_CODE to the code Telegram sent, then restart"
      );
    }

    return String(code).replace(/\D/g, "");
  }

  /**
   * Hand a supplier message to whoever is waiting for it.
   */
  handleMessage(event) {
    const message = event?.message;

    if (!message?.text) {
      return;
    }

    for (const [requestId, pending] of this.pendingRequests) {
      const matched =
        !pending.filter || pending.filter(message.text, message);

      if (matched) {
        this.pendingRequests.delete(requestId);
        pending.resolve({
          text: message.text,
          messageId: message.id,
        });
        return;
      }
    }

    // Nobody is waiting: this is not an answer to an order.
    this.staleReplies.push({
      text: message.text,
      messageId: message.id,
      at: Date.now(),
    });

    if (this.staleReplies.length > 20) {
      this.staleReplies.shift();
    }
  }

  /**
   * Send a command and wait for the reply.
   *
   * The waiter is registered before sending, so an instant reply is not
   * dropped. `minReplyDelay` then holds the result long enough that a
   * leftover message from an earlier command cannot be read as this one's
   * answer.
   */
  async sendAndWait(
    text,
    filter,
    timeout = 60000,
    minReplyDelay = 0
  ) {
    if (!this.isAuthorized) {
      throw new Error(
        "Supplier client is not authorized"
      );
    }

    const requestId = crypto.randomUUID();
    const sentAt = Date.now();

    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new Error(
            `Supplier did not reply within ${timeout}ms`
          )
        );
      }, timeout);

      this.pendingRequests.set(requestId, {
        filter,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });

    const sent = await this.client.sendMessage(
      this.supplierBotUsername,
      { message: text }
    );

    const result = await reply;

    const remaining =
      minReplyDelay - (Date.now() - sentAt);

    if (remaining > 0) {
      await sleep(remaining);
    }

    return {
      ...result,
      requestMessageId: sent?.id ?? null,
    };
  }

  /**
   * Is the client connected and authorized?
   */
  isReady() {
    return Boolean(
      this.isAuthorized && this.client?.connected
    );
  }

  /**
   * The supplier bot this client talks to.
   */
  getSupplierBotUsername() {
    return this.supplierBotUsername;
  }

  /**
   * Disconnect cleanly.
   */
  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      this.isConnected = false;
      this.isAuthorized = false;
    }
  }
}

module.exports = { SupplierClient };