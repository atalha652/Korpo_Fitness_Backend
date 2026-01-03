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

/**
 * Create a streaming chat completion request to OpenRouter
 * Supports both audio and text input
 * @param {Object} params - Request parameters
 * @param {Array} params.messages - Array of message objects (can include audio)
 * @param {string} params.model - Model identifier (default: google/gemini-3-flash-preview)
 * @param {Object} params.options - Additional options (temperature, max_tokens, etc.)
 * @param {Function} params.onChunk - Callback function for each chunk
 * @returns {Promise<Object>} Final response with usage information
 */
export async function createStreamingChatCompletion({ 
  messages, 
  model = DEFAULT_MODEL, 
  options = {},
  onChunk = null
}) {
  try {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new Error('Messages array is required and must not be empty');
    }

    // Process messages to handle audio and text input
    const processedMessages = messages.map(msg => {
      // If message has audio (base64 encoded), convert it to the proper format
      if (msg.audio) {
        // For Gemini models via OpenRouter, audio can be included in content array
        const contentArray = [];
        
        // Add audio if present
        if (msg.audio) {
          // Handle base64 audio - remove data URL prefix if present
          let audioData = msg.audio;
          if (audioData.startsWith('data:')) {
            const base64Match = audioData.match(/data:([^;]+);base64,(.+)/);
            if (base64Match) {
              audioData = base64Match[2];
            }
          }
          
          contentArray.push({
            type: 'input_audio',
            data: audioData,
            format: msg.audioFormat || 'wav',
          });
        }
        
        // Add text if present
        if (msg.text) {
          contentArray.push({
            type: 'text',
            text: msg.text,
          });
        }
        
        return {
          role: msg.role || 'user',
          content: contentArray,
        };
      }
      
      // If message has audio_url
      if (msg.audio_url) {
        const contentArray = [
          {
            type: 'input_audio',
            data: msg.audio_url,
          },
        ];
        
        if (msg.text) {
          contentArray.push({
            type: 'text',
            text: msg.text,
          });
        }
        
        return {
          role: msg.role || 'user',
          content: contentArray,
        };
      }
      
      // Regular text message - handle both string and array content
      if (typeof msg.content === 'string') {
        return {
          role: msg.role,
          content: msg.content,
        };
      }
      
      // If content is already an array (for multimodal)
      if (Array.isArray(msg.content)) {
        return {
          role: msg.role,
          content: msg.content,
        };
      }
      
      // Fallback
      return {
        role: msg.role,
        content: msg.content || msg.text || '',
      };
    });

    const requestBody = {
      model,
      messages: processedMessages,
      stream: true,
      ...options,
    };

    // Debug logging
    const apiKey = getApiKey();
    console.log('🔍 Debug: Making streaming request to OpenRouter');
    console.log('🔍 Debug: Model:', model);
    console.log('🔍 Debug: Messages count:', processedMessages.length);
    console.log('🔍 Debug: API Key present:', !!apiKey);
    console.log('🔍 Debug: API Key prefix:', apiKey ? apiKey.substring(0, 10) + '...' : 'N/A');

    const url = `${OPENROUTER_API_URL}/chat/completions`;
    console.log('🔍 Debug: Request URL:', url);
    console.log('🔍 Debug: Request body keys:', Object.keys(requestBody));
    
    // Make the fetch request without timeout initially - let it connect
    // The timeout will be handled by Node's default fetch timeout
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'http://localhost:5000',
        'X-Title': process.env.APP_NAME || 'Korpo AI',
      },
      body: JSON.stringify(requestBody),
    });

    console.log('✅ Debug: Got response, status:', response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Debug: Response not OK:', response.status, errorText);
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    console.log('✅ Debug: Starting to read stream...');

    // Handle streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullResponse = '';
    let usage = null;
    let responseId = null;
    let responseModel = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          console.log('✅ Debug: Stream finished');
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim() === '') continue;
          
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            
            if (data === '[DONE]') {
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              
              // Extract response metadata (keep updating to get the latest)
              if (parsed.id) responseId = parsed.id;
              if (parsed.model) responseModel = parsed.model;
              
              // Extract usage information (usually in the last chunk)
              if (parsed.usage) {
                usage = parsed.usage;
              }

              // Extract content from choices
              if (parsed.choices && parsed.choices.length > 0) {
                const choice = parsed.choices[0];
                const delta = choice.delta;
                
                if (delta && delta.content) {
                  const content = delta.content;
                  fullResponse += content;
                  
                  // Call onChunk callback if provided
                  if (onChunk) {
                    onChunk({
                      content,
                      fullContent: fullResponse,
                      finishReason: choice.finish_reason,
                      usage: parsed.usage || null,
                    });
                  }
                }
              }
            } catch (e) {
              console.warn('⚠️ Failed to parse SSE data:', e.message, 'Data:', data.substring(0, 100));
            }
          }
        }
      }

      console.log('✅ Debug: Stream processing complete. Full response length:', fullResponse.length);

      // Return final response with usage information
      return {
        success: true,
        id: responseId,
        model: responseModel || model,
        content: fullResponse,
        usage: usage ? {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          promptTokensDetails: usage.prompt_tokens_details || {},
          completionTokensDetails: usage.completion_tokens_details || {},
        } : {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
      };
    } catch (streamError) {
      console.error('❌ Debug: Stream reading error:', streamError);
      throw streamError;
    }
  } catch (error) {
    console.error('Error creating streaming chat completion:', error);
    throw error;
  }
}

export { DEFAULT_MODEL, OPENROUTER_API_URL };

