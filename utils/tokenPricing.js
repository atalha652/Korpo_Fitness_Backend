/**
 * Token Pricing Utility
 * Implements blended token pricing for B2C users
 * 
 * Internal Cost Blending:
 * - Input: 60% @ $0.50/1M = $0.30
 * - Output: 30% @ $3.00/1M = $0.90
 * - Audio: 10% @ $1.00/1M = $0.10
 * - Blended Cost: $1.30/1M tokens
 * 
 * User-Facing Price: $2.60/1M tokens
 */

// Internal cost blending constants
const INTERNAL_COSTS = {
  INPUT_RATE: 0.50,      // $0.50 per 1M input tokens
  OUTPUT_RATE: 3.00,     // $3.00 per 1M output tokens
  AUDIO_RATE: 1.00,      // $1.00 per 1M audio tokens
  PLATFORM_FEE: 7.00,    // $7.00 platform fee
};

// Usage mix assumptions (internal only)
const USAGE_MIX = {
  INPUT_PERCENTAGE: 0.60,   // 60% input tokens
  OUTPUT_PERCENTAGE: 0.30,  // 30% output tokens
  AUDIO_PERCENTAGE: 0.10,   // 10% audio tokens
};

// Calculate blended internal cost per 1M tokens
const BLENDED_COST_PER_M = 
  (USAGE_MIX.INPUT_PERCENTAGE * INTERNAL_COSTS.INPUT_RATE) +
  (USAGE_MIX.OUTPUT_PERCENTAGE * INTERNAL_COSTS.OUTPUT_RATE) +
  (USAGE_MIX.AUDIO_PERCENTAGE * INTERNAL_COSTS.AUDIO_RATE);

// User-facing price per 1M tokens (blended cost, no margin)
export const PRICE_PER_M_TOKEN = 1.30; // $1.30 per 1M tokens (blended cost)

/**
 * Calculate total price for a given number of tokens
 * Platform fee is conditionally added based on user's payment history
 * @param {number} tokens - Number of tokens
 * @param {boolean} platformFeeRequired - Whether platform fee is required (default: true)
 * @returns {Object} Price breakdown
 */
export function calculateTokenPrice(tokens, platformFeeRequired = true) {
  if (!tokens || tokens <= 0) {
    return {
      tokenPrice: 0,
      platformFee: platformFeeRequired ? INTERNAL_COSTS.PLATFORM_FEE : 0,
      totalPrice: platformFeeRequired ? INTERNAL_COSTS.PLATFORM_FEE : 0,
      platformFeeRequired,
    };
  }
  const tokensInMillions = tokens / 1000000;
  const tokenPrice = tokensInMillions * PRICE_PER_M_TOKEN;
  const platformFee = platformFeeRequired ? INTERNAL_COSTS.PLATFORM_FEE : 0;
  const totalPrice = tokenPrice + platformFee;
  
  return {
    tokenPrice: parseFloat(tokenPrice.toFixed(2)),
    platformFee: parseFloat(platformFee.toFixed(2)),
    totalPrice: parseFloat(totalPrice.toFixed(2)),
    platformFeeRequired,
    tokens,
    tokensInMillions: parseFloat(tokensInMillions.toFixed(2)),
  };
}

/**
 * Calculate tokens from total price (reverse calculation)
 * Excludes platform fee from calculation
 * @param {number} totalPrice - Total price in dollars (including platform fee)
 * @returns {number} Number of tokens
 */
export function calculateTokensFromPrice(totalPrice) {
  if (!totalPrice || totalPrice <= 0) {
    return 0;
  }
  // Subtract platform fee first
  const tokenPrice = totalPrice - INTERNAL_COSTS.PLATFORM_FEE;
  if (tokenPrice <= 0) {
    return 0;
  }
  const tokensInMillions = tokenPrice / PRICE_PER_M_TOKEN;
  return Math.floor(tokensInMillions * 1000000);
}

/**
 * Validate token quantity and total price match
 * Backend validation to prevent manipulation
 * @param {number} tokens - Number of tokens
 * @param {number} expectedTotalPrice - Expected total price in dollars (including platform fee if required)
 * @param {boolean} platformFeeRequired - Whether platform fee is required
 * @returns {Object} Validation result
 */
export function validateTokenPrice(tokens, expectedTotalPrice, platformFeeRequired = true) {
  const calculated = calculateTokenPrice(tokens, platformFeeRequired);
  const priceDifference = Math.abs(calculated.totalPrice - expectedTotalPrice);
  const tolerance = 0.01; // Allow 1 cent tolerance for rounding

  return {
    isValid: priceDifference <= tolerance,
    calculatedTotalPrice: calculated.totalPrice,
    calculatedTokenPrice: calculated.tokenPrice,
    calculatedPlatformFee: calculated.platformFee,
    platformFeeRequired: calculated.platformFeeRequired,
    expectedTotalPrice,
    difference: priceDifference,
    tokens,
  };
}

/**
 * Calculate internal cost for token usage (for tracking/margins)
 * @param {Object} usage - Token usage breakdown
 * @param {number} usage.inputTokens - Input tokens used
 * @param {number} usage.outputTokens - Output tokens used
 * @param {number} usage.audioTokens - Audio tokens used
 * @returns {Object} Cost breakdown
 */
export function calculateInternalCost({ inputTokens = 0, outputTokens = 0, audioTokens = 0 }) {
  const inputCost = (inputTokens / 1000000) * INTERNAL_COSTS.INPUT_RATE;
  const outputCost = (outputTokens / 1000000) * INTERNAL_COSTS.OUTPUT_RATE;
  const audioCost = (audioTokens / 1000000) * INTERNAL_COSTS.AUDIO_RATE;
  const totalCost = inputCost + outputCost + audioCost;

  return {
    inputTokens,
    outputTokens,
    audioTokens,
    inputCost: parseFloat(inputCost.toFixed(4)),
    outputCost: parseFloat(outputCost.toFixed(4)),
    audioCost: parseFloat(audioCost.toFixed(4)),
    totalCost: parseFloat(totalCost.toFixed(4)),
    breakdown: {
      input: `${(inputTokens / 1000000).toFixed(2)}M × $${INTERNAL_COSTS.INPUT_RATE} = $${inputCost.toFixed(2)}`,
      output: `${(outputTokens / 1000000).toFixed(2)}M × $${INTERNAL_COSTS.OUTPUT_RATE} = $${outputCost.toFixed(2)}`,
      audio: `${(audioTokens / 1000000).toFixed(2)}M × $${INTERNAL_COSTS.AUDIO_RATE} = $${audioCost.toFixed(2)}`,
      total: `$${totalCost.toFixed(2)}`,
    },
  };
}

/**
 * Get token purchase limits
 * @returns {Object} Purchase limits
 */
export function getTokenLimits() {
  const minPriceCalc = calculateTokenPrice(100000);
  const maxPriceCalc = calculateTokenPrice(5000000);
  
  return {
    minTokens: 100000,      // 100K tokens minimum
    maxTokens: 5000000,     // 5M tokens maximum
    stepTokens: 100000,     // 100K token steps
    minTokenPrice: minPriceCalc.tokenPrice,
    minPlatformFee: minPriceCalc.platformFee,
    minTotalPrice: minPriceCalc.totalPrice,
    maxTokenPrice: maxPriceCalc.tokenPrice,
    maxPlatformFee: maxPriceCalc.platformFee,
    maxTotalPrice: maxPriceCalc.totalPrice,
    pricePerMToken: PRICE_PER_M_TOKEN,
    platformFee: INTERNAL_COSTS.PLATFORM_FEE,
  };
}

// Export constants for reference
export { INTERNAL_COSTS, USAGE_MIX, BLENDED_COST_PER_M };

