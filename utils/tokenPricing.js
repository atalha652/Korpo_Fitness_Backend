/**
 * OpenAI Token Pricing Constants
 * These are official prices for token cost calculations
 * 
 * Source: OpenAI pricing as of January 2026
 * Updated: Jan 27, 2026 (latest official pricing)
 * Reference: https://openai.com/api/pricing/ & https://platform.openai.com/docs/pricing
 */

import { TOKEN_LIMITS, getLimitsForPlan } from './limitsConfig.js';

// Pricing per 1M tokens (convert to per 1K for calculation)
export const TOKEN_PRICING = {
  // GPT-4o Mini - Cheapest general GPT-4o model (Jan 2026)
  'gpt-4o-mini': {
    inputPerK: 0.15,       // $0.15 per 1M tokens = $0.00015 per 1K tokens
    cachedPerK: 0.075,     // $0.075 per 1M tokens = $0.000075 per 1K tokens (cached input)
    outputPerK: 0.60,      // $0.60 per 1M tokens = $0.0006 per 1K tokens
    description: 'Cheapest general GPT-4o model (OpenAI Platform)',
    unit: 'tokens'
  },

  // GPT-4o Mini Transcribe - Speech-to-text (Jan 2026)
  'gpt-4o-mini-transcribe': {
    inputPerK: 1.25,       // $1.25 per 1M tokens = $0.00125 per 1K tokens (audio input → text)
    outputPerK: 5.00,      // $5.00 per 1M tokens = $0.005 per 1K tokens
    description: 'Speech-to-text (audio input → text) (OpenAI Platform)',
    audioBased: true,      // Flag to indicate this model processes audio
    unit: 'tokens & minutes' // Billing unit
  },

  // Text-to-Speech (TTS-1) - Basic text-to-speech audio generation (Jan 2026)
  'tts-1': {
    inputPerK: 0.00,       // $0 per 1K input tokens (TTS charges per output tokens only)
    outputPerK: 15.00,     // $15.00 per 1M tokens = $0.015 per 1K tokens
    description: 'Basic text-to-speech audio generation (OpenAI Platform)',
    unit: 'tokens'         // Billing unit
  },

  // Whisper-1 - Legacy model mapped to gpt-4o-mini-transcribe pricing (Jan 2026)
  'whisper-1': {
    inputPerK: 1.25,       // Map to gpt-4o-mini-transcribe pricing
    outputPerK: 5.00,      // Map to gpt-4o-mini-transcribe pricing
    description: 'Legacy model, mapped to gpt-4o-mini-transcribe pricing',
    audioBased: true,      // Flag to indicate this model processes audio
    unit: 'tokens & minutes', // Billing unit
    deprecated: true       // Flag to indicate this is legacy
  }
};

/**
 * Calculate cost of API call based on tokens used
 * 
 * @param {string} model - Model name (gpt-4o-mini, gpt-4o-mini-transcribe, tts-1, whisper-1)
 * @param {number} promptTokens - Number of input tokens
 * @param {number} completionTokens - Number of output tokens
 * @param {number} cachedTokens - Number of cached input tokens (optional, for gpt-4o-mini)
 * @returns {number} Cost in USD (rounded to 4 decimal places)
 */
export function calculateTokenCost(model, promptTokens, completionTokens, cachedTokens = 0) {
  const pricing = TOKEN_PRICING[model];
  
  if (!pricing) {
    throw new Error(`Unknown model: ${model}`);
  }

  let inputCost = 0;
  let outputCost = 0;

  // Handle cached tokens for gpt-4o-mini
  if (model === 'gpt-4o-mini' && cachedTokens > 0) {
    const regularInputTokens = Math.max(0, promptTokens - cachedTokens);
    inputCost = (regularInputTokens / 1000) * pricing.inputPerK + (cachedTokens / 1000) * pricing.cachedPerK;
  } else {
    // Standard input cost calculation
    inputCost = (promptTokens / 1000) * pricing.inputPerK;
  }

  // Output cost calculation
  outputCost = (completionTokens / 1000) * pricing.outputPerK;
  
  const totalCost = inputCost + outputCost;

  // Round to 4 decimal places to avoid floating point issues
  return Math.round(totalCost * 10000) / 10000;
}

/**
 * User Tier Limits Configuration
 * Daily limits reset at 12:00 AM (midnight) UTC
 * 
 * Tier Structure:
 * - Free: 1,000,000 daily tokens, 50,000 max per request, 500-1,000 requests/minute
 * - Premier: 3,000,000 daily tokens, 100,000 max per request, 2,000-5,000 requests/minute
 */
export const USER_TIER_LIMITS = TOKEN_LIMITS;

/**
 * Get user tier limits based on plan
 * @param {string} tier - User tier ('free' or 'premier')
 * @returns {Object} Tier limits configuration
 */
export function getTierLimits(tier = 'free') {
  return getLimitsForPlan(tier);
}

/**
 * Check if user can make a request based on tier limits
 * @param {string} tier - User tier ('free' or 'premier')
 * @param {number} requestTokens - Tokens in the current request
 * @param {number} dailyUsedTokens - Tokens already used today
 * @param {number} requestsThisMinute - Number of requests made in current minute (optional)
 * @returns {Object} { allowed: boolean, reason?: string, limits: Object }
 */
export function checkTierLimits(tier, requestTokens, dailyUsedTokens, requestsThisMinute = 0) {
  const limits = getTierLimits(tier);
  
  // Check if request exceeds max tokens per request
  if (requestTokens > limits.maxTokensPerRequest) {
    return {
      allowed: false,
      reason: `Request exceeds maximum tokens per request (${limits.maxTokensPerRequest.toLocaleString()})`,
      limits
    };
  }
  
  // Check if request would exceed daily limit
  if (dailyUsedTokens + requestTokens > limits.chatTokensDaily) {
    return {
      allowed: false,
      reason: `Request would exceed daily limit (${limits.chatTokensDaily.toLocaleString()})`,
      limits
    };
  }
  
  // Check requests per minute limit (if provided)
  if (requestsThisMinute >= limits.maxRequestsPerMinute) {
    return {
      allowed: false,
      reason: `Exceeded maximum requests per minute (${limits.maxRequestsPerMinute.toLocaleString()})`,
      limits
    };
  }
  
  return {
    allowed: true,
    limits
  };
}

/**
 * Get tier summary for display
 * @param {string} tier - User tier ('free' or 'premier')
 * @returns {Object} Formatted tier information
 */
export function getTierSummary(tier) {
  const limits = getTierLimits(tier);
  
  return {
    tier: tier.toLowerCase(),
    dailyLimit: limits.chatTokensDaily.toLocaleString(),
    maxTokensPerRequest: limits.maxTokensPerRequest.toLocaleString(),
    requestsPerMinute: limits.maxRequestsPerMinute.toLocaleString(),
    resetTime: '12:00 AM UTC',
    description: limits.description
  };
}

/**
 * Get remaining tokens for today based on tier
 * @param {string} tier - User tier ('free' or 'premier')
 * @param {number} dailyUsedTokens - Tokens already used today
 * @returns {number} Remaining tokens for today
 */
export function getRemainingDailyTokens(tier, dailyUsedTokens) {
  const limits = getTierLimits(tier);
  return Math.max(0, limits.chatTokensDaily - dailyUsedTokens);
}

/**
 * Check if it's time to reset daily usage (12:00 AM UTC)
 * @param {string} lastResetDate - Last reset date in YYYY-MM-DD format
 * @returns {boolean} True if daily usage should be reset
 */
export function shouldResetDailyUsage(lastResetDate) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  return lastResetDate !== today;
}

/**
 * Get all supported models
 * @returns {Array<string>} List of model names
 */
export function getSupportedModels() {
  return Object.keys(TOKEN_PRICING);
}
