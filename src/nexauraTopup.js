/*
|--------------------------------------------------------------------------
| NEXAURA TOP-UP ADAPTER (Free Fire)
|--------------------------------------------------------------------------
| Turns an approved order into a Nexaura topup for Free Fire.
|
| Uses the same idempotency pattern: order_id stored before charging,
| reused on retry.
|
| Product IDs are fetched dynamically from Nexaura API /products endpoint
| and mapped from catalog keys. This keeps Shop2Topup sub_category_id intact.
*/

const { randomUUID } = require("crypto");
const nexaura = require("./database/nexaura");
const playerValidate = require("../playerValidate");

class NexauraTopupAdapter {
  constructor(config = {}) {
    this.config = {
      productionMode: config.productionMode || false,
      resolveProduct: config.resolveProduct || (() => null),
    };

    this.isInitialized = false;
    this.testMode = !this.config.productionMode;
    this.productMap = new Map();
  }

  async initialize() {
    if (this.isInitialized) {
      return true;
    }

    if (this.testMode) {
      console.log("[NEXAURA TOPUP] TEST MODE - no provider order is placed");
      this.isInitialized = true;
      return true;
    }

    // Verify API key is configured
    const balance = await nexaura.getBalance();
    if (balance === null) {
      throw new Error("NEXAURA_API_KEY is not configured");
    }

    // Fetch and cache product mappings
    await this.refreshProductMap();

    this.isInitialized = true;
    console.log("[NEXAURA TOPUP] Ready - Free Fire top-ups via Nexaura API");
    return true;
  }

  async refreshProductMap() {
    try {
      const result = await nexaura.fetchProducts();
      if (result.ok && result.products) {
        this.productMap.clear();

        // Build mapping from catalog product_key -> Nexaura product_id
        // Based on name/category matching
        for (const p of result.products) {
          const key = p.product_id;
          this.productMap.set(key, {
            product_id: p.product_id,
            name: p.name,
            price_lkr: p.price_lkr,
            category: p.category,
            diamonds: p.diamonds,
          });
        }

        console.log(
          `[NEXAURA TOPUP] Loaded ${this.productMap.size} products from API`
        );
      }
    } catch (error) {
      console.warn(
        `[NEXAURA TOPUP] Could not refresh product map: ${error.message}`
      );
    }
  }

  newOrderId() {
    return this.testMode ? null : randomUUID();
  }

  product(order) {
    const resolved = this.config.resolveProduct(order);
    return resolved || null;
  }

  nexauraProductId(order, product) {
    // Get catalog product key
    const productKey = order?.productKey;

    // Try direct match first (exact product_id from API)
    if (this.productMap.has(productKey)) {
      return productKey;
    }

    // Fallback: try name-based matching from catalog
    const catalogProduct = product || this.product(order);
    if (catalogProduct) {
      const name = String(catalogProduct.name || "").toLowerCase();
      const category = String(catalogProduct.category || "").toLowerCase();

      // Match by name/category
      for (const [apiId, info] of this.productMap.entries()) {
        const apiName = String(info.name || "").toLowerCase();
        const apiCategory = String(info.category || "").toLowerCase();

        if (
          name.includes(apiName) ||
          apiName.includes(name) ||
          (category && category === apiCategory)
        ) {
          return apiId;
        }
      }
    }

    // Hardcoded fallbacks for known catalog keys
    const fallbacks = {
      weekly: "weekly",
      weekly_lite: "lite",
      monthly: "monthly",
      booyah_pass: "evo30",
      elite_pass: "level30",
    };

    return fallbacks[productKey] || productKey;
  }

  playerId(order) {
    return String(order?.playerId ?? "").trim();
  }

  plan(order) {
    const product = this.product(order);
    const nexauraProductId = this.nexauraProductId(order, product);
    const playerId = this.playerId(order);

    if (!nexauraProductId || !playerId) {
      return null;
    }

    return {
      orderId: String(order?.providerOrderId ?? "").trim() || null,
      nexauraProductId,
      quantity: 1,
      playerUid: playerId,
      productName: product?.name || order?.productName || null,
    };
  }

  canFulfill(order) {
    return order?.gameId === "free_fire" && Boolean(this.plan(order));
  }

  buildRequest(order) {
    const plan = this.plan(order);
    if (!plan) {
      throw new Error(
        `No Nexaura product mapped for Free Fire package ${order?.productKey || "unknown"}`
      );
    }
    return plan;
  }

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
        statusDetail: "no_nexaura_product",
        orderId: order?.providerOrderId || null,
        transactionId: null,
        raw: null,
      };
    }

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

    if (!plan.orderId) {
      console.error(
        `[NEXAURA TOPUP] Order ${order.id} refused: no provider order id stored`
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

    console.log(
      `[NEXAURA TOPUP] Order ${order.id}: placing topup ${plan.orderId} ` +
        `(product ${plan.nexauraProductId}, player ${plan.playerUid})`
    );

    let response;
    try {
      const result = await nexaura.placeTopup(
        plan.playerUid,
        [{ product_id: plan.nexauraProductId, quantity: plan.quantity }],
        order.id
      );
      response = { data: { success: result.ok, order: result, error: result.error } };
    } catch (error) {
      console.error(
        `[NEXAURA TOPUP] Order ${order.id}: provider did not answer: ${error.message}`
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

    const data = response.data;
    if (data.success && data.order) {
      const nexauraOrder = data.order;
      console.log(
        `[NEXAURA TOPUP] Order ${order.id} answered: ${nexauraOrder.status} (${nexauraOrder.order_id})`
      );
      return {
        success: nexauraOrder.status === "processing" || nexauraOrder.status === "completed",
        status: nexauraOrder.status,
        statusDetail: nexauraOrder.status,
        orderId: nexauraOrder.order_id,
        transactionId: nexauraOrder.order_id,
        raw: data,
      };
    }

    return {
      success: false,
      status: "failed",
      statusDetail: data.error?.message || "Topup failed",
      orderId: plan.orderId,
      transactionId: null,
      raw: data,
    };
  }

  async checkTopupStatus(order) {
    const orderId = String(order?.providerOrderId ?? "").trim();
    if (!orderId) {
      return {
        status: "unknown",
        statusDetail: "no_provider_order_id",
        reason: "This order was never placed with Nexaura",
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
      response = await nexaura.getTopupStatus(orderId);
    } catch (error) {
      return {
        status: "unknown",
        statusDetail: "provider_unreachable",
        reason: error.message,
      };
    }

    if (response.ok && response.orderId) {
      console.log(
        `[NEXAURA TOPUP] Order ${order.id} lookup: ${response.status} (${response.orderId})`
      );
      return {
        status: response.status,
        statusDetail: response.status,
        orderId: response.orderId,
        transactionId: response.orderId,
      };
    }

    return {
      status: "unknown",
      statusDetail: response.error || "Topup not found",
      reason: response.error,
    };
  }

  async cancelTopup() {
    return {
      success: false,
      reason: "Nexaura does not support cancelling a placed topup",
    };
  }

  isReady() {
    return Boolean(this.isInitialized && !this.testMode);
  }

  getStatus() {
    return {
      initialized: this.isInitialized,
      testMode: this.testMode,
      ready: this.isReady(),
      provider: "NEXAURA (Free Fire)",
      productsCached: this.productMap.size,
    };
  }

  async shutdown() {
    this.isInitialized = false;
  }
}

module.exports = { NexauraTopupAdapter };