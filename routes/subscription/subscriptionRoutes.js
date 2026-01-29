/**
 * Subscription Routes
 * Handles automatic recurring billing with Stripe subscriptions
 */

import express from 'express';
import { verifyFirebaseToken } from '../../middleware/firebaseAuthMiddleware.js';
import {
  createSubscriptionCheckout,
  createStripeProducts,
  trackApiUsage,
  handleSubscriptionCreated,
  handleInvoicePaymentSucceeded
} from '../../services/stripe/subscriptionService.js';

const router = express.Router();

/**
 * POST /subscription/upgrade
 * 
 * Creates a Stripe subscription checkout for automatic recurring billing
 * This replaces the one-time platform fee payment with a subscription
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
 *   message: "Subscription checkout created",
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

    const result = await createSubscriptionCheckout({
      userId: uid,
      userEmail: email,
      successUrl,
      cancelUrl
    });

    res.json({
      success: true,
      message: 'Subscription checkout created',
      data: result
    });

  } catch (error) {
    console.error('🔥 Error creating subscription checkout:', error.message);

    if (error.message === 'User not found') {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    if (error.message.includes('price IDs not configured')) {
      return res.status(500).json({
        error: 'Subscription products not configured',
        code: 'PRODUCTS_NOT_CONFIGURED'
      });
    }

    res.status(500).json({
      error: 'Failed to create subscription checkout',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /subscription/track-usage
 * 
 * Track API usage for billing (called internally when user makes API calls)
 * 
 * Request body:
 * {
 *   cost: 0.05  // Cost in dollars
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   message: "Usage tracked"
 * }
 */
router.post('/track-usage', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { cost } = req.body;

    if (!cost || typeof cost !== 'number' || cost <= 0) {
      return res.status(400).json({
        error: 'Valid cost amount is required',
        code: 'INVALID_COST'
      });
    }

    await trackApiUsage(uid, cost);

    res.json({
      success: true,
      message: 'Usage tracked'
    });

  } catch (error) {
    console.error('🔥 Error tracking usage:', error.message);

    res.status(500).json({
      error: 'Failed to track usage',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /subscription/setup-products
 * 
 * Setup Stripe products and prices (admin only - run once)
 * 
 * Response:
 * {
 *   success: true,
 *   data: {
 *     platformProduct: "prod_...",
 *     platformPrice: "price_...",
 *     usageProduct: "prod_...",
 *     usagePrice: "price_..."
 *   }
 * }
 */
router.post('/setup-products', async (req, res) => {
  try {
    // TODO: Add admin authentication here
    const products = await createStripeProducts();

    res.json({
      success: true,
      message: 'Stripe products created successfully',
      data: products,
      note: 'Save these IDs to your environment variables'
    });

  } catch (error) {
    console.error('🔥 Error setting up products:', error.message);

    res.status(500).json({
      error: 'Failed to setup products',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /subscription/webhook
 * 
 * Stripe webhook handler for subscription events
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      return res.status(500).json({
        error: 'Webhook secret not configured'
      });
    }

    // Verify webhook signature
    const stripe = (await import('../../services/stripe/subscriptionService.js')).stripe;
    const event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);

    console.log(`📩 Subscription webhook received: ${event.type}`);

    // Handle different event types
    switch (event.type) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;

      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object);
        break;

      case 'customer.subscription.updated':
        console.log('Subscription updated:', event.data.object.id);
        break;

      case 'customer.subscription.deleted':
        console.log('Subscription cancelled:', event.data.object.id);
        // TODO: Handle subscription cancellation
        break;

      case 'invoice.payment_failed':
        console.log('Payment failed for invoice:', event.data.object.id);
        // TODO: Handle failed payments
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });

  } catch (error) {
    console.error('🔥 Subscription webhook error:', error.message);
    res.status(400).json({
      error: 'Webhook error',
      message: error.message
    });
  }
});

export default router;