/**
 * Centralized Limits Configuration
 * 
 * This file contains all hardcoded limits for easy management.
 * Update these values to change limits across the entire application.
 */

// ============ TOKEN LIMITS CONFIGURATION ============
// Based on your tier specifications:
// Free: 1,000,000 daily, 50,000 max/request, 500-1,000 requests/minute
// Premier: 3,000,000 daily, 100,000 max/request, 2,000-5,000 requests/minute
export const TOKEN_LIMITS = {
  free: {
    chatTokensDaily: 1000000,    // 1M tokens per day
    chatTokensMonthly: 30000000, // 30M tokens per month (1M * 30 days)
    maxTokensPerRequest: 50000,  // 50K tokens per request
    maxRequestsPerMinute: 1000,  // 1,000 requests per minute (upper bound)
    description: 'Free tier - 1M daily tokens, 50K per request, 1K req/min'
  },
  premier: {
    chatTokensDaily: 3000000,    // 3M tokens per day  
    chatTokensMonthly: 90000000, // 90M tokens per month (3M * 30 days)
    maxTokensPerRequest: 100000, // 100K tokens per request
    maxRequestsPerMinute: 5000,  // 5,000 requests per minute (upper bound)
    description: 'Premier tier - 3M daily tokens, 100K per request, 5K req/min'
  }
};

// ============ HELPER FUNCTIONS ============

/**
 * Get limits for a specific plan
 * @param {string} plan - User plan ('free' or 'premier')
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