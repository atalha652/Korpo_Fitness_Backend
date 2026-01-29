/**
 * Stripe Subscription Service for Automatic Recurring Billing
 * Handles subscription creation, usage tracking, and automatic billing
 */

import Stripe from 'stripe';
import dotenv from 'dotenv';
import { db } from '../../firebase.js';
import { doc, getDoc, updateDoc, setDoc, collection, addDoc } from 'firebase/firestore';
import { getPlatformFee } from '../../utils/platformFeeHelper.js';

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Create Stripe Products and Prices (run once during setup)
 * This creates the recurring platform fee product in Stripe
 */
export async function createStripeProducts() {
  try {
    // Create Platform Fee Product
    const platformProduct = await stripe.products.create({
      name: 'Korpo Premium Platform Fee',
      description: 'Monthly platform access, infrastructure, and premium support',
      metadata: {
        type: 'platform_fee'
      }
    });

    // Create Monthly Price for Platform Fee
    const platformPrice = await stripe.prices.create({
      product: platformProduct.id,
      unit_amount: Math.round(getPlatformFee() * 100), // Convert to cents
      currency: 'usd',
      recurring: {
        interval: 'month',
        interval_count: 1
      },
      metadata: {
        type: 'platform_fee_monthly'
      }
    });

    // Create Usage-based Price for API Usage
    const usageProduct = await stripe.products.create({
      name: 'Korpo API Usage',
      description: 'Pay-as-you-go API usage costs',
      metadata: {
        type: 'api_usage'
      }
    });

    const usagePrice = await stripe.prices.create({
      product: usageProduct.id,
      currency: 'usd',
      unit_amount: 100, // $1.00 per unit (will be overridden by actual usage costs)
      recurring: {
        interval: 'month',
        usage_type: 'metered'
      },
      metadata: {
        type: 'api_usage_metered'
      }
    });

    console.log('✅ Stripe products created:', {
      platformProduct: platformProduct.id,
      platformPrice: platformPrice.id,
      usageProduct: usageProduct.id,
      usagePrice: usagePrice.id
    });

    return {
      platformProduct: platformProduct.id,
      platformPrice: platformPrice.id,
      usageProduct: usageProduct.id,
      usagePrice: usagePrice.id
    };
  } catch (error) {
    console.error('Error creating Stripe products:', error);
    throw error;
  }
}

/**
 * Create subscription checkout session for first-time platform fee payment
 * This saves the payment method and creates a subscription for automatic billing
 */
export async function createSubscriptionCheckout({
  userId,
  userEmail,
  successUrl,
  cancelUrl
}) {
  try {
    if (!userId) {
      throw new Error('userId is required');
    }

    // Get or create Stripe customer
    const customer = await getOrCreateStripeCustomer(userId, userEmail);

    // Get platform fee price ID (you'll need to store this from createStripeProducts)
    const platformPriceId = process.env.STRIPE_PLATFORM_PRICE_ID;
    const usagePriceId = process.env.STRIPE_USAGE_PRICE_ID;

    if (!platformPriceId || !usagePriceId) {
      throw new Error('Stripe price IDs not configured. Run createStripeProducts first.');
    }

    // Create checkout session with subscription mode
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: platformPriceId, // Monthly platform fee
          quantity: 1,
        },
        {
          price: usagePriceId, // Usage-based API costs
          quantity: 1,
        }
      ],
      success_url: successUrl || `${process.env.FRONTEND_URL}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_URL}/upgrade/cancel`,
      metadata: {
        userId,
        type: 'subscription_creation',
        createdAt: new Date().toISOString()
      },
      // Save payment method for future use
      payment_method_collection: 'always',
      // Set billing cycle anchor to user's anniversary day
      subscription_data: {
        metadata: {
          userId,
          type: 'premium_subscription'
        }
      }
    });

    console.log(`✅ Created subscription checkout for user ${userId}: ${session.id}`);

    return {
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url,
      customerId: customer.id
    };

  } catch (error) {
    console.error('Error creating subscription checkout:', error);
    throw error;
  }
}

/**
 * Get or create Stripe customer for user
 */
async function getOrCreateStripeCustomer(userId, userEmail) {
  try {
    // Check if user already has Stripe customer ID
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDoc(userRef);
    
    if (!userDoc.exists()) {
      throw new Error('User not found');
    }

    const userData = userDoc.data();
    
    if (userData.stripeCustomerId) {
      // Return existing customer
      return await stripe.customers.retrieve(userData.stripeCustomerId);
    }

    // Create new customer
    const customer = await stripe.customers.create({
      email: userEmail || userData.email,
      metadata: {
        userId,
        firebaseUid: userId
      }
    });

    // Save customer ID to user document
    await updateDoc(userRef, {
      stripeCustomerId: customer.id
    });

    console.log(`✅ Created Stripe customer for user ${userId}: ${customer.id}`);
    return customer;

  } catch (error) {
    console.error('Error getting/creating Stripe customer:', error);
    throw error;
  }
}

/**
 * Handle successful subscription creation (called from webhook)
 */
export async function handleSubscriptionCreated(subscription) {
  try {
    const userId = subscription.metadata.userId;
    
    if (!userId) {
      console.error('No userId in subscription metadata');
      return;
    }

    // Update user document with subscription info
    const userRef = doc(db, 'users', userId);
    await updateDoc(userRef, {
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      plan: 'premium',
      upgradedAt: new Date().toISOString(),
      billingAnniversaryDay: new Date().getDate(),
      currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString()
    });

    console.log(`✅ Subscription created for user ${userId}: ${subscription.id}`);

  } catch (error) {
    console.error('Error handling subscription created:', error);
    throw error;
  }
}

/**
 * Track API usage for billing (call this whenever user makes API calls)
 */
export async function trackApiUsage(userId, cost) {
  try {
    // Get user's subscription
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDoc(userRef);
    
    if (!userDoc.exists()) {
      throw new Error('User not found');
    }

    const userData = userDoc.data();
    const subscriptionId = userData.stripeSubscriptionId;

    if (!subscriptionId) {
      console.log(`User ${userId} doesn't have subscription, skipping usage tracking`);
      return;
    }

    // Get usage price ID
    const usagePriceId = process.env.STRIPE_USAGE_PRICE_ID;
    
    // Report usage to Stripe (cost in cents)
    await stripe.subscriptionItems.createUsageRecord(
      await getSubscriptionItemId(subscriptionId, usagePriceId),
      {
        quantity: Math.round(cost * 100), // Convert to cents
        timestamp: Math.floor(Date.now() / 1000),
        action: 'increment'
      }
    );

    // Also track in Firestore for records
    await addDoc(collection(db, 'usage_tracking'), {
      userId,
      cost,
      timestamp: new Date().toISOString(),
      subscriptionId,
      reportedToStripe: true
    });

    console.log(`✅ Tracked usage for user ${userId}: $${cost}`);

  } catch (error) {
    console.error('Error tracking API usage:', error);
    throw error;
  }
}

/**
 * Get subscription item ID for usage reporting
 */
async function getSubscriptionItemId(subscriptionId, priceId) {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const item = subscription.items.data.find(item => item.price.id === priceId);
    
    if (!item) {
      throw new Error(`Subscription item not found for price ${priceId}`);
    }

    return item.id;
  } catch (error) {
    console.error('Error getting subscription item ID:', error);
    throw error;
  }
}

/**
 * Handle subscription invoice payment (webhook handler)
 */
export async function handleInvoicePaymentSucceeded(invoice) {
  try {
    const customerId = invoice.customer;
    const subscriptionId = invoice.subscription;

    // Find user by customer ID
    const usersRef = collection(db, 'users');
    const userQuery = query(usersRef, where('stripeCustomerId', '==', customerId));
    const userDocs = await getDocs(userQuery);

    if (userDocs.empty) {
      console.error(`No user found for customer ${customerId}`);
      return;
    }

    const userDoc = userDocs.docs[0];
    const userId = userDoc.id;

    // Update user's billing info
    await updateDoc(userDoc.ref, {
      lastPaymentDate: new Date().toISOString(),
      lastInvoiceId: invoice.id,
      subscriptionStatus: 'active'
    });

    // Log payment in billing history
    await addDoc(collection(db, 'billing_history'), {
      userId,
      invoiceId: invoice.id,
      amount: invoice.amount_paid / 100, // Convert from cents
      currency: invoice.currency,
      status: 'paid',
      paidAt: new Date().toISOString(),
      subscriptionId
    });

    console.log(`✅ Invoice payment processed for user ${userId}: ${invoice.id}`);

  } catch (error) {
    console.error('Error handling invoice payment:', error);
    throw error;
  }
}

export { stripe };