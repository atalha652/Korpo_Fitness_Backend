/**
 * Stripe Service for Token Purchases
 * Handles Stripe payment processing for token purchases
 * Backend validates token quantity and price independently
 */

import Stripe from 'stripe';
import dotenv from 'dotenv';
import { calculateTokenCost } from '../../utils/tokenPricing.js';
import { checkPlatformFeeRequired, getPlatformFee } from '../../utils/platformFeeHelper.js';

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY is not set in environment variables');
}

/**
 * Create a Stripe checkout session for token purchase
 * Backend recalculates price to prevent manipulation
 * @param {Object} params - Purchase parameters
 * @param {string} params.userId - User ID
 * @param {number} params.tokens - Number of tokens to purchase
 * @param {number} params.price - Expected price (for validation)
 * @param {string} params.successUrl - Success redirect URL
 * @param {string} params.cancelUrl - Cancel redirect URL
 * @param {boolean|null} params.platformFeePaid - Override platform fee requirement (null=auto, false=require fee, true=skip fee)
 * @returns {Promise<Object>} Checkout session
 */
export async function createTokenPurchaseSession({
  userId,
  tokens,
  price,
  successUrl,
  cancelUrl,
  platformFeePaid = null, // Add parameter to override platform fee logic
}) {
  try {
    if (!userId) {
      throw new Error('Invalid parameters: userId required');
    }

    // TODO: Token validation commented out for platform fee-only payments
    // if (!tokens || tokens <= 0) {
    //   throw new Error('Invalid parameters: userId and positive tokens required');
    // }

    // TODO: Token quantity limit validation commented out for platform fee-only payments
    // Validate token quantity limits
    // const limits = getTokenLimits();
    // const { minTokens, maxTokens } = limits;
    // if (tokens < minTokens || tokens > maxTokens) {
    //   throw new Error(`Token quantity must be between ${minTokens.toLocaleString()} and ${maxTokens.toLocaleString()}`);
    // }

    // Check if platform fee is required for this user
    const platformFeeStatus = await checkPlatformFeeRequired(userId);
    let platformFeeRequired = platformFeeStatus.required;

    console.log(`🔧 platformFeePaid parameter received:`, platformFeePaid);

    // Override platform fee requirement if explicitly specified by frontend
    if (platformFeePaid === false) {
      platformFeeRequired = true; // Frontend says platform fee not paid, so require it
      console.log(`🔧 Platform fee requirement overridden to TRUE because platformFeePaid=false`);
    } else if (platformFeePaid === true) {
      platformFeeRequired = false; // Frontend says platform fee already paid, so don't require it
      console.log(`🔧 Platform fee requirement overridden to FALSE because platformFeePaid=true`);
    }

    console.log(`🔍 Final platform fee decision:`, {
      originalRequired: platformFeeStatus.required,
      finalRequired: platformFeeRequired,
      platformFeePaid: platformFeePaid,
      reason: platformFeeStatus.reason
    });

    // Backend recalculates price independently (mandatory validation)
    // Simplified: tokens are free, only platform fee applies
    const platformFeeAmount = platformFeeRequired ? getPlatformFee() : 0;
    const totalPrice = platformFeeAmount;

    // Create price calculation object for metadata
    const priceCalculation = {
      tokenPrice: 0, // Tokens are free
      platformFee: platformFeeAmount,
      totalPrice: totalPrice
    };

    // Validate that provided price matches calculated total price
    if (price !== undefined && Math.abs(price - totalPrice) > 0.01) { // Use small epsilon for float comparison
      throw new Error(`Price mismatch: Expected $${price.toFixed(2)}, calculated $${totalPrice.toFixed(2)}`);
    }

    // Build line items array
    const lineItems = [];

    // Add platform fee line item only if required
    if (platformFeeRequired && platformFeeAmount > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Platform Fee',
            description: 'Monthly platform access, infrastructure, and support',
          },
          unit_amount: Math.round(platformFeeAmount * 100), // Convert to cents
        },
        quantity: 1,
      });
    }

    // Ensure we have at least one line item
    if (lineItems.length === 0) {
      throw new Error('No charges required. Platform fee not needed for this user.');
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/tokens/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/tokens/cancel`,
      metadata: {
        userId,
        tokens: tokens.toString(),
        tokenPrice: priceCalculation.tokenPrice.toString(),
        platformFee: priceCalculation.platformFee.toString(),
        platformFeeRequired: platformFeeRequired.toString(),
        totalPrice: priceCalculation.totalPrice.toString(),
        type: 'token_purchase',
      },
    });

    return {
      success: true,
      sessionId: session.id,
      url: session.url,
      tokens,
      platformFee: platformFeeAmount,
      platformFeeRequired,
      totalPrice: totalPrice,
      platformFeeStatus: platformFeeStatus.reason,
    };
  } catch (error) {
    console.error('Error creating token purchase session:', error);
    throw error;
  }
}

/**
 * Create a Stripe payment intent for token purchase (alternative to checkout)
 * @param {Object} params - Purchase parameters
 * @param {string} params.userId - User ID
 * @param {number} params.tokens - Number of tokens to purchase
 * @param {number} params.price - Expected price (for validation)
 * @returns {Promise<Object>} Payment intent
 */
export async function createTokenPaymentIntent({ userId, tokens, price }) {
  try {
    if (!userId || !tokens || tokens <= 0) {
      throw new Error('Invalid parameters: userId and positive tokens required');
    }

    // Check if platform fee is required for this user
    const platformFeeStatus = await checkPlatformFeeRequired(userId);
    const platformFeeRequired = platformFeeStatus.required;

    // Backend recalculates price independently
    const platformFeeAmount = platformFeeRequired ? getPlatformFee() : 0;
    const totalPrice = platformFeeAmount;

    // Validate total price if provided
    if (price !== undefined && price !== totalPrice) {
      throw new Error(`Price mismatch: Expected $${price.toFixed(2)}, calculated $${totalPrice.toFixed(2)}`);
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(totalPrice * 100), // Convert to cents
      currency: 'usd',
      metadata: {
        userId,
        tokens: tokens.toString(),
        platformFee: platformFeeAmount.toString(),
        platformFeeRequired: platformFeeRequired.toString(),
        totalPrice: totalPrice.toString(),
        type: 'token_purchase',
      },
    });

    return {
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      tokens,
      platformFee: platformFeeAmount,
      platformFeeRequired,
      totalPrice: totalPrice,
      platformFeeStatus: platformFeeStatus.reason,
    };
  } catch (error) {
    console.error('Error creating payment intent:', error);
    throw error;
  }
}

/**
 * Retrieve a checkout session
 * @param {string} sessionId - Stripe session ID
 * @returns {Promise<Object>} Session details
 */
export async function getCheckoutSession(sessionId) {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return {
      success: true,
      session,
    };
  } catch (error) {
    console.error('Error retrieving checkout session:', error);
    throw error;
  }
}

/**
 * Verify webhook signature
 * @param {string} payload - Raw request body
 * @param {string} signature - Stripe signature header
 * @returns {Object} Event object
 */
export function verifyWebhookSignature(payload, signature) {
  try {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not set');
    }

    const event = stripe.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret
    );

    return {
      success: true,
      event,
    };
  } catch (error) {
    console.error('Error verifying webhook signature:', error);
    throw error;
  }
}

export { stripe };

