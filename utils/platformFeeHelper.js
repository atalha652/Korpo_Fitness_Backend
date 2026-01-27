/**
 * Platform Fee Helper
 * Handles monthly platform fee logic
 * $7 platform fee is charged once per month on billing anniversary
 */

import { db } from '../firebase.js';
import { doc, getDoc } from 'firebase/firestore';

/**
 * Check if user needs to pay platform fee
 * Platform fee is charged once per month on billing anniversary
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Platform fee status
 */
export async function checkPlatformFeeRequired(userId) {
  try {
    if (!userId) {
      return {
        required: true,
        reason: 'No user ID provided',
      };
    }

    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return {
        required: true,
        reason: 'User not found',
      };
    }

    const userData = userSnap.data();
    
    // If user is not premier, no platform fee required
    if (userData.plan !== 'premier') {
      return {
        required: false,
        reason: 'Free plan user - no platform fee required',
      };
    }

    const lastPlatformFeeDate = userData.lastPlatformFeePaymentDate;
    const billingAnniversaryDay = userData.billingAnniversaryDay;

    // If never paid platform fee, it's required (first time upgrade)
    if (!lastPlatformFeeDate) {
      return {
        required: true,
        reason: 'First upgrade - platform fee required',
        lastPaymentDate: null,
      };
    }

    // Convert Firestore timestamp to Date
    const lastPaymentDate = lastPlatformFeeDate.toDate 
      ? lastPlatformFeeDate.toDate() 
      : new Date(lastPlatformFeeDate);

    // Get current date
    const now = new Date();
    const today = now.getDate(); // Day of month (1-31)

    // If no billing anniversary day is set, use the day they last paid
    const anniversaryDay = billingAnniversaryDay || lastPaymentDate.getDate();

    // Check if today is the billing anniversary day
    if (today !== anniversaryDay) {
      return {
        required: false,
        reason: `Not billing anniversary day (anniversary: ${anniversaryDay}, today: ${today})`,
        lastPaymentDate: lastPaymentDate,
        billingAnniversaryDay: anniversaryDay,
        nextBillingDate: getNextBillingDate(anniversaryDay)
      };
    }

    // Check if already paid this month (same month and year)
    const lastPaymentMonth = lastPaymentDate.getMonth();
    const lastPaymentYear = lastPaymentDate.getFullYear();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    // Same month and year = already paid this month
    if (lastPaymentYear === currentYear && lastPaymentMonth === currentMonth) {
      return {
        required: false,
        reason: 'Platform fee already paid this month',
        lastPaymentDate: lastPaymentDate,
        billingAnniversaryDay: anniversaryDay,
        nextBillingDate: getNextBillingDate(anniversaryDay)
      };
    }

    // Different month and it's anniversary day = platform fee required
    return {
      required: true,
      reason: `Billing anniversary day - platform fee required (day ${anniversaryDay})`,
      lastPaymentDate: lastPaymentDate,
      billingAnniversaryDay: anniversaryDay,
      currentMonth: `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`,
      lastPaymentMonth: `${lastPaymentYear}-${String(lastPaymentMonth + 1).padStart(2, '0')}`,
    };
  } catch (error) {
    console.error('Error checking platform fee requirement:', error);
    // On error, require platform fee for safety
    return {
      required: true,
      reason: 'Error checking fee status',
      error: error.message,
    };
  }
}

/**
 * Get next billing date based on anniversary day
 * @param {number} anniversaryDay - Day of month (1-31)
 * @returns {string} Next billing date in ISO format
 */
function getNextBillingDate(anniversaryDay) {
  const now = new Date();
  const nextBilling = new Date(now.getFullYear(), now.getMonth() + 1, anniversaryDay);
  
  // If the anniversary day doesn't exist in next month (e.g., Feb 31), use last day of month
  if (nextBilling.getDate() !== anniversaryDay) {
    nextBilling.setDate(0); // Set to last day of previous month
  }
  
  return nextBilling.toISOString();
}

/**
 * Get platform fee amount
 * @returns {number} Platform fee amount in USD
 */
export function getPlatformFee() {
  return 7.00; // $7 platform fee
}

