/**
 * Stripe Service for Token Purchases
 * Handles Stripe payment processing for token purchases
 * Backend validates token quantity and price independently
 */

import Stripe from 'stripe';
import dotenv from 'dotenv';
import { calculateTokenPrice, validateTokenPrice, getTokenLimits } from '../../utils/tokenPricing.js';
import { checkPlatformFeeRequired } from '../../utils/platformFeeHelper.js';

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
 * @returns {Promise<Object>} Checkout session
 */
export async function createTokenPurchaseSession({
  userId,
  tokens,
  price,
  successUrl,
  cancelUrl,
}) {
  try {
    if (!userId || !tokens || tokens <= 0) {
      throw new Error('Invalid parameters: userId and positive tokens required');
    }

    // Validate token quantity limits
    const limits = getTokenLimits();
    const { minTokens, maxTokens } = limits;
    if (tokens < minTokens || tokens > maxTokens) {
      throw new Error(`Token quantity must be between ${minTokens.toLocaleString()} and ${maxTokens.toLocaleString()}`);
    }

    // Check if platform fee is required for this user
    const platformFeeStatus = await checkPlatformFeeRequired(userId);
    const platformFeeRequired = platformFeeStatus.required;

    // Backend recalculates price independently (mandatory validation)
    const priceCalculation = calculateTokenPrice(tokens, platformFeeRequired);

    // Validate that provided price matches calculated total price
    if (price !== undefined) {
      const validation = validateTokenPrice(tokens, price, platformFeeRequired);
      if (!validation.isValid) {
        throw new Error(`Price mismatch: Expected $${price.toFixed(2)}, calculated $${priceCalculation.totalPrice.toFixed(2)}`);
      }
    }

    // Build line items array
    const lineItems = [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Korpo AI Tokens',
            description: `Purchase ${tokens.toLocaleString()} tokens for AI services (covers text, audio & multimodal usage)`,
          },
          unit_amount: Math.round(priceCalculation.tokenPrice * 100), // Convert to cents
        },
        quantity: 1,
      },
    ];

    // Add platform fee line item only if required
    if (platformFeeRequired && priceCalculation.platformFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Platform Fee',
            description: 'Monthly platform access, infrastructure, and support',
          },
          unit_amount: Math.round(priceCalculation.platformFee * 100), // Convert to cents
        },
        quantity: 1,
      });
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
      tokenPrice: priceCalculation.tokenPrice,
      platformFee: priceCalculation.platformFee,
      platformFeeRequired,
      totalPrice: priceCalculation.totalPrice,
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
    const priceCalculation = calculateTokenPrice(tokens, platformFeeRequired);

    // Validate total price if provided
    if (price !== undefined) {
      const validation = validateTokenPrice(tokens, price, platformFeeRequired);
      if (!validation.isValid) {
        throw new Error(`Price mismatch: Expected $${price.toFixed(2)}, calculated $${priceCalculation.totalPrice.toFixed(2)}`);
      }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(priceCalculation.totalPrice * 100), // Convert to cents
      currency: 'usd',
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
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      tokens,
      tokenPrice: priceCalculation.tokenPrice,
      platformFee: priceCalculation.platformFee,
      platformFeeRequired,
      totalPrice: priceCalculation.totalPrice,
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

