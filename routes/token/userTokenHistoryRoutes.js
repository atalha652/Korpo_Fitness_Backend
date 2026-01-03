/**
 * User Token History Routes
 * User routes for token history and summary
 */

import express from 'express';
import {
  getUserHistoryController,
  getUserSummaryController,
} from '../../controllers/openrouter/userTokenHistoryController.js';

const router = express.Router();

/**
 * @route GET /api/users/:userId/token-history
 * @desc Get user's token purchasing history
 * @access Public
 */
router.get('/users/:userId/token-history', getUserHistoryController);

/**
 * @route GET /api/users/:userId/token-summary
 * @desc Get user's token summary (totals, spending, etc)
 * @access Public
 */
router.get('/users/:userId/token-summary', getUserSummaryController);

export default router;
