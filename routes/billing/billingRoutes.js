/**
 * Billing Routes
 * 
 * API endpoints for:
 * - Plan upgrades
 * - Stripe integration
 * - Invoice management
 */

import express from 'express';
import { verifyFirebaseToken } from '../../middleware/firebaseAuthMiddleware.js';
import { getLimitsForPlan } from '../../utils/limitsConfig.js';
import {
  createUpgradeCheckout,
  generateMonthlyInvoice,
  upgradeToPremium
} from '../../services/billingService.js';

const router = express.Router();

/**
 * POST /billing/upgrade
 * 
 * Creates a Stripe checkout session for plan upgrade to premium
 * User is redirected to Stripe checkout, then back to app
 * 
 * Query params:
 *   successUrl (required): URL to redirect after successful payment
 *   cancelUrl (required): URL to redirect if user cancels
 * 
 * Response:
 * {
 *   success: true,
 *   message: "Checkout session created",
 *   data: {
 *     checkoutUrl: "https://checkout.stripe.com/..."
 *   }
 * }
 */
router.post('/upgrade', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const email = req.user.email;
    const { successUrl, cancelUrl } = req.body;

    // ============ VALIDATION ============

    if (!successUrl || !cancelUrl) {
      return res.status(400).json({
        error: 'successUrl and cancelUrl are required',
        code: 'MISSING_URLS'
      });
    }

    // ============ CREATE CHECKOUT ============

    const checkoutUrl = await createUpgradeCheckout(
      uid,
      email,
      successUrl,
      cancelUrl
    );

    res.json({
      success: true,
      message: 'Checkout session created',
      data: {
        checkoutUrl
      }
    });

  } catch (error) {
    console.error('🔥 Error creating upgrade checkout:', error.message);

    if (error.message === 'User not found') {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    res.status(500).json({
      error: 'Failed to create checkout session',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /billing/upgrade-success
 * 
 * Called after successful Stripe payment
 * Updates user plan to "premium" and increases token limits
 * 
 * Normally called by Stripe webhook, but also available for manual testing
 * 
 * Request body:
 * {
 *   uid: "user123"
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   message: "Plan upgraded to premium"
 * }
 */
router.post('/upgrade-success', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;

    // ============ UPGRADE USER ============

    // Get premium limits from centralized configuration
    const premiumLimitsConfig = getLimitsForPlan('premium');
    const premiumLimits = {
      chatTokensDaily: premiumLimitsConfig.chatTokensDaily,
      chatTokensMonthly: premiumLimitsConfig.chatTokensMonthly
    };

    await upgradeToPremium(uid, premiumLimits);

    res.json({
      success: true,
      message: 'Plan upgraded to premium',
      data: {
        newLimits: premiumLimits
      }
    });

  } catch (error) {
    console.error('🔥 Error upgrading plan:', error.message);

    if (error.message === 'User not found') {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    res.status(500).json({
      error: 'Failed to upgrade plan',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /billing/invoice/:month
 * 
 * Get invoice for specific month
 * Month format: YYYY-MM (e.g., "2025-01")
 * 
 * Query params:
 *   month: YYYY-MM format (optional, defaults to previous month)
 * 
 * Response:
 * {
 *   success: true,
 *   data: {
 *     uid: "user123",
 *     month: "2025-01",
 *     platformFee: 7.00,
 *     apiUsageCost: 45.32,
 *     totalAmount: 52.32,
 *     status: "draft" | "pending_payment" | "paid",
 *     createdAt: "2025-01-21T10:30:45Z"
 *   }
 * }
 */
router.get('/invoice', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { month } = req.query;

    // ============ GENERATE INVOICE ============

    const invoice = await generateMonthlyInvoice(uid, month);

    res.json({
      success: true,
      data: invoice
    });

  } catch (error) {
    console.error('🔥 Error getting invoice:', error.message);

    if (error.message === 'User not found') {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    res.status(500).json({
      error: 'Failed to generate invoice',
      code: 'INTERNAL_ERROR'
    });
  }
});

export default router;
