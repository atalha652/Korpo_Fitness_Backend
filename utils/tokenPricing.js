/**
 * OpenAI Token Pricing Constants
 * These are official prices for token cost calculations
 * 
 * Source: OpenAI pricing as of January 2026
 * Updated: Jan 21, 2026 (latest official pricing)
 * Reference: https://openai.com/api/pricing/ & https://platform.openai.com/docs/pricing
 */

// Pricing per 1M tokens (convert to per 1K for calculation)
export const TOKEN_PRICING = {
  // GPT-4o - Most capable model (Jan 2026)
  'gpt-4o': {
    inputPerK: 2.50,       // $2.50 per 1M tokens = $0.0025 per 1K tokens
    outputPerK: 10.00,     // $10.00 per 1M tokens = $0.01 per 1K tokens
    description: 'GPT-4o - Best at following complex instructions (Jan 2026)'
  },

  // GPT-4o Mini - Fast and affordable (Jan 2026)
  'gpt-4o-mini': {
    inputPerK: 0.15,       // $0.15 per 1M tokens = $0.00015 per 1K tokens
    outputPerK: 0.60,      // $0.60 per 1M tokens = $0.0006 per 1K tokens
    description: 'GPT-4o Mini - Fast and affordable for data processing (Jan 2026)'
  },

  // Text-to-Speech (TTS-1) - Real-time TTS model (Jan 2026)
  'tts-1': {
    inputPerK: 0.00,       // $0 per 1K input tokens (TTS charges per character, not tokens)
    outputPerK: 15.00,     // $15.00 per 1M characters = $0.015 per 1K characters
    description: 'TTS-1 - Real-time text-to-speech model (Jan 2026)',
    charBased: true        // Flag to indicate this model charges per character
  },

  // Whisper-1 - Speech-to-text transcription model (Jan 2026)
  'whisper-1': {
    inputPerK: 0.02,       // $0.02 per 1M input tokens = $0.00002 per 1K tokens
    outputPerK: 0.00,      // No output token cost
    description: 'Whisper-1 - Speech-to-text transcription model (Jan 2026)',
    audioBased: true       // Flag to indicate this model charges per audio minute
  }
};

/**
 * Calculate cost of API call based on tokens used
 * 
 * @param {string} model - Model name (gpt-4o, gpt-4o-mini)
 * @param {number} promptTokens - Number of input tokens
 * @param {number} completionTokens - Number of output tokens
 * @returns {number} Cost in USD (rounded to 4 decimal places)
 */
export function calculateTokenCost(model, promptTokens, completionTokens) {
  const pricing = TOKEN_PRICING[model];
  
  if (!pricing) {
    throw new Error(`Unknown model: ${model}`);
  }

  // Calculate cost: (inputTokens / 1000) * inputPrice + (outputTokens / 1000) * outputPrice
  const inputCost = (promptTokens / 1000) * pricing.inputPerK;
  const outputCost = (completionTokens / 1000) * pricing.outputPerK;
  const totalCost = inputCost + outputCost;

  // Round to 4 decimal places to avoid floating point issues
  return Math.round(totalCost * 10000) / 10000;
}

/**
 * Get all supported models
 * @returns {Array<string>} List of model names
 */
export function getSupportedModels() {
  return Object.keys(TOKEN_PRICING);
}
