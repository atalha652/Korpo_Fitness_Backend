/**
 * OpenRouter Streaming Controller
 * Handles streaming chat requests with audio and text input support
 */

import { createStreamingChatCompletion } from '../../services/openrouter/openRouterService.js';

/**
 * POST /api/openrouter/chat/stream
 * Streaming chat endpoint that supports both audio and text input
 * Simplified payload: only requires 'message' field
 * Always uses model: google/gemini-3-flash-preview
 * Returns streaming response with input/output tokens
 */
export async function streamChatController(req, res) {
  try {
    const { message } = req.body;

    console.log('📥 Received request:', {
      hasMessage: !!message,
      messageType: typeof message,
      messagePreview: typeof message === 'string' ? message.substring(0, 50) : 'object',
      hasAudio: typeof message === 'object' && !!message.audio,
      hasText: typeof message === 'object' && !!message.text,
      audioFormat: typeof message === 'object' ? message.audioFormat : null,
    });

    // Validation - message can be string or object
    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Message is required. Can be a string or object with text/audio properties.',
      });
    }

    // Convert single message to messages array format
    let processedMessage;
    
    if (typeof message === 'string') {
      // Simple text message
      processedMessage = {
        role: 'user',
        content: message,
      };
    } else if (typeof message === 'object') {
      // Object with text, audio, or both
      if (!message.text && !message.audio && !message.content) {
        return res.status(400).json({
          success: false,
          error: 'Message object must have text, audio, or content property',
        });
      }
      
      processedMessage = {
        role: 'user',
        ...message,
      };
      
      // If content is provided, use it; otherwise construct from text/audio
      if (!processedMessage.content) {
        if (processedMessage.text && processedMessage.audio) {
          // Both text and audio
          processedMessage.text = processedMessage.text;
          processedMessage.audio = processedMessage.audio;
        } else if (processedMessage.text) {
          processedMessage.content = processedMessage.text;
        }
        // If only audio, it will be handled by the service
      }
    } else {
      return res.status(400).json({
        success: false,
        error: 'Message must be a string or object',
      });
    }

    // Set up headers for plain text streaming
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    let finalUsage = null;
    let responseId = null;
    let responseModel = null;

    // Always use google/gemini-3-flash-preview model
    const model = 'google/gemini-3-flash-preview';

    // Handle streaming with onChunk callback
    const result = await createStreamingChatCompletion({
      messages: [processedMessage],
      model: model,
      options: {},
      onChunk: (chunk) => {
        // Send only the actual content text
        if (chunk.content) {
          res.write(chunk.content);
        }

        // Store usage if available
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }
      },
    });

    // Get final usage from result if not captured in chunks
    if (!finalUsage && result.usage) {
      finalUsage = result.usage;
    }
    if (result.id) responseId = result.id;
    if (result.model) responseModel = result.model;

    // Send usage information at the end as JSON
    const finalUsageData = finalUsage || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    
    const usageData = {
      inputTokens: finalUsageData.promptTokens || finalUsageData.inputTokens || 0,
      outputTokens: finalUsageData.completionTokens || finalUsageData.outputTokens || 0,
      totalTokens: finalUsageData.totalTokens || 0,
    };
    
    // Append usage JSON at the end
    res.write(`\n\n${JSON.stringify(usageData)}`);
    res.end();

  } catch (error) {
    console.error('🔥 Error in streaming chat:', error);
    
    // Send error as plain text
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
    
    res.write(`Error: ${error.message}`);
    res.end();
  }
}

