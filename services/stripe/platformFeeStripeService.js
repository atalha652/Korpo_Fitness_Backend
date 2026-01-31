/**
 * Stripe Service for Platform Fee Payments
 * Handles Stripe checkout sessions specifically for monthly platform fee payments
 */

import Stripe from 'stripe';
import dotenv from 'dotenv';
import { checkPlatformFeeRequired, getPlatformFee } from '../../utils/platformFeeHelper.js';

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY is not set in environment variables');
}

/**
 * Create a Stripe checkout session specifically for platform fee payment
 * This is used when users need to pay the monthly platform fee to upgrade to premium
 * @param {Object} params - Payment parameters
 * @param {string} params.userId - User ID (required)
 * @param {string} params.userEmail - User email (optional, pre-fills checkout form)
 * @param {string} params.successUrl - Success redirect URL (optional)
 * @param {string} params.cancelUrl - Cancel redirect URL (optional)
 * @returns {Promise<Object>} Checkout session with URL
 */
export async function createPlatformFeeCheckoutSession({
  userId,
  userEmail,
  successUrl,
  cancelUrl,
}) {
  try {
    if (!userId) {
      throw new Error('Invalid parameters: userId required');
    }

    // Check if platform fee is required for this user
    const platformFeeStatus = await checkPlatformFeeRequired(userId);
    const platformFeeRequired = platformFeeStatus.required;

    if (!platformFeeRequired) {
      return {
        success: false,
        error: 'Platform fee not required',
        reason: platformFeeStatus.reason,
        nextBillingDate: platformFeeStatus.nextBillingDate,
        billingAnniversaryDay: platformFeeStatus.billingAnniversaryDay
      };
    }

    // Get platform fee amount
    const platformFeeAmount = getPlatformFee();

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Korpo premium Platform Fee',
              description: 'Monthly platform access, infrastructure, and premium support',
            },
            unit_amount: Math.round(platformFeeAmount * 100), // Convert to cents
          },
          quantity: 1,
        }
      ],
      mode: 'payment',
      success_url: successUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/upgrade/cancel`,
      customer_email: userEmail, // Pre-fill email if provided
      metadata: {
        userId,
        platformFee: platformFeeAmount.toString(),
        type: 'platform_fee_payment',
        billingCycle: 'monthly',
        createdAt: new Date().toISOString()
      },
    });

    console.log(`✅ Created platform fee checkout session for user ${userId}: ${session.id}`);

    return {
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url, // This is the link you can send to users
      platformFee: platformFeeAmount,
      platformFeeStatus: platformFeeStatus.reason,
      expiresAt: new Date(session.expires_at * 1000).toISOString(), // Convert Unix timestamp
      sessionDetails: {
        id: session.id,
        amount: platformFeeAmount,
        currency: 'usd',
        mode: 'payment',
        status: session.status
      }
    };
  } catch (error) {
    console.error('Error creating platform fee checkout session:', error);
    throw error;
  }
}

/**
 * Create a Stripe checkout session for monthly invoice payment
 * This includes platform fee + API usage costs from the invoice
 * @param {Object} params - Invoice payment parameters
 * @param {string} params.userId - User ID (required)
 * @param {string} params.userEmail - User email (optional)
 * @param {Object} params.invoiceData - Invoice data object (required)
 * @param {string} params.successUrl - Success redirect URL (optional)
 * @param {string} params.cancelUrl - Cancel redirect URL (optional)
 * @returns {Promise<Object>} Checkout session with URL
 */
export async function createInvoicePaymentCheckoutSession({
  userId,
  userEmail,
  invoiceData,
  successUrl,
  cancelUrl,
}) {
  try {
    if (!userId || !invoiceData) {
      throw new Error('Invalid parameters: userId and invoiceData required');
    }

    const { month, platformFee, apiUsageCost, totalAmount } = invoiceData;

    if (!totalAmount || totalAmount <= 0) {
      throw new Error('Invalid invoice: total amount must be greater than 0');
    }

    // Build line items for the invoice
    const lineItems = [];

    // Add platform fee line item
    if (platformFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Platform Fee',
            description: `Monthly platform access for ${month}`,
          },
          unit_amount: Math.round(platformFee * 100), // Convert to cents
        },
        quantity: 1,
      });
    }

    // Add API usage line item
    if (apiUsageCost > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'API Usage',
            description: `API usage costs for ${month}`,
          },
          unit_amount: Math.round(apiUsageCost * 100), // Convert to cents
        },
        quantity: 1,
      });
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/billing/payment-success?session_id={CHECKOUT_SESSION_ID}&invoice=${month}`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/billing/payment-cancel?invoice=${month}`,
      customer_email: userEmail, // Pre-fill email if provided
      metadata: {
        userId,
        invoiceMonth: month,
        platformFee: platformFee.toString(),
        apiUsageCost: apiUsageCost.toString(),
        totalAmount: totalAmount.toString(),
        type: 'invoice_payment',
        createdAt: new Date().toISOString()
      },
    });

    console.log(`✅ Created invoice payment checkout session for user ${userId}, invoice ${month}: ${session.id}`);

    return {
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url, // This is the payment link for the invoice
      invoiceMonth: month,
      platformFee,
      apiUsageCost,
      totalAmount,
      expiresAt: new Date(session.expires_at * 1000).toISOString(),
      sessionDetails: {
        id: session.id,
        amount: totalAmount,
        currency: 'usd',
        mode: 'payment',
        status: session.status
      }
    };
  } catch (error) {
    console.error('Error creating invoice payment checkout session:', error);
    throw error;
  }
}

/**
 * Get invoice payment checkout URL for a specific user and invoice
 * Convenience function that returns just the URL
 * @param {string} userId - User ID
 * @param {Object} invoiceData - Invoice data object
 * @param {string} userEmail - User email (optional)
 * @returns {Promise<string>} Checkout URL
 */
export async function getInvoicePaymentCheckoutUrl(userId, invoiceData, userEmail = null) {
  try {
    const result = await createInvoicePaymentCheckoutSession({
      userId,
      userEmail,
      invoiceData
    });

    if (!result.success) {
      throw new Error('Failed to create invoice payment checkout session');
    }

    return result.checkoutUrl;
  } catch (error) {
    console.error('Error getting invoice payment checkout URL:', error);
    throw error;
  }
}

/**
 * Create a Stripe checkout session for hourly invoice payment
 * DISABLED - Only using monthly billing now
 * This includes hourly platform fee + API usage costs from the hourly invoice
 * @param {Object} params - Hourly invoice payment parameters
 * @param {string} params.userId - User ID (required)
 * @param {string} params.userEmail - User email (optional)
 * @param {Object} params.invoiceData - Hourly invoice data object (required)
 * @param {string} params.successUrl - Success redirect URL (optional)
 * @param {string} params.cancelUrl - Cancel redirect URL (optional)
 * @returns {Promise<Object>} Checkout session with URL
 */
/*
export async function createHourlyInvoicePaymentCheckoutSession({
  userId,
  userEmail,
  invoiceData,
  successUrl,
  cancelUrl,
}) {
  try {
    if (!userId || !invoiceData) {
      throw new Error('Invalid parameters: userId and invoiceData required');
    }

    const { hour, platformFee, apiUsageCost, totalAmount } = invoiceData;

    if (!totalAmount || totalAmount <= 0) {
      throw new Error('Invalid hourly invoice: total amount must be greater than 0');
    }

    // Build line items for the hourly invoice
    const lineItems = [];

    // Add hourly platform fee line item
    if (platformFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Hourly Platform Fee',
            description: `Prorated platform access for hour ${hour}`,
          },
          unit_amount: Math.round(platformFee * 100), // Convert to cents
        },
        quantity: 1,
      });
    }

    // Add API usage line item
    if (apiUsageCost > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Hourly API Usage',
            description: `API usage costs for hour ${hour}`,
          },
          unit_amount: Math.round(apiUsageCost * 100), // Convert to cents
        },
        quantity: 1,
      });
    }

    // Format hour for display
    const hourDate = new Date(hour + ':00:00Z');
    const nextHour = new Date(hourDate.getTime() + 60 * 60 * 1000);
    const hourDisplay = `${hour.slice(0, 10)} ${hour.slice(11)}:00-${String(nextHour.getUTCHours()).padStart(2, '0')}:00`;

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/billing/hourly-payment-success?session_id={CHECKOUT_SESSION_ID}&hour=${hour}`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/billing/hourly-payment-cancel?hour=${hour}`,
      customer_email: userEmail, // Pre-fill email if provided
      metadata: {
        userId,
        invoiceHour: hour,
        platformFee: platformFee.toString(),
        apiUsageCost: apiUsageCost.toString(),
        totalAmount: totalAmount.toString(),
        type: 'hourly_invoice_payment',
        createdAt: new Date().toISOString()
      },
    });

    console.log(`✅ Created hourly invoice payment checkout session for user ${userId}, hour ${hour}: ${session.id}`);

    return {
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url, // This is the payment link for the hourly invoice
      invoiceHour: hour,
      hourDisplay,
      platformFee,
      apiUsageCost,
      totalAmount,
      expiresAt: new Date(session.expires_at * 1000).toISOString(),
      sessionDetails: {
        id: session.id,
        amount: totalAmount,
        currency: 'usd',
        mode: 'payment',
        status: session.status
      }
    };
  } catch (error) {
    console.error('Error creating hourly invoice payment checkout session:', error);
    throw error;
  }
}
*/

/**
 * Get hourly invoice payment checkout URL for a specific user and hour
 * DISABLED - Only using monthly billing now
 * Convenience function that returns just the URL
 * @param {string} userId - User ID
 * @param {Object} invoiceData - Hourly invoice data object
 * @param {string} userEmail - User email (optional)
 * @returns {Promise<string>} Checkout URL
 */
/*
export async function getHourlyInvoicePaymentCheckoutUrl(userId, invoiceData, userEmail = null) {
  try {
    const result = await createHourlyInvoicePaymentCheckoutSession({
      userId,
      userEmail,
      invoiceData
    });

    if (!result.success) {
      throw new Error('Failed to create hourly invoice payment checkout session');
    }

    return result.checkoutUrl;
  } catch (error) {
    console.error('Error getting hourly invoice payment checkout URL:', error);
    throw error;
  }
}
*/

export { stripe };