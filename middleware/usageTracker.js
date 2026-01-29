/**
 * Usage Tracking Middleware
 * Automatically tracks API usage costs for billing
 */

import { trackApiUsage } from '../services/stripe/subscriptionService.js';

/**
 * Middleware to track API usage after successful API calls
 * Add this after your API call processing
 */
export function trackUsageMiddleware(req, res, next) {
  // Store original res.json to intercept successful responses
  const originalJson = res.json;
  
  res.json = function(data) {
    // Only track usage for successful responses
    if (res.statusCode >= 200 && res.statusCode < 300) {
      // Extract usage cost from response or request
      const cost = req.apiUsageCost || data.cost || 0;
      const userId = req.user?.uid;
      
      if (userId && cost > 0) {
        // Track usage asynchronously (don't block response)
        trackApiUsage(userId, cost).catch(error => {
          console.error('Failed to track usage:', error);
        });
      }
    }
    
    // Call original json method
    return originalJson.call(this, data);
  };
  
  next();
}

/**
 * Helper function to calculate and set API usage cost
 * Call this in your API route handlers before sending response
 */
export function setApiUsageCost(req, cost) {
  req.apiUsageCost = cost;
}

/**
 * Calculate cost based on token usage
 * Use this for OpenAI API calls
 */
export function calculateTokenCost(inputTokens, outputTokens, model = 'gpt-4') {
  // Token pricing (adjust based on your actual costs)
  const pricing = {
    'gpt-4': {
      input: 0.03 / 1000,  // $0.03 per 1K input tokens
      output: 0.06 / 1000  // $0.06 per 1K output tokens
    },
    'gpt-3.5-turbo': {
      input: 0.001 / 1000, // $0.001 per 1K input tokens
      output: 0.002 / 1000 // $0.002 per 1K output tokens
    }
  };
  
  const modelPricing = pricing[model] || pricing['gpt-4'];
  const inputCost = inputTokens * modelPricing.input;
  const outputCost = outputTokens * modelPricing.output;
  
  return inputCost + outputCost;
}