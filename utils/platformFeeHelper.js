/**
 * Platform Fee Helper
 * Handles monthly platform fee logic
 * $7 platform fee is charged once per month per user
 */

import { db } from '../firebase.js';
import { doc, getDoc } from 'firebase/firestore';

/**
 * Check if user needs to pay platform fee
 * Platform fee is charged once per month
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
    const lastPlatformFeeDate = userData.lastPlatformFeePaymentDate;

    // If never paid platform fee, it's required
    if (!lastPlatformFeeDate) {
      return {
        required: true,
        reason: 'First purchase - platform fee required',
        lastPaymentDate: null,
      };
    }

    // Convert Firestore timestamp to Date
    const lastPaymentDate = lastPlatformFeeDate.toDate 
      ? lastPlatformFeeDate.toDate() 
      : new Date(lastPlatformFeeDate);

    // Get current date
    const now = new Date();

    // Check if last payment was in the same month and year
    const lastPaymentMonth = lastPaymentDate.getMonth();
    const lastPaymentYear = lastPaymentDate.getFullYear();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    // Same month and year = no platform fee needed
    if (lastPaymentYear === currentYear && lastPaymentMonth === currentMonth) {
      return {
        required: false,
        reason: 'Platform fee already paid this month',
        lastPaymentDate: lastPaymentDate,
        currentMonth: `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`,
        lastPaymentMonth: `${lastPaymentYear}-${String(lastPaymentMonth + 1).padStart(2, '0')}`,
      };
    }

    // Different month = platform fee required
    return {
      required: true,
      reason: 'New month - platform fee required',
      lastPaymentDate: lastPaymentDate,
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
 * Get platform fee amount
 * @returns {number} Platform fee amount in USD
 */
export function getPlatformFee() {
  return 7.00; // $7 platform fee
}

