/**
 * OpenRouter Controller
 * Handles admin requests for credits management
 */

import {
  getOpenrouterStatus,
  addCreditsManually,
  getTransactionHistory,
  updateOpenrouterStatus,
  resetOpenrouterCredits,
} from '../../services/openrouter/openrouterCreditsService.js';

/**
 * GET /api/admin/openrouter/status
 * Get current openrouter credits status
 */
export async function getStatusController(req, res) {
  try {
    const status = await getOpenrouterStatus();

    res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    console.error('🔥 Error getting openrouter status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

/**
 * POST /api/admin/openrouter/add-credits
 * Admin manually adds credits
 */
export async function addCreditsController(req, res) {
  try {
    const { creditAmount } = req.body;

    // Validation
    if (!creditAmount || creditAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid creditAmount greater than 0 is required',
      });
    }

    const result = await addCreditsManually(creditAmount);

    res.json(result);
  } catch (error) {
    console.error('🔥 Error adding credits:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

/**
 * GET /api/admin/openrouter/transactions
 * Get transaction history
 */
export async function getTransactionsController(req, res) {
  try {
    const { pageSize = 50, pageNumber = 1 } = req.query;

    // Validation
    const size = parseInt(pageSize);
    const page = parseInt(pageNumber);

    if (size <= 0 || page <= 0) {
      return res.status(400).json({
        success: false,
        error: 'pageSize and pageNumber must be greater than 0',
      });
    }

    const result = await getTransactionHistory(size, page);

    res.json(result);
  } catch (error) {
    console.error('🔥 Error fetching transactions:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

/**
 * PUT /api/admin/openrouter/update
 * Manual update to credits (admin correction)
 */
export async function updateStatusController(req, res) {
  try {
    const { credit, total, wallet, used } = req.body;

    // At least one field required
    if (credit === undefined && total === undefined && wallet === undefined && used === undefined) {
      return res.status(400).json({
        success: false,
        error: 'At least one field (credit, total, wallet, used) is required',
      });
    }

    const updates = {};
    if (credit !== undefined) updates.credit = credit;
    if (total !== undefined) updates.total = total;
    if (wallet !== undefined) updates.wallet = wallet;
    if (used !== undefined) updates.used = used;

    const result = await updateOpenrouterStatus(updates);

    res.json(result);
  } catch (error) {
    console.error('🔥 Error updating status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

/**
 * DELETE /api/admin/openrouter/reset
 * Reset all credits (admin only, caution)
 */
export async function resetController(req, res) {
  try {
    await resetOpenrouterCredits();

    res.json({
      success: true,
      message: 'OpenRouter credits reset successfully',
    });
  } catch (error) {
    console.error('🔥 Error resetting credits:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
