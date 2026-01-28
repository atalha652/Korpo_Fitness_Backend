/**
 * Centralized Limits Configuration
 * 
 * This file contains all hardcoded limits for easy management.
 * Update these values to change limits across the entire application.
 */

// ============ TOKEN LIMITS CONFIGURATION ============
// Updated: Both Free and premium users now have 1M daily tokens
// Added: Request limits for voice and chat features
// IMPORTANT: All daily limits reset at 12:00 AM UTC automatically
export const TOKEN_LIMITS = {
  free: {
    chatTokensDaily: 1000000,    // 1M tokens per day
    chatTokensMonthly: 30000000, // 30M tokens per month (1M * 30 days)
    maxTokensPerRequest: 50000,  // 50K tokens per request
    maxRequestsPerMinute: 1000,  // 1,000 requests per minute (upper bound)
    // Request limits per day
    voiceRequestsDaily: 10,      // 10 voice requests per day
    chatRequestsDaily: 20,       // 20 chat requests per day
    description: 'Free tier - 1M daily tokens, 10 voice/20 chat requests per day'
  },
  premium: {
    chatTokensDaily: 1000000,    // 1M tokens per day (updated from 3M)
    chatTokensMonthly: 30000000, // 30M tokens per month (1M * 30 days, updated from 90M)
    maxTokensPerRequest: 100000, // 100K tokens per request
    maxRequestsPerMinute: 5000,  // 5,000 requests per minute (upper bound)
    // Request limits per day
    voiceRequestsDaily: 20,      // 20 voice requests per day
    chatRequestsDaily: 40,       // 40 chat requests per day
    description: 'Premium tier - 1M daily tokens, 20 voice/40 chat requests per day'
  }
};

// ============ HELPER FUNCTIONS ============

/**
 * Get limits for a specific plan
 * @param {string} plan - User plan ('free' or 'premium')
 * @returns {Object} Limits configuration
 */
export function getLimitsForPlan(plan = 'free') {
  const normalizedPlan = plan.toLowerCase();
  return TOKEN_LIMITS[normalizedPlan] || TOKEN_LIMITS.free;
}

/**
 * Get all available plans and their limits
 * @returns {Object} All plans with their limits
 */
export function getAllLimits() {
  return TOKEN_LIMITS;
}

/**
 * Check if a plan exists
 * @param {string} plan - Plan name to check
 * @returns {boolean} True if plan exists
 */
export function isValidPlan(plan) {
  return Object.keys(TOKEN_LIMITS).includes(plan.toLowerCase());
}

/**
 * Get formatted limits summary for display
 * @param {string} plan - User plan
 * @returns {string} Formatted limits description
 */
export function getLimitsSummary(plan) {
  const limits = getLimitsForPlan(plan);
  return `${limits.description}: ${limits.chatTokensDaily.toLocaleString()} daily, ${limits.chatTokensMonthly.toLocaleString()} monthly tokens`;
}

// ============ ADMIN FUNCTIONS ============

/**
 * Log current limits configuration (for debugging)
 */
export function logCurrentLimits() {
  console.log('📊 Current Token Limits Configuration:');
  Object.entries(TOKEN_LIMITS).forEach(([plan, limits]) => {
    console.log(`  ${plan.toUpperCase()}:`);
    console.log(`    Daily: ${limits.chatTokensDaily.toLocaleString()} tokens`);
    console.log(`    Monthly: ${limits.chatTokensMonthly.toLocaleString()} tokens`);
    console.log(`    Description: ${limits.description}`);
  });
}

/**
 * Get max tokens per request for a plan
 * @param {string} plan - User plan
 * @returns {number} Max tokens per request
 */
export function getMaxTokensPerRequest(plan = 'free') {
  const limits = getLimitsForPlan(plan);
  return limits.maxTokensPerRequest;
}

/**
 * Get max requests per minute for a plan
 * @param {string} plan - User plan
 * @returns {number} Max requests per minute
 */
export function getMaxRequestsPerMinute(plan = 'free') {
  const limits = getLimitsForPlan(plan);
  return limits.maxRequestsPerMinute;
}

/**
 * Get daily voice request limit for a plan
 * @param {string} plan - User plan
 * @returns {number} Max voice requests per day
 */
export function getVoiceRequestsDaily(plan = 'free') {
  const limits = getLimitsForPlan(plan);
  return limits.voiceRequestsDaily;
}

/**
 * Get daily chat request limit for a plan
 * @param {string} plan - User plan
 * @returns {number} Max chat requests per day
 */
export function getChatRequestsDaily(plan = 'free') {
  const limits = getLimitsForPlan(plan);
  return limits.chatRequestsDaily;
}

/**
 * Validate if a request is within limits
 * @param {string} plan - User plan
 * @param {number} requestTokens - Tokens in this request
 * @param {number} dailyUsed - Tokens used today
 * @param {number} requestsThisMinute - Requests in current minute
 * @returns {Object} { allowed: boolean, reason?: string, limits: Object }
 */
export function validateRequestLimits(plan, requestTokens, dailyUsed = 0, requestsThisMinute = 0) {
  const limits = getLimitsForPlan(plan);
  
  // Check daily limit
  if (dailyUsed + requestTokens > limits.chatTokensDaily) {
    return {
      allowed: false,
      reason: `Daily limit would be exceeded (${dailyUsed + requestTokens}/${limits.chatTokensDaily} tokens)`,
      limits
    };
  }
  
  // Check per-request limit
  if (requestTokens > limits.maxTokensPerRequest) {
    return {
      allowed: false,
      reason: `Request too large (${requestTokens}/${limits.maxTokensPerRequest} tokens)`,
      limits
    };
  }
  
  // Check rate limit
  if (requestsThisMinute >= limits.maxRequestsPerMinute) {
    return {
      allowed: false,
      reason: `Rate limit exceeded (${requestsThisMinute}/${limits.maxRequestsPerMinute} requests/minute)`,
      limits
    };
  }
  
  return {
    allowed: true,
    limits
  };
}