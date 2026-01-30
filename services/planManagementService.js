/**
 * Plan Management Service
 * Handles upgrade, downgrade with prorated billing
 */

import Stripe from 'stripe';
import { db } from '../firebase.js';
import { doc, getDoc, updateDoc, collection, query, where, getDocs, addDoc } from 'firebase/firestore';
import { createSubscriptionCheckout } from './stripe/subscriptionService.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Upgrade user to premium plan
 * Creates subscription checkout for automatic billing
 */
export async function upgradeToPremium({ userId, userEmail, successUrl, cancelUrl }) {
  try {
    // Check if user exists and current plan
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDoc(userRef);

    if (!userDoc.exists()) {
      throw new Error('User not found');
    }

    const userData = userDoc.data();

    if (userData.plan === 'premium') {
      throw new Error('User already premium');
    }

    // Create subscription checkout
    const checkoutResult = await createSubscriptionCheckout({
      userId,
      userEmail,
      successUrl,
      cancelUrl
    });

    console.log(`✅ Created upgrade checkout for user ${userId}`);
    return checkoutResult;

  } catch (error) {
    console.error('Error upgrading to premium:', error);
    throw error;
  }
}

/**
 * Complete upgrade to premium after successful payment
 * Updates user plan and limits in database
 * 
 * @param {string} userId - User ID
 * @param {Object} options - Upgrade options
 * @returns {Promise<Object>} Upgrade result
 */
export async function completeUpgradeToPremium(userId, options = {}) {
  const {
    resetDailyUsage = false,
    resetMonthlyUsage = false,
    grantBonusTokens = false,
    bonusTokens = 0
  } = options;
  
  try {
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDoc(userRef);

    if (!userDoc.exists()) {
      throw new Error('User not found');
    }

    const userData = userDoc.data();

    if (userData.plan === 'premium') {
      console.log(`User ${userId} already premium, skipping upgrade`);
      return { message: 'User already premium' };
    }

    // Get current usage before upgrade
    const { getCurrentUsageForPlanChange, applyUsageAdjustment } = await import('./usageResetService.js');
    const currentUsage = await getCurrentUsageForPlanChange(userId);

    // Get premium plan limits
    const { getLimitsForPlan } = await import('../utils/limitsConfig.js');
    const premiumLimits = getLimitsForPlan('premium');
    
    const today = new Date();
    const billingDayOfMonth = today.getDate();

    // Update user to premium with new limits
    await updateDoc(userRef, {
      plan: 'premium',
      subscriptionStatus: 'active',
      upgradedAt: new Date().toISOString(),
      billingAnniversaryDay: billingDayOfMonth,
      // Update limits to premium plan limits
      limits: {
        chatTokensDaily: premiumLimits.chatTokensDaily,
        chatTokensMonthly: premiumLimits.chatTokensMonthly,
        voiceRequestsDaily: premiumLimits.voiceRequestsDaily,
        chatRequestsDaily: premiumLimits.chatRequestsDaily,
        maxTokensPerRequest: premiumLimits.maxTokensPerRequest,
        maxRequestsPerMinute: premiumLimits.maxRequestsPerMinute
      },
      limitsUpdatedAt: new Date().toISOString()
    });

    // Apply usage adjustments if requested
    let usageAdjustments = null;
    if (resetDailyUsage || resetMonthlyUsage || grantBonusTokens) {
      usageAdjustments = await applyUsageAdjustment(userId, 'upgrade', {
        resetDaily: resetDailyUsage,
        resetMonthly: resetMonthlyUsage,
        grantBonus: grantBonusTokens,
        bonusTokens
      });
    }

    // Log upgrade event
    await addDoc(collection(db, 'plan_changes'), {
      userId,
      action: 'upgrade',
      fromPlan: userData.plan || 'free',
      toPlan: 'premium',
      timestamp: new Date().toISOString(),
      billingAnniversaryDay: billingDayOfMonth,
      newLimits: premiumLimits,
      currentUsageBeforeUpgrade: currentUsage,
      usageAdjustments: usageAdjustments
    });

    console.log(`✅ Upgraded user ${userId} to premium with updated limits:`, premiumLimits);
    if (usageAdjustments) {
      console.log(`📊 Applied usage adjustments:`, usageAdjustments);
    }

    return {
      newPlan: 'premium',
      newLimits: premiumLimits,
      subscriptionStatus: 'active',
      billingAnniversaryDay: billingDayOfMonth,
      currentUsageBeforeUpgrade: currentUsage,
      usageAdjustments: usageAdjustments,
      message: 'Successfully upgraded to premium'
    };

  } catch (error) {
    console.error('Error completing upgrade to premium:', error);
    throw error;
  }
}

/**
 * Downgrade user from premium to free
 * - Calculate prorated API usage
 * - Create immediate invoice for API usage only
 * - Cancel subscription
 * - Update user plan to free with updated limits
 * 
 * @param {string} userId - User ID
 * @param {Object} options - Downgrade options
 * @returns {Promise<Object>} Downgrade result
 */
export async function downgradeToPremium(userId, options = {}) {
  const {
    resetDailyUsage = false,
    resetMonthlyUsage = false
  } = options;
  try {
    // Get user data
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDoc(userRef);

    if (!userDoc.exists()) {
      throw new Error('User not found');
    }

    const userData = userDoc.data();

    if (userData.plan !== 'premium') {
      throw new Error('User not on premium plan');
    }

    if (!userData.stripeSubscriptionId) {
      throw new Error('No active subscription');
    }

    // Get current usage before downgrade
    const { getCurrentUsageForPlanChange, applyUsageAdjustment } = await import('./usageResetService.js');
    const currentUsage = await getCurrentUsageForPlanChange(userId);

    // Step 1: Calculate prorated usage
    const usageData = await calculateProratedUsage(userId, true);
    
    // Step 2: Create immediate invoice for API usage only
    let finalInvoice = null;
    if (usageData.totalCost > 0) {
      finalInvoice = await createImmediateInvoice(userId, usageData);
    }

    // Step 3: Cancel Stripe subscription
    await cancelSubscription(userData.stripeSubscriptionId);

    // Step 4: Get free plan limits and update user
    const { getLimitsForPlan } = await import('../utils/limitsConfig.js');
    const freeLimits = getLimitsForPlan('free');
    
    await updateDoc(userRef, {
      plan: 'free',
      subscriptionStatus: 'cancelled',
      downgradedAt: new Date().toISOString(),
      // Update limits to free plan limits
      limits: {
        chatTokensDaily: freeLimits.chatTokensDaily,
        chatTokensMonthly: freeLimits.chatTokensMonthly,
        voiceRequestsDaily: freeLimits.voiceRequestsDaily,
        chatRequestsDaily: freeLimits.chatRequestsDaily,
        maxTokensPerRequest: freeLimits.maxTokensPerRequest,
        maxRequestsPerMinute: freeLimits.maxRequestsPerMinute
      },
      // Keep subscription data for reference
      previousPlan: 'premium',
      previousSubscriptionId: userData.stripeSubscriptionId,
      limitsUpdatedAt: new Date().toISOString()
    });

    // Step 5: Log downgrade event
    await addDoc(collection(db, 'plan_changes'), {
      userId,
      action: 'downgrade',
      fromPlan: 'premium',
      toPlan: 'free',
      timestamp: new Date().toISOString(),
      finalInvoiceId: finalInvoice?.id || null,
      finalAmount: usageData.totalCost,
      usagePeriod: `${usageData.currentPeriodStart} to ${usageData.currentDate}`,
      daysUsed: usageData.daysUsed,
      newLimits: freeLimits
    });

    console.log(`✅ Downgraded user ${userId} from premium to free with updated limits:`, freeLimits);

    return {
      finalInvoice: finalInvoice ? {
        id: finalInvoice.id,
        amount: usageData.totalCost,
        description: 'Final API usage charges',
        usagePeriod: `${usageData.currentPeriodStart.split('T')[0]} to ${usageData.currentDate.split('T')[0]}`,
        daysUsed: usageData.daysUsed,
        apiUsageCost: usageData.totalCost,
        platformFeeRefund: 0, // No refund for platform fee
        paymentStatus: finalInvoice.paymentStatus,
        checkoutUrl: finalInvoice.checkoutUrl,
        requiresPayment: finalInvoice.requiresPayment
      } : null,
      newPlan: 'free',
      newLimits: freeLimits,
      subscriptionStatus: 'cancelled',
      message: usageData.totalCost > 0 
        ? `Charged $${usageData.totalCost.toFixed(2)} for ${usageData.daysUsed} days of API usage`
        : 'No charges - no API usage during this period'
    };

  } catch (error) {
    console.error('Error downgrading from premium:', error);
    throw error;
  }
}

/**
 * Calculate prorated API usage since last billing period
 */
export async function calculateProratedUsage(userId, detailed = false) {
  try {
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDoc(userRef);

    if (!userDoc.exists()) {
      throw new Error('User not found');
    }

    const userData = userDoc.data();
    const currentDate = new Date();
    
    // Get current billing period start
    let periodStart;
    if (userData.currentPeriodStart) {
      periodStart = new Date(userData.currentPeriodStart);
    } else if (userData.upgradedAt) {
      periodStart = new Date(userData.upgradedAt);
    } else {
      // Fallback to beginning of current month
      periodStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    }

    // Calculate days used in current period
    const daysUsed = Math.ceil((currentDate - periodStart) / (1000 * 60 * 60 * 24));
    const totalDaysInPeriod = 30; // Approximate month

    // Get API usage from usage tracking
    const usageQuery = query(
      collection(db, 'usage_tracking'),
      where('userId', '==', userId),
      where('timestamp', '>=', periodStart.toISOString()),
      where('timestamp', '<=', currentDate.toISOString())
    );

    const usageDocs = await getDocs(usageQuery);
    let totalCost = 0;
    const breakdown = [];

    // Group usage by date for detailed breakdown
    const usageByDate = {};
    
    usageDocs.forEach(doc => {
      const usage = doc.data();
      const date = usage.timestamp.split('T')[0]; // Get date part
      
      if (!usageByDate[date]) {
        usageByDate[date] = { cost: 0, requests: 0 };
      }
      
      usageByDate[date].cost += usage.cost || 0;
      usageByDate[date].requests += 1;
      totalCost += usage.cost || 0;
    });

    // Create breakdown array if detailed view requested
    if (detailed) {
      Object.entries(usageByDate).forEach(([date, data]) => {
        breakdown.push({
          date,
          cost: Math.round(data.cost * 100) / 100, // Round to 2 decimals
          requests: data.requests
        });
      });
    }

    return {
      currentPeriodStart: periodStart.toISOString(),
      currentDate: currentDate.toISOString(),
      daysUsed,
      totalDaysInPeriod,
      totalCost: Math.round(totalCost * 100) / 100, // Round to 2 decimals
      platformFeeUsed: daysUsed,
      platformFeeTotal: totalDaysInPeriod,
      estimatedFinalCharge: Math.round(totalCost * 100) / 100,
      breakdown: detailed ? breakdown : undefined
    };

  } catch (error) {
    console.error('Error calculating prorated usage:', error);
    throw error;
  }
}

/**
 * Create immediate invoice for API usage only (no platform fee)
 * Returns invoice with checkout URL if immediate payment fails
 */
export async function createImmediateInvoice(userId, usageData) {
  try {
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDoc(userRef);
    const userData = userDoc.data();

    if (!userData.stripeCustomerId) {
      throw new Error('No Stripe customer ID found');
    }

    // Create invoice in Stripe
    const invoice = await stripe.invoices.create({
      customer: userData.stripeCustomerId,
      description: `Final API usage charges (${usageData.daysUsed} days)`,
      metadata: {
        userId,
        type: 'downgrade_final_invoice',
        usagePeriod: `${usageData.currentPeriodStart} to ${usageData.currentDate}`,
        daysUsed: usageData.daysUsed.toString()
      }
    });

    // Add API usage line item
    await stripe.invoiceItems.create({
      customer: userData.stripeCustomerId,
      invoice: invoice.id,
      amount: Math.round(usageData.totalCost * 100), // Convert to cents
      currency: 'usd',
      description: `API usage (${usageData.daysUsed} days): ${usageData.breakdown?.length || 0} requests`
    });

    // Finalize invoice
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
    
    let paymentStatus = 'pending';
    let checkoutUrl = null;
    
    // Attempt to pay immediately
    try {
      await stripe.invoices.pay(finalizedInvoice.id);
      console.log(`✅ Immediate payment successful for invoice ${finalizedInvoice.id}`);
      paymentStatus = 'paid';
    } catch (paymentError) {
      console.log(`⚠️ Immediate payment failed for invoice ${finalizedInvoice.id}, creating checkout URL`);
      
      // Create checkout session for manual payment
      try {
        const checkoutSession = await stripe.checkout.sessions.create({
          customer: userData.stripeCustomerId,
          mode: 'payment',
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: 'Final API Usage Charges',
                  description: `API usage for ${usageData.daysUsed} days before downgrade`
                },
                unit_amount: Math.round(usageData.totalCost * 100)
              },
              quantity: 1
            }
          ],
          success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/success?invoice_id=${finalizedInvoice.id}`,
          cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/cancel?invoice_id=${finalizedInvoice.id}`,
          metadata: {
            userId,
            invoiceId: finalizedInvoice.id,
            type: 'downgrade_final_payment'
          }
        });
        
        checkoutUrl = checkoutSession.url;
        console.log(`✅ Created checkout URL for invoice ${finalizedInvoice.id}: ${checkoutUrl}`);
        
      } catch (checkoutError) {
        console.error('🔥 Error creating checkout session:', checkoutError);
        // Continue without checkout URL - user can pay via invoice email
      }
    }

    // Record in billing history
    await addDoc(collection(db, 'billing_history'), {
      userId,
      invoiceId: finalizedInvoice.id,
      amount: usageData.totalCost,
      currency: 'usd',
      type: 'downgrade_final_charge',
      status: paymentStatus,
      checkoutUrl: checkoutUrl,
      createdAt: new Date().toISOString(),
      description: 'Final API usage charges before downgrade'
    });

    // Return enhanced invoice object with payment info
    return {
      ...finalizedInvoice,
      paymentStatus,
      checkoutUrl,
      requiresPayment: paymentStatus === 'pending'
    };

  } catch (error) {
    console.error('Error creating immediate invoice:', error);
    throw error;
  }
}

/**
 * Cancel Stripe subscription
 */
export async function cancelSubscription(subscriptionId) {
  try {
    // Cancel subscription immediately (not at period end)
    const cancelledSubscription = await stripe.subscriptions.cancel(subscriptionId);
    
    console.log(`✅ Cancelled subscription ${subscriptionId}`);
    return cancelledSubscription;

  } catch (error) {
    console.error('Error cancelling subscription:', error);
    throw error;
  }
}