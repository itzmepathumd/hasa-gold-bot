/*
|--------------------------------------------------------------------------
| NEXAURA API CLIENT
|--------------------------------------------------------------------------
| Auto-verify EZ Cash deposits for wallet recharge.
|
| Flow:
|   1. User selects "EZ Cash Auto Verify"
|   2. Bot asks for 14-digit RN
|   3. Call POST /deposits/ezcash
|   4. If credited: instant wallet credit
|   5. If pending: tell user to wait, poll for up to 1 hour
*/

const axios = require("axios");

const BASE_URL = "https://topup.nexauracore.com/api/v1/reseller";
const API_KEY = process.env.NEXAURA_API_KEY;

if (!API_KEY) {
  console.warn("⚠️  NEXAURA_API_KEY is missing in .env");
}

async function getClient() {
  if (!API_KEY) {
    return null;
  }

  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });
}

async function verifyEzCashDeposit(rn) {
  const client = await getClient();

  if (!client) {
    return { ok: false, error: "Nexaura API key not configured" };
  }

  try {
    const response = await client.post("/deposits/ezcash", {
      rn: String(rn).trim(),
    });

    const data = response.data;

    if (data.success && data.deposit) {
      const deposit = data.deposit;

      if (deposit.status === "credited") {
        return {
          ok: true,
          status: "credited",
          depositId: deposit.deposit_id,
          amount: Number(deposit.credited_lkr) || 0,
          balance: Number(data.balance_lkr) || 0,
          message: data.message || "Payment verified and credited.",
        };
      }

      if (deposit.status === "pending") {
        return {
          ok: true,
          status: "pending",
          depositId: deposit.deposit_id,
          message:
            "Payment is pending verification. This may take a few minutes due to SMS delays. Please wait.",
        };
      }

      return {
        ok: false,
        error: data.message || `Unknown deposit status: ${deposit.status}`,
      };
    }

    return {
      ok: false,
      error: data.error?.message || "Verification failed",
    };
  } catch (error) {
    const message =
      error.response?.data?.error?.message || error.message || "Network error";

    return { ok: false, error: message };
  }
}

async function getDepositStatus(depositId) {
  const client = await getClient();

  if (!client) {
    return { ok: false, error: "Nexaura API key not configured" };
  }

  try {
    const response = await client.get(`/deposits/${depositId}`);
    const data = response.data;

    if (data.success && data.deposit) {
      const deposit = data.deposit;

      if (deposit.status === "credited") {
        return {
          ok: true,
          status: "credited",
          depositId: deposit.deposit_id,
          amount: Number(deposit.credited_lkr) || 0,
          balance: Number(data.balance_lkr) || 0,
        };
      }

      if (deposit.status === "pending") {
        return {
          ok: true,
          status: "pending",
          depositId: deposit.deposit_id,
        };
      }
    }

    return {
      ok: false,
      error: data.error?.message || "Deposit not found or failed",
    };
  } catch (error) {
    const message =
      error.response?.data?.error?.message || error.message || "Network error";

    return { ok: false, error: message };
  }
}

async function getBalance() {
  const client = await getClient();

  if (!client) {
    return null;
  }

  try {
    const response = await client.get("/balance");
    const data = response.data;

    if (data.success) {
      return Number(data.balance_lkr) || 0;
    }

    return null;
  } catch (error) {
    console.error("[NEXAURA] Balance check failed:", error.message);
    return null;
  }
}

module.exports = {
  verifyEzCashDeposit,
  getDepositStatus,
  getBalance,
};
