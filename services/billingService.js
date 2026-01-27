/**
 * Billing Service
 * Handles monthly billing calculations and Stripe integration
 */

import { db } from '../firebase.js';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import { getLimitsForPlan } from '../utils/limitsConfig.js';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs
} from 'firebase/firestore';
import { getCurrentMonth } from '../utils/usageHelpers.js';

// Setup email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Initialize Stripe with API key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Platform fee for premier users
const PLATFORM_FEE = 7.00;

/**
 * Create or get Stripe customer for user
 * 
 * @param {string} uid - User ID
 * @param {string} email - User email
 * @returns {Promise<string>} Stripe customer ID
 */
export async function getOrCreateStripeCustomer(uid, email) {
  try {
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      throw new Error('User not found');
    }

    const user = userSnap.data();

    // If customer already exists, return it
    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    // Create new Stripe customer
    const customer = await stripe.customers.create({
      email: email || user.email,
      metadata: {
        uid: uid,
        createdAt: new Date().toISOString()
      }
    });

    // Save customer ID to Firestore
    await updateDoc(userRef, {
      stripeCustomerId: customer.id
    });

    console.log(`✅ Created Stripe customer for ${uid}: ${customer.id}`);
    return customer.id;

  } catch (error) {
    console.error('🔥 Error creating Stripe customer:', error.message);
    throw error;
  }
}

/**
 * Create Stripe checkout session for plan upgrade
 * 
 * @param {string} uid - User ID
 * @param {string} email - User email
 * @param {string} successUrl - URL to redirect after success
 * @param {string} cancelUrl - URL to redirect if cancelled
 * @returns {Promise<string>} Stripe checkout session URL
 */
export async function createUpgradeCheckout(uid, email, successUrl, cancelUrl) {
  try {
    // Get or create Stripe customer
    const customerId = await getOrCreateStripeCustomer(uid, email);

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Korpo Premier Plan',
              description: 'Unlimited access to AI features'
            },
            unit_amount: Math.round(PLATFORM_FEE * 100) // Convert to cents
          },
          quantity: 1
        }
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        uid: uid,
        planType: 'premier',
        upgradeDate: new Date().toISOString()
      }
    });

    console.log(`✅ Created checkout session for ${uid}: ${session.id}`);
    return session.url;

  } catch (error) {
    console.error('🔥 Error creating checkout session:', error.message);
    throw error;
  }
}

/**
 * Generate monthly invoice for premier user
 * BILLING LOGIC:
 * - User pays platform fee on upgrade (e.g., Jan 27)
 * - First invoice: One month later (e.g., Feb 27) with platform fee + API usage from previous month
 * - Subsequent invoices: Monthly on anniversary date with platform fee + API usage
 * 
 * @param {string} uid - User ID
 * @param {string} month - Month in YYYY-MM format (optional, defaults to last month)
 * @returns {Promise<Object>} Invoice details
 */
export async function generateMonthlyInvoice(uid, month = null) {
  try {
    // If no month specified, use previous month
    const invoiceMonth = month || getPreviousMonth();

    // Get user data
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      throw new Error('User not found');
    }

    const user = userSnap.data();

    // Only premier users get charged
    if (user.plan !== 'premier') {
      return {
        uid,
        month: invoiceMonth,
        status: 'free_plan',
        message: 'No invoice for free plan users'
      };
    }

    // CRITICAL: Skip invoicing for the month when user initially paid platform fee
    // This ensures user pays today (Jan 27) but gets first invoice next month (Feb 27)
    const isFirstMonthAfterPayment = await isFirstMonthAfterUpgrade(uid, user.upgradedAt, invoiceMonth);
    if (isFirstMonthAfterPayment) {
      console.log(`⏭️ Skipping invoice for ${uid} - first month after upgrade (${invoiceMonth})`);
      return {
        uid,
        month: invoiceMonth,
        status: 'first_month_skipped',
        message: 'First month after upgrade - no invoice generated',
        upgradedAt: user.upgradedAt,
        nextInvoiceMonth: getNextMonth(invoiceMonth)
      };
    }

    // Get API usage cost from the invoice month (the month we're billing for)
    const usageDocId = `${uid}_${invoiceMonth}`;
    const usageRef = doc(db, 'usage', usageDocId);
    const usageSnap = await getDoc(usageRef);
    const apiUsageCost = usageSnap.exists() ? (usageSnap.data().totalCostUSD || 0) : 0;

    // Calculate total: Platform fee + API usage cost
    const totalAmount = PLATFORM_FEE + apiUsageCost;

    const invoiceData = {
      uid,
      month: invoiceMonth,
      platformFee: PLATFORM_FEE,
      apiUsageCost,
      totalAmount,
      isFirstMonth: false, // This is always false since we skip first month
      status: 'draft',
      createdAt: new Date().toISOString(),
      dueDate: getInvoiceDueDate(),
      paidAt: null,
      stripeInvoiceId: null
    };

    // Save invoice to Firestore
    const invoiceRef = doc(db, 'invoices', `${uid}_${invoiceMonth}`);
    await setDoc(invoiceRef, invoiceData);

    console.log(`✅ Generated RECURRING invoice for ${uid}: $${totalAmount.toFixed(2)} (Platform: $${PLATFORM_FEE.toFixed(2)}, API Usage: $${apiUsageCost.toFixed(2)})`);

    // Send invoice email to user
    if (user.email) {
      console.log(`📧 Attempting to send invoice email to ${user.email}...`);
      try {
        const emailResult = await transporter.sendMail({
          from: `"Korpo Billing" <${process.env.EMAIL_USER}>`,
          to: user.email,
          subject: `Your Korpo Invoice for ${invoiceMonth}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #333;">Monthly Invoice - ${invoiceMonth}</h2>
              
              <p>Hi ${user.name || 'there'},</p>
              
              <p>Your monthly invoice for Korpo Premier is ready.</p>
              
              <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3 style="margin-top: 0;">Invoice Details</h3>
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="padding: 8px 0; border-bottom: 1px solid #ddd;">Platform Fee</td>
                    <td style="padding: 8px 0; border-bottom: 1px solid #ddd; text-align: right;">$${PLATFORM_FEE.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; border-bottom: 1px solid #ddd;">API Usage (${invoiceMonth})</td>
                    <td style="padding: 8px 0; border-bottom: 1px solid #ddd; text-align: right;">$${apiUsageCost.toFixed(2)}</td>
                  </tr>
                  <tr style="font-weight: bold; font-size: 18px;">
                    <td style="padding: 12px 0;">Total Amount</td>
                    <td style="padding: 12px 0; text-align: right; color: #4CAF50;">$${totalAmount.toFixed(2)}</td>
                  </tr>
                </table>
              </div>
              
              <p><strong>Due Date:</strong> ${new Date(invoiceData.dueDate).toLocaleDateString()}</p>
              
              <p style="color: #666; font-size: 14px;">
                This invoice will be automatically charged to your payment method on file.
              </p>
              
              <p>Thank you for using Korpo!</p>
              
              <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
              
              <p style="color: #999; font-size: 12px;">
                Questions? Contact us at support@korpo.ai
              </p>
            </div>
          `
        });
        
        console.log(`✅ Invoice email sent successfully to ${user.email}`);
        console.log(`📬 Message ID: ${emailResult.messageId}`);
      } catch (emailError) {
        console.error('🔥 Error sending invoice email:', emailError.message);
        console.error('🔥 Full error:', emailError);
        // Don't throw - invoice was created successfully
      }
    } else {
      console.log('⚠️ No email address found for user');
    }

    return invoiceData;

  } catch (error) {
    console.error('🔥 Error generating invoice:', error.message);
    throw error;
  }
}

/**
 * Create Stripe invoice for user (sent to Stripe for payment)
 * 
 * @param {string} uid - User ID
 * @param {string} month - Month in YYYY-MM format
 * @returns {Promise<Object>} Stripe invoice details
 */
export async function createStripeInvoice(uid, month) {
  try {
    // Get Stripe customer ID
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      throw new Error('User not found');
    }

    const user = userSnap.data();
    const customerId = user.stripeCustomerId;

    if (!customerId) {
      throw new Error('User does not have Stripe customer ID');
    }

    // Get invoice data
    const invoiceRef = doc(db, 'invoices', `${uid}_${month}`);
    const invoiceSnap = await getDoc(invoiceRef);

    if (!invoiceSnap.exists()) {
      throw new Error('Invoice not found');
    }

    const invoice = invoiceSnap.data();

    // Create Stripe invoice
    const stripeInvoice = await stripe.invoices.create({
      customer: customerId,
      description: `Korpo Monthly Usage - ${month}`,
      metadata: {
        uid,
        month,
        type: 'usage_based'
      }
    });

    // Add line items to invoice
    // 1. Platform fee
    await stripe.invoiceItems.create({
      customer: customerId,
      amount: Math.round(PLATFORM_FEE * 100), // Convert to cents
      currency: 'usd',
      description: 'Platform Fee',
      invoice: stripeInvoice.id
    });

    // 2. API usage cost
    if (invoice.apiUsageCost > 0) {
      await stripe.invoiceItems.create({
        customer: customerId,
        amount: Math.round(invoice.apiUsageCost * 100),
        currency: 'usd',
        description: `API Usage - ${month}`,
        invoice: stripeInvoice.id
      });
    }

    // Finalize invoice
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(stripeInvoice.id);

    // Update Firestore with Stripe invoice ID
    await updateDoc(invoiceRef, {
      status: 'pending_payment',
      stripeInvoiceId: stripeInvoice.id
    });

    console.log(`✅ Created Stripe invoice for ${uid}: ${stripeInvoice.id}`);
    return finalizedInvoice;

  } catch (error) {
    console.error('🔥 Error creating Stripe invoice:', error.message);
    throw error;
  }
}

/**
 * Get previous month in YYYY-MM format
 * @returns {string} Previous month (e.g., "2024-12")
 */
export function getPreviousMonth() {
  const date = new Date();
  date.setMonth(date.getMonth() - 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Get invoice due date (30 days from now)
 * @returns {string} ISO date string
 */
function getInvoiceDueDate() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString();
}

/**
 * Check if this is the first month after user upgrade (skip invoicing)
 * @param {string} uid - User ID
 * @param {string} upgradedAt - User upgrade timestamp
 * @param {string} invoiceMonth - Month being invoiced (YYYY-MM)
 * @returns {Promise<boolean>} True if this is the first month after upgrade
 */
async function isFirstMonthAfterUpgrade(uid, upgradedAt, invoiceMonth) {
  try {
    if (!upgradedAt) {
      return false; // No upgrade date means not first month
    }

    // Parse upgrade date
    const upgradeDate = new Date(upgradedAt);
    const upgradeYear = upgradeDate.getFullYear();
    const upgradeMonth = upgradeDate.getMonth() + 1; // getMonth() returns 0-11
    const upgradeMonthStr = `${upgradeYear}-${String(upgradeMonth).padStart(2, '0')}`;

    // Parse invoice month
    const [invoiceYear, invoiceMonthNum] = invoiceMonth.split('-');
    
    // If invoice month is the same as upgrade month, it's the first month
    const isFirstMonth = upgradeMonthStr === invoiceMonth;
    
    console.log(`🔍 First month check for ${uid}: Upgrade=${upgradeMonthStr}, Invoice=${invoiceMonth}, IsFirst=${isFirstMonth}`);
    
    return isFirstMonth;

  } catch (error) {
    console.error('🔥 Error checking first month:', error.message);
    return false; // Default to false on error
  }
}

/**
 * Get all premier users that need billing
 * (For cron job to run monthly billing)
 * 
 * @returns {Promise<Array>} List of premier users
 */
export async function getPremierUsers() {
  try {
    const usersRef = collection(db, 'users');
    const q = query(usersRef, where('plan', '==', 'premier'));
    const querySnapshot = await getDocs(q);

    const users = [];
    querySnapshot.forEach(doc => {
      users.push({
        uid: doc.id,
        ...doc.data()
      });
    });

    console.log(`✅ Found ${users.length} premier users`);
    return users;

  } catch (error) {
    console.error('🔥 Error getting premier users:', error.message);
    throw error;
  }
}

/**
 * Update user plan to premier after successful payment
 * Stores billing anniversary date (day of month when user paid)
 * 
 * @param {string} uid - User ID
 * @param {Object} newLimits - New token limits for premier plan
 * @returns {Promise<void>}
 */
export async function upgradeToPremier(uid, newLimits) {
  try {
    const userRef = doc(db, 'users', uid);
    const today = new Date();
    const billingDayOfMonth = today.getDate(); // e.g., 21
    
    await updateDoc(userRef, {
      plan: 'premier',
      limits: newLimits,
      upgradedAt: new Date().toISOString(),
      billingAnniversaryDay: billingDayOfMonth // Store day (1-31) for recurring billing
    });

    console.log(`✅ Upgraded user ${uid} to premier - billing anniversary set to day ${billingDayOfMonth}`);

  } catch (error) {
    console.error('🔥 Error upgrading to premier:', error.message);
    throw error;
  }
}

/**
 * Get all premier users whose billing anniversary is today
 * @returns {Promise<Array>} List of premier users with anniversary today
 */
export async function getPremierUsersByAnniversary() {
  try {
    const usersRef = collection(db, 'users');
    const q = query(usersRef, where('plan', '==', 'premier'));
    const querySnapshot = await getDocs(q);

    const today = new Date();
    const todayDate = today.getDate(); // e.g., 21

    const usersWithAnniversaryToday = [];
    querySnapshot.forEach(doc => {
      const user = doc.data();
      // If user has a billing anniversary day and it matches today, include them
      if (user.billingAnniversaryDay === todayDate) {
        usersWithAnniversaryToday.push({
          uid: doc.id,
          ...user
        });
      }
    });

    console.log(`✅ Found ${usersWithAnniversaryToday.length} premier users with anniversary today (${todayDate})`);
    return usersWithAnniversaryToday;

  } catch (error) {
    console.error('🔥 Error getting users by anniversary:', error.message);
    throw error;
  }
}
/**
 * Get next month in YYYY-MM format
 * @param {string} currentMonth - Current month in YYYY-MM format
 * @returns {string} Next month (e.g., "2024-02")
 */
export function getNextMonth(currentMonth) {
  const [year, month] = currentMonth.split('-');
  const date = new Date(parseInt(year), parseInt(month) - 1); // month is 0-indexed
  date.setMonth(date.getMonth() + 1);
  const nextYear = date.getFullYear();
  const nextMonth = String(date.getMonth() + 1).padStart(2, '0');
  return `${nextYear}-${nextMonth}`;
}

/**
 * Check if this is the first invoice after user upgraded to premier
 * @param {string} uid - User ID
 * @param {string} upgradedAt - ISO date string when user upgraded
 * @returns {Promise<boolean>} True if this is the first invoice
 */
async function isFirstInvoiceAfterUpgrade(uid, upgradedAt) {
  try {
    if (!upgradedAt) {
      // If no upgrade date, assume it's not the first invoice
      return false;
    }

    // Check if any invoices exist for this user
    const invoicesRef = collection(db, 'invoices');
    const q = query(invoicesRef, where('uid', '==', uid));
    const querySnapshot = await getDocs(q);

    // If no invoices exist, this is the first one
    if (querySnapshot.empty) {
      return true;
    }

    // If invoices exist, this is not the first one
    return false;

  } catch (error) {
    console.error('🔥 Error checking first invoice status:', error.message);
    // Default to false if we can't determine
    return false;
  }
}

/**
 * Update user's platform fee payment date after successful payment
 * This should be called after successful Stripe payment
 * 
 * @param {string} uid - User ID
 * @returns {Promise<void>}
 */
export async function updatePlatformFeePaymentDate(uid) {
  try {
    const userRef = doc(db, 'users', uid);
    const now = new Date();
    
    await updateDoc(userRef, {
      lastPlatformFeePaymentDate: now.toISOString(),
      // Update billing anniversary day if not set
      billingAnniversaryDay: now.getDate()
    });

    console.log(`✅ Updated platform fee payment date for ${uid} - anniversary day: ${now.getDate()}`);

  } catch (error) {
    console.error('🔥 Error updating platform fee payment date:', error.message);
    throw error;
  }
}

/**
 * Process successful platform fee payment
 * Updates user data and handles upgrade logic
 * 
 * @param {string} uid - User ID
 * @param {Object} paymentData - Payment details from Stripe
 * @returns {Promise<Object>} Processing result
 */
export async function processPlatformFeePayment(uid, paymentData) {
  try {
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      throw new Error('User not found');
    }

    const user = userSnap.data();
    const now = new Date();
    const billingDay = now.getDate();

    // Update user with payment info and upgrade to premier if needed
    const updateData = {
      lastPlatformFeePaymentDate: now.toISOString(),
      billingAnniversaryDay: billingDay
    };

    // If user is not premier, upgrade them
    if (user.plan !== 'premier') {
      updateData.plan = 'premier';
      updateData.upgradedAt = now.toISOString();
      // Set premier limits from centralized config
      const premierLimits = getLimitsForPlan('premier');
      updateData.limits = {
        dailyLimit: premierLimits.chatTokensDaily,
        maxTokensPerRequest: premierLimits.maxTokensPerRequest,
        maxRequestsPerMinute: premierLimits.maxRequestsPerMinute
      };
    }

    await updateDoc(userRef, updateData);

    console.log(`✅ Processed platform fee payment for ${uid} - billing anniversary: day ${billingDay}`);

    return {
      success: true,
      uid,
      billingAnniversaryDay: billingDay,
      upgradedToPremier: user.plan !== 'premier',
      nextBillingDate: getNextBillingDate(billingDay)
    };

  } catch (error) {
    console.error('🔥 Error processing platform fee payment:', error.message);
    throw error;
  }
}

/**
 * Get next billing date based on anniversary day
 * @param {number} anniversaryDay - Day of month (1-31)
 * @returns {Date} Next billing date
 */
function getNextBillingDate(anniversaryDay) {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, anniversaryDay);
  
  // If the anniversary day doesn't exist in next month (e.g., Feb 31), use last day of month
  if (nextMonth.getDate() !== anniversaryDay) {
    nextMonth.setDate(0); // Set to last day of previous month
  }
  
  return nextMonth;
}
/**
 * Generate invoice email with payment link
 * @param {Object} params - Email parameters
 * @param {string} params.uid - User ID
 * @param {Object} params.user - User data
 * @param {Object} params.invoiceData - Invoice data
 * @param {string} params.invoiceMonth - Invoice month
 * @returns {Promise<Object>} Email result with payment link
 */
export async function generateInvoiceEmailWithPaymentLink({ uid, user, invoiceData, invoiceMonth }) {
  try {
    // Generate payment link for the invoice
    let paymentLink = null;
    let paymentLinkError = null;
    
    try {
      const { createInvoicePaymentCheckoutSession } = await import('./stripe/platformFeeStripeService.js');
      const checkoutResult = await createInvoicePaymentCheckoutSession({
        userId: uid,
        userEmail: user.email,
        invoiceData: invoiceData
      });
      
      if (checkoutResult.success) {
        paymentLink = checkoutResult.checkoutUrl;
        console.log(`✅ Generated payment link for invoice ${invoiceMonth}: ${paymentLink}`);
      } else {
        paymentLinkError = checkoutResult.error || 'Failed to create checkout session';
      }
    } catch (error) {
      paymentLinkError = error.message;
      console.error('⚠️ Could not generate payment link:', error.message);
    }

    // Send email with or without payment link
    const emailResult = await transporter.sendMail({
      from: `"Korpo Billing" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: `Your Korpo Invoice for ${invoiceMonth} - $${invoiceData.totalAmount.toFixed(2)}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Monthly Invoice - ${invoiceMonth}</h2>
          
          <p>Hi ${user.name || 'there'},</p>
          
          <p>Your monthly invoice for Korpo Premier is ready.</p>
          
          <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Invoice Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #ddd;">Platform Fee</td>
                <td style="padding: 8px 0; border-bottom: 1px solid #ddd; text-align: right;">$${invoiceData.platformFee.toFixed(2)}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #ddd;">API Usage (${invoiceMonth})</td>
                <td style="padding: 8px 0; border-bottom: 1px solid #ddd; text-align: right;">$${invoiceData.apiUsageCost.toFixed(2)}</td>
              </tr>
              <tr style="font-weight: bold; font-size: 18px;">
                <td style="padding: 12px 0;">Total Amount</td>
                <td style="padding: 12px 0; text-align: right; color: #4CAF50;">$${invoiceData.totalAmount.toFixed(2)}</td>
              </tr>
            </table>
          </div>
          
          <p><strong>Due Date:</strong> ${new Date(invoiceData.dueDate).toLocaleDateString()}</p>
          
          ${paymentLink ? `
          <div style="text-align: center; margin: 30px 0;">
            <a href="${paymentLink}" 
               style="background-color: #4CAF50; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; font-size: 16px;">
              💳 Pay Invoice - $${invoiceData.totalAmount.toFixed(2)}
            </a>
          </div>
          
          <p style="color: #666; font-size: 14px; text-align: center;">
            Click the button above to pay your invoice securely with Stripe.<br>
            The payment link expires in 24 hours.
          </p>
          ` : `
          <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="color: #856404; margin: 0; font-size: 14px;">
              <strong>Payment Link Unavailable:</strong> ${paymentLinkError || 'Unable to generate payment link'}.<br>
              Please contact support at support@korpo.ai for assistance with payment.
            </p>
          </div>
          `}
          
          <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h4 style="margin-top: 0; color: #495057;">Payment Information</h4>
            <p style="margin: 5px 0; font-size: 14px; color: #6c757d;">Invoice ID: ${uid}_${invoiceMonth}</p>
            <p style="margin: 5px 0; font-size: 14px; color: #6c757d;">Billing Period: ${invoiceMonth}</p>
            <p style="margin: 5px 0; font-size: 14px; color: #6c757d;">Amount Due: $${invoiceData.totalAmount.toFixed(2)}</p>
          </div>
          
          <p>Thank you for using Korpo!</p>
          
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          
          <p style="color: #999; font-size: 12px;">
            Questions? Contact us at support@korpo.ai<br>
            This is an automated email. Please do not reply directly to this message.
          </p>
        </div>
      `
    });

    console.log(`✅ Invoice email sent successfully to ${user.email}`);
    console.log(`📬 Message ID: ${emailResult.messageId}`);

    return {
      success: true,
      messageId: emailResult.messageId,
      paymentLink,
      paymentLinkError,
      hasPaymentLink: !!paymentLink
    };

  } catch (error) {
    console.error('🔥 Error sending invoice email:', error.message);
    throw error;
  }
}