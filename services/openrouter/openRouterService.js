/**
 * OpenRouter Service
 * Handles all interactions with OpenRouter API
 * Model: google/gemini-3-flash-preview
 */

import dotenv from 'dotenv';
dotenv.config();

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'google/gemini-3-flash-preview';

/**
 * Get OpenRouter API key from environment
 */
function getApiKey() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set in environment variables');
  }
  return apiKey;
}

/**
 * Fetch user credit balance from OpenRouter
 * @returns {Promise<Object>} Credit information
 */
export async function fetchUserCredits() {
  try {
    const response = await fetch(`${OPENROUTER_API_URL}/auth/key`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return {
      success: true,
      credits: data.data?.credits || 0,
      usage: data.data?.usage || {},
      limit: data.data?.limit || null,
    };
  } catch (error) {
    console.error('Error fetching OpenRouter credits:', error);
    throw error;
  }
}

/**
 * Fetch account credits from OpenRouter
 * Uses the /credits endpoint to get remaining credits
 * @param {string} apiKey - OpenRouter API key (optional, uses env if not provided)
 * @returns {Promise<Object>} Credit information
 */
export async function fetchAccountCredits(apiKey = null) {
  try {
    const keyToUse = apiKey || getApiKey();
    
    if (!keyToUse) {
      throw new Error('OpenRouter API key is required');
    }

    const response = await fetch(`${OPENROUTER_API_URL}/credits`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${keyToUse.trim()}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // Log response for debugging
    console.log('OpenRouter Credits API Response:', JSON.stringify(data, null, 2));
    
    // Try different possible response structures
    let credits = 0;
    
    // Check various possible paths for credits
    if (data.data !== undefined) {
      // If data exists, check multiple possible fields
      // OpenRouter /credits endpoint returns total_credits
      credits = data.data.total_credits ?? 
                data.data.credits ?? 
                data.data.balance ?? 
                data.data.remaining ?? 
                data.data.credit_balance ??
                (typeof data.data === 'number' ? data.data : 0);
    } else if (data.total_credits !== undefined) {
      // Direct total_credits field
      credits = data.total_credits;
    } else if (data.credits !== undefined) {
      // Direct credits field
      credits = data.credits;
    } else if (typeof data === 'number') {
      // Response might be a direct number
      credits = data;
    } else if (Array.isArray(data) && data.length > 0) {
      // Response might be an array
      credits = data[0]?.total_credits ?? data[0]?.credits ?? data[0]?.balance ?? 0;
    }
    
    // Extract total_usage if available
    const totalUsage = data.data?.total_usage ?? data.total_usage ?? 0;
    
    // Calculate remaining tokens based on credits
    // $1.30 per 1M tokens, so: credits / 1.30 * 1,000,000
    const PRICE_PER_M_TOKEN = 1.30;
    const creditsAmount = typeof credits === 'number' ? credits : 0;
    const remainingTokens = creditsAmount > 0 
      ? Math.floor((creditsAmount / PRICE_PER_M_TOKEN) * 1000000)
      : 0;
    
    return {
      success: true,
      credits: creditsAmount,
      totalUsage: typeof totalUsage === 'number' ? totalUsage : 0,
      remainingTokens: remainingTokens,
      pricePerMToken: PRICE_PER_M_TOKEN,
      rawResponse: data,
    };
  } catch (error) {
    console.error('Error fetching OpenRouter account credits:', error);
    throw error;
  }
}

/**
 * Get model information from OpenRouter
 * @param {string} modelId - Model identifier (default: google/gemini-3-flash-preview)
 * @returns {Promise<Object>} Model information
 */
export async function getModelInfo(modelId = DEFAULT_MODEL) {
  try {
    const response = await fetch(`${OPENROUTER_API_URL}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const model = data.data?.find(m => m.id === modelId);
    
    if (!model) {
      throw new Error(`Model ${modelId} not found`);
    }

    return {
      success: true,
      model: {
        id: model.id,
        name: model.name,
        description: model.description,
        pricing: model.pricing,
        context_length: model.context_length,
        architecture: model.architecture,
      },
    };
  } catch (error) {
    console.error('Error fetching model info:', error);
    throw error;
  }
}

/**
 * Make a chat completion request to OpenRouter
 * @param {Object} params - Request parameters
 * @param {Array} params.messages - Array of message objects
 * @param {string} params.model - Model identifier (default: google/gemini-3-flash-preview)
 * @param {Object} params.options - Additional options (temperature, max_tokens, etc.)
 * @returns {Promise<Object>} Completion response with usage information
 */
export async function createChatCompletion({ 
  messages, 
  model = DEFAULT_MODEL, 
  options = {} 
}) {
  try {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new Error('Messages array is required and must not be empty');
    }

    // Validate message structure
    for (const msg of messages) {
      if (!msg.role || !msg.content) {
        throw new Error('Each message must have role and content');
      }
      if (!['system', 'user', 'assistant'].includes(msg.role)) {
        throw new Error(`Invalid message role: ${msg.role}`);
      }
    }

    const requestBody = {
      model,
      messages,
      ...options,
    };

    const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // Extract usage information
    const usage = data.usage || {};
    
    return {
      success: true,
      id: data.id,
      model: data.model,
      choices: data.choices,
      usage: {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        // OpenRouter specific fields
        promptTokensDetails: usage.prompt_tokens_details || {},
        completionTokensDetails: usage.completion_tokens_details || {},
      },
      response: data,
    };
  } catch (error) {
    console.error('Error creating chat completion:', error);
    throw error;
  }
}

export { DEFAULT_MODEL, OPENROUTER_API_URL };

