/**
 * Usage Service
 * Core business logic for tracking API usage, rate limits, and billing
 * 
 * This service handles:
 * - Reading user limits and current usage
 * - Validating token consumption against limits
 * - Recording usage in Firestore
 * - Calculating costs based on tokens
 */

import { db } from '../firebase.js';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  increment,
  serverTimestamp
} from 'firebase/firestore';

import { calculateTokenCost } from '../utils/tokenPricing.js';
import {
  getCurrentMonth,
  getTodayDate,
  isTimestampNewer,
  extractMonthFromTimestamp
} from '../utils/usageHelpers.js';

/**
 * Get user's current plan and token limits
 * 
 * @param {string} uid - User ID from Firebase
 * @returns {Promise<Object>} User data with plan and limits
 * @throws {Error} If user not found
 */
export async function getUserLimits(uid) {
  try {
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      throw new Error('User not found');
    }

    const user = userSnap.data();

    // Return user plan and limits
    return {
      uid,
      plan: user.plan || 'free',
      limits: user.limits || {
        chatTokensDaily: 50000,
        chatTokensMonthly: 1000000
      },
      stripeCustomerId: user.stripeCustomerId || null
    };
  } catch (error) {
    console.error('🔥 Error getting user limits:', error.message);
    throw error;
  }
}

/**
 * Get current month's usage for a user
 * Creates document if it doesn't exist
 * 
 * @param {string} uid - User ID
 * @returns {Promise<Object>} Usage record
 */
export async function getMonthlyUsage(uid) {
  try {
    const month = getCurrentMonth();
    const docId = `${uid}_${month}`;
    const usageRef = doc(db, 'usage', docId);
    const usageSnap = await getDoc(usageRef);

    if (usageSnap.exists()) {
      return usageSnap.data();
    }

    // Create new usage document for this month
    const newUsage = {
      uid,
      month,
      chatTokens: {
        daily: {}, // Will be populated with YYYY-MM-DD keys
        monthly: 0
      },
      totalCostUSD: 0,
      lastReportedAt: null
    };

    return newUsage;
  } catch (error) {
    console.error('🔥 Error getting monthly usage:', error.message);
    throw error;
  }
}

/**
 * Get today's token usage for a user
 * 
 * @param {string} uid - User ID
 * @param {Object} usage - Usage document from getMonthlyUsage
 * @returns {number} Tokens used today
 */
export function getDailyTokensUsed(uid, usage) {
  const today = getTodayDate();
  return usage.chatTokens?.daily?.[today] || 0;
}

/**
 * Get monthly token usage for a user
 * 
 * @param {string} uid - User ID
 * @param {Object} usage - Usage document from getMonthlyUsage
 * @returns {number} Tokens used this month
 */
export function getMonthlyTokensUsed(uid, usage) {
  return usage.chatTokens?.monthly || 0;
}

/**
 * Check if user can use more tokens
 * Returns false if either daily or monthly limit exceeded
 * 
 * @param {number} dailyUsed - Tokens used today
 * @param {number} dailyLimit - Daily token limit
 * @param {number} monthlyUsed - Tokens used this month
 * @param {number} monthlyLimit - Monthly token limit
 * @returns {boolean} True if user can still use tokens
 */
export function canUseTokens(dailyUsed, dailyLimit, monthlyUsed, monthlyLimit) {
  // Check both limits - must pass both
  return dailyUsed < dailyLimit && monthlyUsed < monthlyLimit;
}

/**
 * Validate token usage report from frontend
 * Checks all constraints before recording
 * 
 * @param {Object} data - Token report data
 * @returns {Object} { valid: boolean, error?: string }
 */
export function validateTokenReport(data) {
  const { model, promptTokens, completionTokens, timestamp } = data;

  // Check model is valid
  const validModels = ['gpt-4o', 'gpt-4o-mini'];
  if (!validModels.includes(model)) {
    return { valid: false, error: `Invalid model: ${model}` };
  }

  // Check promptTokens
  if (!Number.isInteger(promptTokens) || promptTokens <= 0) {
    return { valid: false, error: 'promptTokens must be > 0' };
  }
  if (promptTokens > 8000) {
    return { valid: false, error: 'promptTokens cannot exceed 8000' };
  }

  // Check completionTokens
  if (!Number.isInteger(completionTokens) || completionTokens <= 0) {
    return { valid: false, error: 'completionTokens must be > 0' };
  }
  if (completionTokens > 8000) {
    return { valid: false, error: 'completionTokens cannot exceed 8000' };
  }

  // Check timestamp is valid ISO string
  if (!timestamp || typeof timestamp !== 'string') {
    return { valid: false, error: 'timestamp must be ISO string' };
  }
  try {
    new Date(timestamp).toISOString();
  } catch (error) {
    return { valid: false, error: 'timestamp must be valid ISO string' };
  }

  return { valid: true };
}

/**
 * Record token usage in Firestore
 * Updates daily, monthly totals and cost
 * 
 * @param {string} uid - User ID
 * @param {Object} data - Token report { model, promptTokens, completionTokens, timestamp }
 * @param {number} dailyLimit - User's daily limit
 * @param {number} monthlyLimit - User's monthly limit
 * @returns {Promise<Object>} Updated usage record
 * @throws {Error} If limits exceeded or Firestore error
 */
export async function recordTokenUsage(uid, data, dailyLimit, monthlyLimit) {
  const { model, promptTokens, completionTokens, timestamp } = data;

  try {
    // Get current usage
    const usage = await getMonthlyUsage(uid);
    const dailyUsed = getDailyTokensUsed(uid, usage);
    const monthlyUsed = getMonthlyTokensUsed(uid, usage);

    // Total tokens for this report
    const totalTokens = promptTokens + completionTokens;

    // Check limits BEFORE recording
    if (dailyUsed + totalTokens > dailyLimit) {
      throw {
        code: 'DAILY_LIMIT_EXCEEDED',
        message: `Daily limit exceeded. Used: ${dailyUsed}, Limit: ${dailyLimit}`,
        statusCode: 429
      };
    }

    if (monthlyUsed + totalTokens > monthlyLimit) {
      throw {
        code: 'MONTHLY_LIMIT_EXCEEDED',
        message: `Monthly limit exceeded. Used: ${monthlyUsed}, Limit: ${monthlyLimit}`,
        statusCode: 429
      };
    }

    // Check timestamp is newer than last report
    if (!isTimestampNewer(timestamp, usage.lastReportedAt)) {
      throw {
        code: 'DUPLICATE_REPORT',
        message: 'Timestamp must be newer than last reported',
        statusCode: 400
      };
    }

    // Calculate cost
    const costUSD = calculateTokenCost(model, promptTokens, completionTokens);

    // Prepare Firestore update
    const month = getCurrentMonth();
    const docId = `${uid}_${month}`;
    const today = getTodayDate();
    const usageRef = doc(db, 'usage', docId);

    // Build updates object
    const updates = {};
    updates[`chatTokens.daily.${today}`] = increment(totalTokens);
    updates['chatTokens.monthly'] = increment(totalTokens);
    updates['totalCostUSD'] = increment(costUSD);
    updates['lastReportedAt'] = timestamp;

    // Check if usage document exists
    const usageDocRef = doc(db, 'usage', docId);
    const usageDocSnap = await getDoc(usageDocRef);
    
    if (usageDocSnap.exists()) {
      // Document exists - update it
      await updateDoc(usageRef, updates);
    } else {
      // Create new document
      const newUsageDoc = {
        uid,
        month,
        chatTokens: {
          daily: { [today]: totalTokens },
          monthly: totalTokens
        },
        totalCostUSD: costUSD,
        lastReportedAt: timestamp
      };
      await setDoc(usageRef, newUsageDoc);
    }

    console.log(`✅ Recorded usage for ${uid}: +${totalTokens} tokens, $${costUSD}`);

    return {
      success: true,
      tokensAdded: totalTokens,
      costAdded: costUSD,
      newDailyTotal: dailyUsed + totalTokens,
      newMonthlyTotal: monthlyUsed + totalTokens
    };

  } catch (error) {
    console.error('🔥 Error recording token usage:', error.message);
    throw error;
  }
}

/**
 * Get usage summary for a user (for GET /usage/summary endpoint)
 * 
 * @param {string} uid - User ID
 * @returns {Promise<Object>} Summary with current/daily/monthly usage
 */
export async function getUsageSummary(uid) {
  try {
    const userLimits = await getUserLimits(uid);
    const usage = await getMonthlyUsage(uid);

    const dailyUsed = getDailyTokensUsed(uid, usage);
    const monthlyUsed = getMonthlyTokensUsed(uid, usage);

    return {
      plan: userLimits.plan,
      dailyUsed,
      dailyLimit: userLimits.limits.chatTokensDaily,
      monthlyUsed,
      monthlyLimit: userLimits.limits.chatTokensMonthly,
      totalCostUSD: usage.totalCostUSD || 0,
      month: usage.month,
      lastReportedAt: usage.lastReportedAt
    };
  } catch (error) {
    console.error('🔥 Error getting usage summary:', error.message);
    throw error;
  }
}

/**
 * Check if user can use tokens (for GET /usage/can-use endpoint)
 * 
 * @param {string} uid - User ID
 * @returns {Promise<Object>} { allowed: boolean, remainingDaily: number }
 */
export async function checkCanUseTokens(uid) {
  try {
    const userLimits = await getUserLimits(uid);
    const usage = await getMonthlyUsage(uid);

    const dailyUsed = getDailyTokensUsed(uid, usage);
    const monthlyUsed = getMonthlyTokensUsed(uid, usage);

    const { chatTokensDaily, chatTokensMonthly } = userLimits.limits;

    const dailyAllowed = dailyUsed < chatTokensDaily;
    const monthlyAllowed = monthlyUsed < chatTokensMonthly;
    const canUse = dailyAllowed && monthlyAllowed;

    return {
      allowed: canUse,
      remainingDailyTokens: Math.max(0, chatTokensDaily - dailyUsed),
      remainingMonthlyTokens: Math.max(0, chatTokensMonthly - monthlyUsed),
      dailyUsed,
      monthlyUsed
    };
  } catch (error) {
    console.error('🔥 Error checking can use tokens:', error.message);
    throw error;
  }
}
