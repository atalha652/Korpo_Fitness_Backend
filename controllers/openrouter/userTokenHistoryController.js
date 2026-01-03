/**
 * User Token History Controller
 * Handles user requests for token history and summary
 */

import { getUserTokenHistory, getUserTokenSummary } from '../../services/openrouter/userTokenHistoryService.js';

/**
 * GET /api/users/:userId/token-history
 * Get user's token purchasing history
 */
export async function getUserHistoryController(req, res) {
  try {
    const { userId } = req.params;
    const { limit = 50 } = req.query;

    // Validation
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Valid userId is required',
      });
    }

    const limitNum = parseInt(limit);
    if (limitNum <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Limit must be greater than 0',
      });
    }

    const result = await getUserTokenHistory(userId, limitNum);

    res.json(result);
  } catch (error) {
    console.error('🔥 Error fetching user token history:', error);
    const statusCode = error.message === 'User not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
    });
  }
}

/**
 * GET /api/users/:userId/token-summary
 * Get user's token summary (totals, spending, etc)
 */
export async function getUserSummaryController(req, res) {
  try {
    const { userId } = req.params;

    // Validation
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Valid userId is required',
      });
    }

    const result = await getUserTokenSummary(userId);

    res.json(result);
  } catch (error) {
    console.error('🔥 Error fetching user token summary:', error);
    const statusCode = error.message === 'User not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
    });
  }
}
