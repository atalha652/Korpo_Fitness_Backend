/**
 * Admin Statistics Routes
 * Endpoints for dashboard analytics and reporting
 * 
 * All routes require admin authentication and appropriate permissions
 */

import express from 'express';
import { adminAuthMiddleware, checkPermission } from '../../middleware/adminAuth.js';
import {
  getOverviewStats,
  getUsageStats,
  getRevenueStats,
  getTopUsers,
  getModelUsageStats,
  getUserGrowthStats
} from '../../services/admin/adminStatsService.js';

const router = express.Router();

/**
 * @route GET /api/admin/stats/overview
 * @desc Get overall platform statistics
 * @access Admin (read analytics)
 * 
 * Returns:
 * {
 *   totalUsers: 150,
 *   freeUsers: 120,
 *   premierUsers: 30,
 *   activeSubscriptions: 25,
 *   totalRevenue: 1250.50,
 *   totalTokensUsed: 5000000,
 *   totalCostUSD: 4500.25,
 *   averageCostPerUser: 30.00,
 *   averageTokensPerUser: 33333,
 *   lastUpdated: "2025-01-21T10:30:45Z"
 * }
 */
router.get('/overview', adminAuthMiddleware, checkPermission('analytics', 'read'), async (req, res) => {
  try {
    const stats = await getOverviewStats();

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('🔥 Error getting overview stats:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * @route GET /api/admin/stats/usage
 * @desc Get detailed usage statistics
 * @access Admin (read analytics)
 * 
 * Query params:
 *   - userId: Filter by specific user (optional)
 *   - startDate: ISO date (optional)
 *   - endDate: ISO date (optional)
 * 
 * Returns:
 * {
 *   total: {
 *     tokens: 5000000,
 *     cost: 4500.25,
 *     recordCount: 150,
 *     uniqueUsers: 120
 *   },
 *   byMonth: [
 *     { month: "2025-01", tokens: 500000, cost: 450.25, activeUsers: 80 }
 *   ],
 *   records: [
 *     { uid: "user123", month: "2025-01", tokens: 50000, cost: 45.25 }
 *   ]
 * }
 */
router.get('/usage', adminAuthMiddleware, checkPermission('analytics', 'read'), async (req, res) => {
  try {
    const { userId, startDate, endDate } = req.query;

    const filters = {};
    if (userId) filters.userId = userId;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    const stats = await getUsageStats(filters);

    res.json({
      success: true,
      data: stats,
      filters,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('🔥 Error getting usage stats:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * @route GET /api/admin/stats/revenue
 * @desc Get revenue analytics and breakdown
 * @access Admin (read analytics)
 * 
 * Returns:
 * {
 *   totalRevenue: 5750.75,
 *   subscriptionRevenue: 1250.50,
 *   apiUsageRevenue: 4500.25,
 *   subscriptionPercentage: 21.75,
 *   apiUsagePercentage: 78.25,
 *   paidSubscriptions: 25,
 *   totalSubscriptions: 30,
 *   conversionRate: 83.33,
 *   monthlyBreakdown: [
 *     { month: "2025-01", revenue: 750.50 }
 *   ]
 * }
 */
router.get('/revenue', adminAuthMiddleware, checkPermission('analytics', 'read'), async (req, res) => {
  try {
    const stats = await getRevenueStats();

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('🔥 Error getting revenue stats:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * @route GET /api/admin/stats/top-users
 * @desc Get top users by various metrics
 * @access Admin (read analytics)
 * 
 * Query params:
 *   - metric: 'spenders' | 'tokens' | 'subscriptions' (default: 'spenders')
 *   - limit: Number of results (default: 10, max: 100)
 * 
 * Returns (for spenders):
 * [
 *   {
 *     uid: "user123",
 *     email: "user@example.com",
 *     firstName: "John",
 *     lastName: "Doe",
 *     totalSpent: 150.75,
 *     apiUsageCost: 100.50,
 *     subscriptionCost: 50.25,
 *     plan: "premier",
 *     createdAt: "2025-01-01T..."
 *   }
 * ]
 */
router.get('/top-users', adminAuthMiddleware, checkPermission('analytics', 'read'), async (req, res) => {
  try {
    const { metric = 'spenders', limit = 10 } = req.query;
    const count = Math.min(parseInt(limit) || 10, 100);

    if (!['spenders', 'tokens', 'subscriptions'].includes(metric)) {
      return res.status(400).json({
        success: false,
        error: "metric must be one of: 'spenders', 'tokens', 'subscriptions'",
        code: 'INVALID_METRIC'
      });
    }

    const users = await getTopUsers(metric, count);

    res.json({
      success: true,
      data: users,
      metric,
      count: users.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('🔥 Error getting top users:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * @route GET /api/admin/stats/models
 * @desc Get AI model usage statistics
 * @access Admin (read analytics)
 * 
 * Returns:
 * {
 *   total: {
 *     tokens: 5000000,
 *     cost: 4500.25,
 *     models: 2,
 *     transactions: 1500
 *   },
 *   byModel: [
 *     {
 *       model: "gpt-4o",
 *       tokens: 3500000,
 *       cost: 3500.00,
 *       count: 1000,
 *       percentage: 70.0
 *     },
 *     {
 *       model: "gpt-4o-mini",
 *       tokens: 1500000,
 *       cost: 1000.25,
 *       count: 500,
 *       percentage: 30.0
 *     }
 *   ]
 * }
 */
router.get('/models', adminAuthMiddleware, checkPermission('analytics', 'read'), async (req, res) => {
  try {
    const stats = await getModelUsageStats();

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('🔥 Error getting model usage stats:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * @route GET /api/admin/stats/growth
 * @desc Get user growth statistics over time
 * @access Admin (read analytics)
 * 
 * Returns:
 * {
 *   totalUsers: 150,
 *   freeUsers: 120,
 *   premierUsers: 30,
 *   monthlyBreakdown: [
 *     {
 *       month: "2024-11",
 *       total: 50,
 *       free: 45,
 *       premier: 5,
 *       cumulative: 50
 *     },
 *     {
 *       month: "2024-12",
 *       total: 75,
 *       free: 60,
 *       premier: 15,
 *       cumulative: 125
 *     }
 *   ]
 * }
 */
router.get('/growth', adminAuthMiddleware, checkPermission('analytics', 'read'), async (req, res) => {
  try {
    const stats = await getUserGrowthStats();

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('🔥 Error getting user growth stats:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

export default router;
