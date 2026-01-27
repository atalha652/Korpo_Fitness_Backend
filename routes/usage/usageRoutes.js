/**
 * Usage Tracking Routes
 * 
 * API endpoints for:
 * - Tracking token usage from frontend
 * - Checking current usage and limits
 * - Enforcing rate limits
 */

import express from 'express';
import { verifyFirebaseToken } from '../../middleware/firebaseAuthMiddleware.js';
import {
  getUsageSummary,
  checkCanUseTokens,
  recordTokenUsage,
  validateTokenReport,
  getUserLimits,
  getMonthlyUsage
} from '../../services/usageService.js';

const router = express.Router();

/**
 * GET /usage/summary
 * 
 * Returns user's current token usage and limits
 * 
 * Response:
 * {
 *   plan: "free" | "premier",
 *   dailyUsed: 1250,
 *   dailyLimit: 1000000,
 *   monthlyUsed: 15000,
 *   monthlyLimit: 30000000,
 *   totalCostUSD: 45.32,
 *   month: "2025-01",
 *   lastReportedAt: "2025-01-21T10:30:00Z"
 * }
 */
router.get('/summary', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;

    const summary = await getUsageSummary(uid);

    res.json({
      success: true,
      data: summary
    });

  } catch (error) {
    console.error('🔥 Error getting usage summary:', error.message);

    if (error.message === 'User not found') {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    res.status(500).json({
      error: 'Failed to get usage summary',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /usage/can-use
 * 
 * Checks if user can still use tokens (before making API call)
 * Uses hardcoded limits and checks against usage collection by uid
 * 
 * Response:
 * {
 *   success: true,
 *   data: {
 *     allowed: true,
 *     remainingDailyTokens: 998750,
 *     remainingMonthlyTokens: 29985000,
 *     dailyUsed: 1250,
 *     monthlyUsed: 15000,
 *     dailyLimit: 1000000,
 *     monthlyLimit: 30000000,
 *     plan: "free",
 *     reason: null // Only present if not allowed
 *   }
 * }
 */
router.get('/can-use', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;

    const result = await checkCanUseTokens(uid);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('🔥 Error checking can use tokens:', error.message);

    if (error.message === 'User not found') {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    res.status(500).json({
      error: 'Failed to check token availability',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /usage/report
 * 
 * Records token usage from frontend after API call
 * Called by frontend after each OpenAI API call
 * 
 * Request body:
 * {
 *   model: "gpt-4o" | "gpt-4o-mini",
 *   promptTokens: 150,
 *   completionTokens: 425,
 *   timestamp: "2025-01-21T10:30:45Z"
 * }
 * 
 * Response on success:
 * {
 *   success: true,
 *   message: "Token usage recorded",
 *   data: {
 *     tokensAdded: 575,
 *     costAdded: 0.0092,
 *     newDailyTotal: 1825,
 *     newMonthlyTotal: 15575
 *   }
 * }
 * 
 * Response on error:
 * {
 *   error: "Daily limit exceeded...",
 *   code: "DAILY_LIMIT_EXCEEDED",
 *   statusCode: 429
 * }
 */
router.post('/report', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { model, promptTokens, completionTokens, timestamp } = req.body;

    // ============ VALIDATION ============
    
    // Validate request body
    const validation = validateTokenReport({
      model,
      promptTokens,
      completionTokens,
      timestamp
    });

    if (!validation.valid) {
      return res.status(400).json({
        error: validation.error,
        code: 'INVALID_REQUEST'
      });
    }

    // Get user limits
    const userLimits = await getUserLimits(uid);
    const { chatTokensDaily, chatTokensMonthly } = userLimits.limits;

    // ============ RECORD USAGE ============

    const result = await recordTokenUsage(
      uid,
      { model, promptTokens, completionTokens, timestamp },
      chatTokensDaily,
      chatTokensMonthly
    );

    res.status(201).json({
      success: true,
      message: 'Token usage recorded',
      data: result
    });

  } catch (error) {
    console.error('🔥 Error reporting token usage:', error.message);

    // Handle specific error codes
    if (error.code === 'DAILY_LIMIT_EXCEEDED') {
      return res.status(429).json({
        error: error.message,
        code: 'DAILY_LIMIT_EXCEEDED'
      });
    }

    if (error.code === 'MONTHLY_LIMIT_EXCEEDED') {
      return res.status(429).json({
        error: error.message,
        code: 'MONTHLY_LIMIT_EXCEEDED'
      });
    }

    if (error.code === 'DUPLICATE_REPORT') {
      return res.status(400).json({
        error: error.message,
        code: 'DUPLICATE_REPORT'
      });
    }

    if (error.message === 'User not found') {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    res.status(500).json({
      error: 'Failed to record token usage',
      code: 'INTERNAL_ERROR'
    });
  }
});

export default router;
