/*
|--------------------------------------------------------------------------
| SHOP2TOPUP TOP-UP ADAPTER
|--------------------------------------------------------------------------
| Turns an approved order into one SHOP2TOPUP order, and reads the answer.
|
| The API charges the wallet the moment the order is created, so the whole
| module is arranged around that one fact:
|
|   1. The idempotency key is minted before the order exists, stored on the
|      order record, and reused by every later attempt. Two calls with the
|      same order_id are the same order to the provider, so a retry can
|      never charge the wallet twice.
|   2. A request whose outcome is unknown is reported as unknown, never as a
|      failure and never as a delivery. Only the provider saying the order
|      completed counts as delivered.
|   3. An order is never placed without every field the provider asks for.
|      A rejected order is wasted money; an unsent one is only a delay.
*/

const { randomUUID } = require("crypto");
const { Shop2TopupClient } = require("./shop2topupClient");
const {
  interpretCreateResponse,
  interpretLookupResponse,
} = require("./orderStatus");
const playerValidate = require("../../playerValidate");

class Shop2TopupAdapter {
  constructor(config = {}) {
    this.client = config.client || new Shop2TopupClient(config.clientConfig);

    this.config = {
      productionMode: config.productionMode || false,

      // The catalog is the shop's, not this module's, so index.js hands over
      // a resolver instead of this file reaching for the catalog itself.
      resolveProduct: config.resolveProduct || (() => null),

      // How the provider describes the fields it needs. Defaults to the
      // validation module's cached lookup.
      fetchRequirements:
        config.fetchRequirements || playerValidate.fetchRequirements,

      quantity: config.quantity ?? 1,
    };

    this.isInitialized = false;
    this.testMode = !this.config.productionMode;
  }

  /**
   * Check the credentials, without spending a request on a probe.
   */
  async initialize() {
    if (this.isInitialized) {
      return true;
    }

    if (this.testMode) {
      console.log("[TOPUP] TEST MODE - no provider order is placed");
      console.log(
        "[TOPUP] Set SHOP2TOPUP_PRODUCTION_MODE=true to order for real"
      );
      this.isInitialized = true;
      return true;
    }

    if (!this.client.isConfigured()) {
      throw new Error("SHOP2TOPUP_API_KEY is not configured");
    }

    this.isInitialized = true;

    console.log(
      "[TOPUP] Ready - top-ups are placed through the SHOP2TOPUP order API"
    );

    return true;
  }

  /**
   * A fresh idempotency key, or null in test mode where nothing is ordered.
   */
  newOrderId() {
    return this.testMode ? null : randomUUID();
  }

  /**
   * The catalog entry for an order, however this shop records it.
   */
  product(order) {
    const resolved = this.config.resolveProduct(order);

    if (resolved && typeof resolved === "object") {
      return resolved;
    }

    return null;
  }

  /**
   * The provider's product id. The order's own snapshot wins, because the
   * catalog can be edited by an admin while an order is waiting.
   */
  subCategoryId(order, product) {
    const candidates = [
      order?.subCategoryId,
      product?.sub_category_id,
      product?.subCategoryId,
    ];

    for (const candidate of candidates) {
      const value = Number(candidate);

      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }

    return null;
  }

  playerId(order) {
    return String(order?.playerId ?? "").trim();
  }

  /**
   * The delivery fields the package configures, plus the player's own id and
   * the region the verification step learned.
   */
  configuredRequirements(order, product) {
    const requirements = {};

    for (const field of product?.requirements || []) {
      const name = field?.field_name || field?.name;

      if (name) {
        requirements[name] = String(field.value ?? "");
      }
    }

    const playerId = this.playerId(order);

    if (playerId) {
      requirements.player_id = playerId;
    }

    // SHOP2TOPUP asks for the player's region on some products, and the
    // verification call already knows it.
    const region = String(order?.playerRegion ?? "").trim();

    if (region && !requirements.server && !requirements.region) {
      requirements.region = region;
      requirements.server = region;
    }

    return requirements;
  }

  /**
   * Everything needed to place the order, or null when it cannot be placed.
   *
   * A missing sub_category_id means the package was never mapped onto a
   * provider product, so nothing is guessed. The order id is read from the
   * order and never minted here: it has to be stored before anything is
   * charged, which only the caller can do.
   */
  plan(order) {
    const product = this.product(order);
    const subCategoryId = this.subCategoryId(order, product);
    const playerId = this.playerId(order);

    if (!subCategoryId || !playerId) {
      return null;
    }

    const expected = product?.expected_unit_price ?? product?.expectedUnitPrice;

    return {
      orderId: String(order?.providerOrderId ?? "").trim() || null,
      subCategoryId,
      quantity: this.config.quantity,
      requirements: this.configuredRequirements(order, product),
      expectedUnitPrice:
        expected === undefined || expected === null || expected === ""
          ? null
          : Number(expected),
      productName: product?.name || order?.productName || null,
    };
  }

  /**
   * Can this order be sent automatically?
   */
  canFulfill(order) {
    return Boolean(this.plan(order));
  }

  /**
   * The exact request that will be sent. Pure, so it can be inspected
   * without ordering anything.
   */
  buildRequest(order) {
    const plan = this.plan(order);

    if (!plan) {
      throw new Error(
        `No provider product is mapped for package ${
          order?.productKey || order?.subCategoryId || "unknown"
        }`
      );
    }

    return plan;
  }

  /**
   * Complete the delivery fields from the provider's own description of what
   * it needs, and report anything still missing.
   */
  async resolveRequirements(plan) {
    let described = [];

    try {
      described = await this.config.fetchRequirements(plan.subCategoryId);
    } catch (error) {
      console.warn(
        `[TOPUP] Could not read requirements for ${plan.subCategoryId}: ${error.message}`
      );
    }

    const requirements = { ...plan.requirements };
    const missing = [];

    for (const field of Array.isArray(described) ? described : []) {
      const name = field?.field_name || field?.name || field?.key;

      if (!name) {
        continue;
      }

      const value = requirements[name];
      const filled =
        value !== undefined &&
        value !== null &&
        String(value).trim() !== "";

      if (filled) {
        requirements[name] = String(value);
        continue;
      }

      const optional =
        field.required === false || field.optional === true;
      const fallback = String(
        field.default_value ?? field.value ?? field.default ?? ""
      ).trim();

      if (fallback) {
        requirements[name] = fallback;
        continue;
      }

      if (!optional) {
        missing.push(name);
      }
    }

    return { requirements, missing };
  }

  /**
   * Place one order.
   *
   * Never throws: the caller is a customer-facing flow, so every outcome is
   * returned in the same shape instead.
   */
  async sendTopup(order) {
    if (!this.isInitialized) {
      try {
        await this.initialize();
      } catch (error) {
        return {
          success: false,
          status: "unknown",
          statusDetail: "provider_not_configured",
          orderId: order?.providerOrderId || null,
          transactionId: null,
          raw: null,
          error: error.message,
        };
      }
    }

    const plan = this.plan(order);

    if (!plan) {
      return {
        success: false,
        status: "failed",
        statusDetail: "no_provider_product",
        orderId: order?.providerOrderId || null,
        transactionId: null,
        raw: null,
      };
    }

    // Test mode must never claim delivery: nothing was ordered, so telling a
    // customer their top-up arrived would be a lie.
    if (this.testMode) {
      return {
        success: false,
        status: "processing",
        statusDetail: "test_mode_no_request_sent",
        orderId: plan.orderId,
        transactionId: null,
        raw: null,
      };
    }

    // Without a stored id there is no idempotency key, and an order placed
    // without one cannot be read back or safely retried. Refuse rather than
    // risk a purchase nobody can trace.
    if (!plan.orderId) {
      console.error(
        `[TOPUP] Order ${order.id} refused: no provider order id was stored`
      );

      return {
        success: false,
        status: "unknown",
        statusDetail: "no_provider_order_id",
        orderId: null,
        transactionId: null,
        raw: null,
      };
    }

    const { requirements, missing } = await this.resolveRequirements(plan);

    if (missing.length) {
      console.warn(
        `[TOPUP] Order ${order.id}: provider needs ${missing.join(", ")} and this order does not carry them`
      );

      return {
        success: false,
        status: "failed",
        statusDetail: `missing_requirement:${missing.join(",")}`,
        orderId: plan.orderId,
        transactionId: null,
        raw: null,
      };
    }

    console.log(
      `[TOPUP] Order ${order.id}: placing provider order ${plan.orderId} ` +
        `(sub_category_id ${plan.subCategoryId}, quantity ${plan.quantity})`
    );

    let response;

    try {
      response = await this.client.createOrder({
        orderId: plan.orderId,
        subCategoryId: plan.subCategoryId,
        quantity: plan.quantity,
        requirements,
        expectedUnitPrice: plan.expectedUnitPrice,
      });
    } catch (error) {
      // The order may already exist and be paid for. It stays unknown, and
      // the same order_id is used if this is ever looked at again.
      console.error(
        `[TOPUP] Order ${order.id}: provider did not answer: ${error.message}`
      );

      return {
        success: false,
        status: "unknown",
        statusDetail: "provider_unreachable",
        orderId: plan.orderId,
        transactionId: null,
        raw: null,
        error: error.message,
      };
    }

    const result = interpretCreateResponse(response, { orderId: plan.orderId });

    console.log(
      `[TOPUP] Order ${order.id} answered: ${result.status} (${result.statusDetail})`
    );

    return result;
  }

  /**
   * Read an order back, so an interrupted or still-running order settles
   * without being placed a second time.
   */
  async checkTopupStatus(order) {
    const orderId = String(order?.providerOrderId ?? "").trim();

    if (!orderId) {
      return {
        status: "unknown",
        statusDetail: "no_provider_order_id",
        reason:
          "This order was never placed with the provider, so there is nothing to look up",
      };
    }

    if (this.testMode) {
      return {
        status: "unknown",
        statusDetail: "test_mode",
        reason: "Test mode places no provider orders",
      };
    }

    let response;

    try {
      response = await this.client.getOrder(orderId);
    } catch (error) {
      return {
        status: "unknown",
        statusDetail: "provider_unreachable",
        reason: error.message,
      };
    }

    const result = interpretLookupResponse(response, orderId);

    console.log(
      `[TOPUP] Order ${order.id} lookup: ${result.status} (${result.statusDetail})`
    );

    return result;
  }

  /**
   * The provider exposes no cancel, so this says so rather than pretending.
   */
  async cancelTopup() {
    return {
      success: false,
      reason:
        "The provider cannot cancel an order once it has been paid for",
    };
  }

  isReady() {
    return Boolean(
      this.isInitialized &&
        !this.testMode &&
        this.client.isConfigured()
    );
  }

  getStatus() {
    return {
      initialized: this.isInitialized,
      testMode: this.testMode,
      ready: this.isReady(),
      provider: "SHOP2TOPUP",
      apiBase: this.client.baseUrl,
      configured: this.client.isConfigured(),
    };
  }

  /**
   * Nothing is held open between calls, so this only marks the adapter
   * unready. It exists because the shop has one shutdown path for every
   * provider it has ever had.
   */
  async shutdown() {
    this.isInitialized = false;
  }
}

module.exports = { Shop2TopupAdapter };