const MAX_ATTEMPTS = 4;
const BLOCK_DURATION_MS = 30 * 60 * 1000;

const attempts = new Map();

function getKey(userId) {
  return String(userId);
}

function cleanup() {
  const now = Date.now();
  for (const [key, data] of attempts.entries()) {
    if (data.blockedUntil && data.blockedUntil < now) {
      attempts.delete(key);
    }
  }
}

setInterval(cleanup, 5 * 60 * 1000).unref?.();

function recordFailure(userId) {
  const key = getKey(userId);
  const now = Date.now();
  let data = attempts.get(key);

  if (!data) {
    data = { count: 0, blockedUntil: null };
    attempts.set(key, data);
  }

  if (data.blockedUntil && data.blockedUntil > now) {
    return { blocked: true, remainingMs: data.blockedUntil - now };
  }

  data.count += 1;

  if (data.count >= MAX_ATTEMPTS) {
    data.blockedUntil = now + BLOCK_DURATION_MS;
    return { blocked: true, remainingMs: BLOCK_DURATION_MS };
  }

  return { blocked: false, attemptsLeft: MAX_ATTEMPTS - data.count };
}

function resetAttempts(userId) {
  const key = getKey(userId);
  attempts.delete(key);
}

function getStatus(userId) {
  const key = getKey(userId);
  const data = attempts.get(key);
  const now = Date.now();

  if (!data) {
    return { blocked: false, attemptsLeft: MAX_ATTEMPTS };
  }

  if (data.blockedUntil && data.blockedUntil > now) {
    return { blocked: true, remainingMs: data.blockedUntil - now };
  }

  if (data.blockedUntil && data.blockedUntil <= now) {
    attempts.delete(key);
    return { blocked: false, attemptsLeft: MAX_ATTEMPTS };
  }

  return { blocked: false, attemptsLeft: MAX_ATTEMPTS - data.count };
}

function formatRemainingMs(ms) {
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes === 1) return "1 minute";
  return `${minutes} minutes`;
}

module.exports = {
  MAX_ATTEMPTS,
  BLOCK_DURATION_MS,
  recordFailure,
  resetAttempts,
  getStatus,
  formatRemainingMs,
};