/**
 * Billing Service
 * Handles monthly billing calculations and Stripe integration
 */

import { db } from '../firebase.js';
import Stripe from 'stripe';
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
 * Calculates API usage cost + platform fee
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

    // Get usage for this month
    const usageDocId = `${uid}_${invoiceMonth}`;
    const usageRef = doc(db, 'usage', usageDocId);
    const usageSnap = await getDoc(usageRef);

    const apiUsageCost = usageSnap.exists() ? (usageSnap.data().totalCostUSD || 0) : 0;

    // Calculate total (platform fee + API usage)
    const totalAmount = PLATFORM_FEE + apiUsageCost;

    const invoiceData = {
      uid,
      month: invoiceMonth,
      platformFee: PLATFORM_FEE,
      apiUsageCost,
      totalAmount,
      status: 'draft',
      createdAt: new Date().toISOString(),
      dueDate: getInvoiceDueDate(),
      paidAt: null,
      stripeInvoiceId: null
    };

    // Save invoice to Firestore
    const invoiceRef = doc(db, 'invoices', `${uid}_${invoiceMonth}`);
    await setDoc(invoiceRef, invoiceData);

    console.log(`✅ Generated invoice for ${uid}: $${totalAmount}`);
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
