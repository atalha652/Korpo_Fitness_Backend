/**
 * OpenRouter Routes
 * Admin routes for credits management
 */

import express from 'express';
import { adminAuthMiddleware, checkPermission } from '../../middleware/adminAuth.js';
import {
  getStatusController,
  addCreditsController,
  getTransactionsController,
  updateStatusController,
  resetController,
} from '../../controllers/openrouter/openrouterController.js';

const router = express.Router();

/**
 * @route GET /api/admin/openrouter/status
 * @desc Get current openrouter credits status
 * @access Admin (read tokens)
 */
router.get('/openrouter/status', adminAuthMiddleware, checkPermission('tokens', 'read'), getStatusController);

/**
 * @route POST /api/admin/openrouter/add-credits
 * @desc Add credits manually
 * @access Admin (write tokens)
 * @disabled - Commented out for now
 */
// router.post('/openrouter/add-credits', adminAuthMiddleware, checkPermission('tokens', 'write'), addCreditsController);

/**
 * @route GET /api/admin/openrouter/transactions
 * @desc Get transaction history
 * @access Admin (read tokens)
 */
router.get('/openrouter/transactions', adminAuthMiddleware, checkPermission('tokens', 'read'), getTransactionsController);

/**
 * @route PUT /api/admin/openrouter/update
 * @desc Manual update to credits (admin correction)
 * @access Admin (write tokens)
 */
router.put('/openrouter/update', adminAuthMiddleware, checkPermission('tokens', 'write'), updateStatusController);

/**
 * @route DELETE /api/admin/openrouter/reset
 * @desc Reset all credits (caution)
 * @access Admin (write tokens)
 */
router.delete('/openrouter/reset', adminAuthMiddleware, checkPermission('tokens', 'write'), resetController);

export default router;
