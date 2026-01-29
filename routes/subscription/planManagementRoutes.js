/**
 * Plan Management Routes
 * Handles upgrade, downgrade with prorated billing
 */

import express from 'express';
import { verifyFirebaseToken } from '../../middleware/firebaseAuthMiddleware.js';
import { db } from '../../firebase.js';
import { doc, getDoc } from 'firebase/firestore';
import {
  upgradeToPremium,
  downgradeToPremium,
  calculateProratedUsage,
  createImmediateInvoice,
  cancelSubscription
} from '../../services/planManagementService.js';

const router = express.Router();

/**
 * POST /api/plans/upgrade
 * 
 * Upgrade user from free to premium
 * Creates subscription with automatic monthly billing
 * 
 * Request body:
 * {
 *   successUrl: "https://yourapp.com/success",
 *   cancelUrl: "https://yourapp.com/cancel"
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   message: "Upgrade checkout created",
 *   data: {
 *     checkoutUrl: "https://checkout.stripe.com/...",
 *     sessionId: "cs_...",
 *     customerId: "cus_..."
 *   }
 * }
 */
router.post('/upgrade', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const email = req.user.email;
    const { successUrl, cancelUrl } = req.body;

    if (!successUrl || !cancelUrl) {
      return res.status(400).json({
        error: 'successUrl and cancelUrl are required',
        code: 'MISSING_URLS'
      });
    }

    const result = await upgradeToPremium({
      userId: uid,
      userEmail: email,
      successUrl,
      cancelUrl
    });

    res.json({
      success: true,
      message: 'Upgrade checkout created',
      data: result
    });

  } catch (error) {
    console.error('🔥 Error creating upgrade:', error.message);

    if (error.message === 'User not found') {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    if (error.message === 'User already premium') {
      return res.status(400).json({
        error: 'User is already on premium plan',
        code: 'ALREADY_PREMIUM'
      });
    }

    res.status(500).json({
      error: 'Failed to create upgrade',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /api/plans/downgrade
 * 
 * Downgrade user from premium to free
 * - Calculates prorated API usage since last billing
 * - Creates immediate invoice for API usage only (no platform fee)
 * - Cancels subscription to stop future billing
 * - Changes plan to "free"
 * 
 * Request body: {} (no body required)
 * 
 * Response:
 * {
 *   success: true,
 *   message: "Plan downgraded successfully",
 *   data: {
 *     finalInvoice: {
 *       id: "in_...",
 *       amount: 5.25,
 *       description: "Final API usage charges",
 *       usagePeriod: "2026-01-15 to 2026-01-18",
 *       daysUsed: 3,
 *       apiUsageCost: 5.25,
 *       platformFeeRefund: 0
 *     },
 *     newPlan: "free",
 *     subscriptionStatus: "cancelled"
 *   }
 * }
 */
router.post('/downgrade', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;

    const result = await downgradeToPremium(uid);

    res.json({
      success: true,
      message: 'Plan downgraded successfully',
      data: result
    });

  } catch (error) {
    console.error('🔥 Error downgrading plan:', error.message);

    if (error.message === 'User not found') {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    if (error.message === 'User not on premium plan') {
      return res.status(400).json({
        error: 'User is not on premium plan',
        code: 'NOT_PREMIUM'
      });
    }

    if (error.message === 'No active subscription') {
      return res.status(400).json({
        error: 'No active subscription found',
        code: 'NO_SUBSCRIPTION'
      });
    }

    res.status(500).json({
      error: 'Failed to downgrade plan',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /api/plans/current
 * 
 * Get current user's plan information
 * 
 * Response:
 * {
 *   success: true,
 *   data: {
 *     plan: "premium" | "free",
 *     subscriptionStatus: "active" | "cancelled" | "past_due",
 *     billingAnniversaryDay: 15,
 *     currentPeriodStart: "2026-01-15T10:00:00.000Z",
 *     currentPeriodEnd: "2026-02-15T10:00:00.000Z",
 *     nextBillingDate: "2026-02-15T10:00:00.000Z",
 *     currentUsageCost: 2.45,
 *     estimatedNextBill: 9.45
 *   }
 * }
 */
router.get('/current', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;

    // Get user data from Firebase
    const userRef = doc(db, 'users', uid);
    const userDoc = await getDoc(userRef);

    if (!userDoc.exists()) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const userData = userDoc.data();
    
    // Calculate current usage cost
    const currentUsage = await calculateProratedUsage(uid);
    
    // Estimate next bill (platform fee + current usage)
    const platformFee = 7.00;
    const estimatedNextBill = userData.plan === 'premium' 
      ? platformFee + currentUsage.totalCost 
      : 0;

    res.json({
      success: true,
      data: {
        plan: userData.plan || 'free',
        subscriptionStatus: userData.subscriptionStatus || 'none',
        billingAnniversaryDay: userData.billingAnniversaryDay || null,
        currentPeriodStart: userData.currentPeriodStart || null,
        currentPeriodEnd: userData.currentPeriodEnd || null,
        nextBillingDate: userData.currentPeriodEnd || null,
        currentUsageCost: currentUsage.totalCost || 0,
        estimatedNextBill: estimatedNextBill,
        stripeCustomerId: userData.stripeCustomerId || null,
        stripeSubscriptionId: userData.stripeSubscriptionId || null
      }
    });

  } catch (error) {
    console.error('🔥 Error getting plan info:', error.message);
    res.status(500).json({
      error: 'Failed to get plan information',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /api/plans/usage-preview
 * 
 * Get preview of current usage costs (before downgrade)
 * 
 * Response:
 * {
 *   success: true,
 *   data: {
 *     currentPeriodStart: "2026-01-15T10:00:00.000Z",
 *     currentDate: "2026-01-18T10:00:00.000Z",
 *     daysUsed: 3,
 *     totalDaysInPeriod: 31,
 *     apiUsageCost: 5.25,
 *     platformFeeUsed: 3,
 *     platformFeeTotal: 31,
 *     estimatedFinalCharge: 5.25,
 *     breakdown: [
 *       { date: "2026-01-15", cost: 1.25, requests: 25 },
 *       { date: "2026-01-16", cost: 2.00, requests: 40 },
 *       { date: "2026-01-17", cost: 2.00, requests: 40 }
 *     ]
 *   }
 * }
 */
router.get('/usage-preview', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;

    const usagePreview = await calculateProratedUsage(uid, true); // true = detailed breakdown

    res.json({
      success: true,
      data: usagePreview
    });

  } catch (error) {
    console.error('🔥 Error getting usage preview:', error.message);
    res.status(500).json({
      error: 'Failed to get usage preview',
      code: 'INTERNAL_ERROR'
    });
  }
});

export default router;