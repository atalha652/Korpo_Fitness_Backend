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
  extractMonthFromTimestamp,
  getTimeUntilReset
} from '../utils/usageHelpers.js';
import { getLimitsForPlan } from '../utils/limitsConfig.js';

// ============ HARDCODED LIMITS ============
// Update these values as needed for your business requirements
// NOTE: These are now managed in utils/limitsConfig.js for centralized control

/**
 * Get hardcoded limits based on user plan
 * @param {string} plan - User plan ('free' or 'premium')
 * @returns {Object} Limits object with daily and monthly token limits
 */
export function getHardcodedLimits(plan = 'free') {
  return getLimitsForPlan(plan);
}

/**
 * Get user's current plan and token limits
 * Prioritizes database-stored limits over hardcoded limits for flexibility
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
    const userPlan = user.plan || 'free';
    
    // Check if user has custom limits stored in database (from plan changes)
    let limits;
    if (user.limits && user.limitsUpdatedAt) {
      // Use database-stored limits (updated during plan changes)
      limits = user.limits;
      console.log(`📊 Using database-stored limits for ${uid} (${userPlan}):`, limits);
    } else {
      // Fallback to hardcoded limits based on plan
      const hardcodedLimits = getHardcodedLimits(userPlan);
      limits = {
        chatTokensDaily: hardcodedLimits.chatTokensDaily,
        chatTokensMonthly: hardcodedLimits.chatTokensMonthly,
        voiceRequestsDaily: hardcodedLimits.voiceRequestsDaily,
        chatRequestsDaily: hardcodedLimits.chatRequestsDaily,
        maxTokensPerRequest: hardcodedLimits.maxTokensPerRequest,
        maxRequestsPerMinute: hardcodedLimits.maxRequestsPerMinute
      };
      console.log(`📊 Using hardcoded limits for ${uid} (${userPlan}):`, limits);
    }

    // Return user plan and limits
    return {
      uid,
      plan: userPlan,
      limits,
      stripeCustomerId: user.stripeCustomerId || null,
      limitsSource: user.limitsUpdatedAt ? 'database' : 'hardcoded',
      limitsUpdatedAt: user.limitsUpdatedAt || null
    };
  } catch (error) {
    console.error('🔥 Error getting user limits:', error.message);
    throw error;
  }
}

/**
 * Get current month's usage for a user
 * Handles both old format (just UID) and new format (UID_MONTH)
 * 
 * @param {string} uid - User ID
 * @returns {Promise<Object>} Usage record
 */
export async function getMonthlyUsage(uid) {
  try {
    const month = getCurrentMonth();
    
    // Try new format first: uid_month
    const newFormatDocId = `${uid}_${month}`;
    let usageRef = doc(db, 'usage', newFormatDocId);
    let usageSnap = await getDoc(usageRef);

    if (usageSnap.exists()) {
      return usageSnap.data();
    }

    // Try old format: just uid
    usageRef = doc(db, 'usage', uid);
    usageSnap = await getDoc(usageRef);

    if (usageSnap.exists()) {
      const data = usageSnap.data();
      
      // Check if this document is for the current month
      const docMonth = data.month || data.chatTokens?.month;
      if (docMonth === month) {
        return data;
      }
    }

    // Neither format found or wrong month - return empty structure
    const newUsage = {
      uid,
      month,
      chatTokens: {
        daily: {}, // Will be populated with YYYY-MM-DD keys
        monthly: 0
      },
      requests: {
        voice: {
          daily: {}, // Will be populated with YYYY-MM-DD keys
          monthly: 0
        },
        chat: {
          daily: {}, // Will be populated with YYYY-MM-DD keys
          monthly: 0
        }
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
 * Get today's voice request usage for a user
 * 
 * @param {string} uid - User ID
 * @param {Object} usage - Usage document from getMonthlyUsage
 * @returns {number} Voice requests used today
 */
export function getDailyVoiceRequestsUsed(uid, usage) {
  const today = getTodayDate();
  // Check new format first (top-level requests)
  if (usage.requests?.voice?.daily?.[today]) {
    return usage.requests.voice.daily[today];
  }
  // Check old format (nested under chatTokens)
  if (usage.chatTokens?.requests?.voice?.daily?.[today]) {
    return usage.chatTokens.requests.voice.daily[today];
  }
  return 0;
}

/**
 * Get today's chat request usage for a user
 * 
 * @param {string} uid - User ID
 * @param {Object} usage - Usage document from getMonthlyUsage
 * @returns {number} Chat requests used today
 */
export function getDailyChatRequestsUsed(uid, usage) {
  const today = getTodayDate();
  // Check new format first (top-level requests)
  if (usage.requests?.chat?.daily?.[today]) {
    return usage.requests.chat.daily[today];
  }
  // Check old format (nested under chatTokens)
  if (usage.chatTokens?.requests?.chat?.daily?.[today]) {
    return usage.chatTokens.requests.chat.daily[today];
  }
  return 0;
}

/**
 * Get monthly voice request usage for a user
 * 
 * @param {string} uid - User ID
 * @param {Object} usage - Usage document from getMonthlyUsage
 * @returns {number} Voice requests used this month
 */
export function getMonthlyVoiceRequestsUsed(uid, usage) {
  // Check new format first (top-level requests)
  if (usage.requests?.voice?.monthly) {
    return usage.requests.voice.monthly;
  }
  // Check old format (nested under chatTokens)
  if (usage.chatTokens?.requests?.voice?.monthly) {
    return usage.chatTokens.requests.voice.monthly;
  }
  return 0;
}

/**
 * Get monthly chat request usage for a user
 * 
 * @param {string} uid - User ID
 * @param {Object} usage - Usage document from getMonthlyUsage
 * @returns {number} Chat requests used this month
 */
export function getMonthlyChatRequestsUsed(uid, usage) {
  // Check new format first (top-level requests)
  if (usage.requests?.chat?.monthly) {
    return usage.requests.chat.monthly;
  }
  // Check old format (nested under chatTokens)
  if (usage.chatTokens?.requests?.chat?.monthly) {
    return usage.chatTokens.requests.chat.monthly;
  }
  return 0;
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

    // Verify the data was actually written by re-reading it
    const verifyUsage = await getMonthlyUsage(uid);
    const verifyDailyUsed = getDailyTokensUsed(uid, verifyUsage);
    const verifyMonthlyUsed = getMonthlyTokensUsed(uid, verifyUsage);

    return {
      success: true,
      tokensAdded: totalTokens,
      costAdded: costUSD,
      newDailyTotal: verifyDailyUsed,
      newMonthlyTotal: verifyMonthlyUsed
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

    // Get request usage
    const dailyVoiceRequestsUsed = getDailyVoiceRequestsUsed(uid, usage);
    const dailyChatRequestsUsed = getDailyChatRequestsUsed(uid, usage);
    const monthlyVoiceRequestsUsed = getMonthlyVoiceRequestsUsed(uid, usage);
    const monthlyChatRequestsUsed = getMonthlyChatRequestsUsed(uid, usage);

    // Handle both document formats for month and lastReportedAt
    const month = usage.month || usage.chatTokens?.month;
    const lastReportedAt = usage.lastReportedAt || usage.chatTokens?.lastReportedAt;
    const totalCostUSD = usage.totalCostUSD || usage.chatTokens?.totalCostUSD || 0;

    return {
      plan: userLimits.plan,
      // Token usage
      dailyUsed,
      dailyLimit: userLimits.limits.chatTokensDaily,
      monthlyUsed,
      monthlyLimit: userLimits.limits.chatTokensMonthly,
      // Request usage
      dailyVoiceRequestsUsed,
      dailyChatRequestsUsed,
      monthlyVoiceRequestsUsed,
      monthlyChatRequestsUsed,
      voiceRequestsLimit: userLimits.limits.voiceRequestsDaily,
      chatRequestsLimit: userLimits.limits.chatRequestsDaily,
      // General
      totalCostUSD,
      month,
      lastReportedAt
    };
  } catch (error) {
    console.error('🔥 Error getting usage summary:', error.message);
    throw error;
  }
}

/**
 * Check if user can use tokens (for GET /usage/can-use endpoint)
 * Uses hardcoded limits and checks against usage collection by uid
 * Now includes request limits for voice and chat
 * 
 * @param {string} uid - User ID
 * @returns {Promise<Object>} { allowed: boolean, remainingDaily: number, reason?: string }
 */
export async function checkCanUseTokens(uid) {
  try {
    // Get user plan and hardcoded limits
    const userLimits = await getUserLimits(uid);
    const { 
      chatTokensDaily, 
      chatTokensMonthly, 
      voiceRequestsDaily, 
      chatRequestsDaily 
    } = userLimits.limits;
    
    // Get current usage from usage collection
    const usage = await getMonthlyUsage(uid);
    
    // Calculate current token usage
    const dailyTokensUsed = getDailyTokensUsed(uid, usage);
    const monthlyTokensUsed = getMonthlyTokensUsed(uid, usage);

    // Calculate current request usage
    const dailyVoiceRequestsUsed = getDailyVoiceRequestsUsed(uid, usage);
    const dailyChatRequestsUsed = getDailyChatRequestsUsed(uid, usage);
    const monthlyVoiceRequestsUsed = getMonthlyVoiceRequestsUsed(uid, usage);
    const monthlyChatRequestsUsed = getMonthlyChatRequestsUsed(uid, usage);

    // Check token limits
    const dailyTokensAllowed = dailyTokensUsed < chatTokensDaily;
    const monthlyTokensAllowed = monthlyTokensUsed < chatTokensMonthly;
    
    // Check request limits
    const dailyVoiceRequestsAllowed = dailyVoiceRequestsUsed < voiceRequestsDaily;
    const dailyChatRequestsAllowed = dailyChatRequestsUsed < chatRequestsDaily;

    // Separate permissions for voice and chat features
    const allowedVoice = dailyTokensAllowed && monthlyTokensAllowed && dailyVoiceRequestsAllowed;
    const allowedChat = dailyTokensAllowed && monthlyTokensAllowed && dailyChatRequestsAllowed;
    
    // Overall allowed (for backward compatibility)
    const canUse = allowedVoice && allowedChat;

    // Determine reasons for blocking
    let reason = null;
    let voiceBlockedReason = null;
    let chatBlockedReason = null;
    
    // Check what's blocking voice
    if (!allowedVoice) {
      if (!dailyTokensAllowed) {
        voiceBlockedReason = `Daily token limit exceeded (${dailyTokensUsed}/${chatTokensDaily} tokens used)`;
      } else if (!monthlyTokensAllowed) {
        voiceBlockedReason = `Monthly token limit exceeded (${monthlyTokensUsed}/${chatTokensMonthly} tokens used)`;
      } else if (!dailyVoiceRequestsAllowed) {
        voiceBlockedReason = `Daily voice request limit exceeded (${dailyVoiceRequestsUsed}/${voiceRequestsDaily} requests used)`;
      }
    }
    
    // Check what's blocking chat
    if (!allowedChat) {
      if (!dailyTokensAllowed) {
        chatBlockedReason = `Daily token limit exceeded (${dailyTokensUsed}/${chatTokensDaily} tokens used)`;
      } else if (!monthlyTokensAllowed) {
        chatBlockedReason = `Monthly token limit exceeded (${monthlyTokensUsed}/${chatTokensMonthly} tokens used)`;
      } else if (!dailyChatRequestsAllowed) {
        chatBlockedReason = `Daily chat request limit exceeded (${dailyChatRequestsUsed}/${chatRequestsDaily} requests used)`;
      }
    }
    
    // Set overall reason (prioritize the most restrictive)
    if (!canUse) {
      if (!dailyTokensAllowed) {
        reason = `Daily token limit exceeded (${dailyTokensUsed}/${chatTokensDaily} tokens used)`;
      } else if (!monthlyTokensAllowed) {
        reason = `Monthly token limit exceeded (${monthlyTokensUsed}/${chatTokensMonthly} tokens used)`;
      } else if (!dailyVoiceRequestsAllowed && !dailyChatRequestsAllowed) {
        reason = `Both voice and chat request limits exceeded`;
      } else if (!dailyVoiceRequestsAllowed) {
        reason = `Daily voice request limit exceeded (${dailyVoiceRequestsUsed}/${voiceRequestsDaily} requests used)`;
      } else if (!dailyChatRequestsAllowed) {
        reason = `Daily chat request limit exceeded (${dailyChatRequestsUsed}/${chatRequestsDaily} requests used)`;
      }
    }

    console.log(`🔍 Can-use check for ${uid} (${userLimits.plan}): Voice=${allowedVoice ? 'ALLOWED' : 'BLOCKED'}, Chat=${allowedChat ? 'ALLOWED' : 'BLOCKED'} - Tokens: ${dailyTokensUsed}/${chatTokensDaily}, Voice: ${dailyVoiceRequestsUsed}/${voiceRequestsDaily}, Chat: ${dailyChatRequestsUsed}/${chatRequestsDaily}`);

    // Get time until next reset
    const resetInfo = getTimeUntilReset();

    return {
      allowedVoice,    // Can user use voice features?
      allowedChat,     // Can user use chat features?
      // Token limits
      remainingDailyTokens: Math.max(0, chatTokensDaily - dailyTokensUsed),
      remainingMonthlyTokens: Math.max(0, chatTokensMonthly - monthlyTokensUsed),
      dailyUsed: dailyTokensUsed,
      monthlyUsed: monthlyTokensUsed,
      dailyLimit: chatTokensDaily,
      monthlyLimit: chatTokensMonthly,
      // Request limits
      remainingDailyVoiceRequests: Math.max(0, voiceRequestsDaily - dailyVoiceRequestsUsed),
      remainingDailyChatRequests: Math.max(0, chatRequestsDaily - dailyChatRequestsUsed),
      dailyVoiceRequestsUsed,
      dailyChatRequestsUsed,
      monthlyVoiceRequestsUsed,
      monthlyChatRequestsUsed,
      voiceRequestsLimit: voiceRequestsDaily,
      chatRequestsLimit: chatRequestsDaily,
      // Reset information
      resetInfo: {
        nextResetTime: resetInfo.resetTime,
        hoursUntilReset: resetInfo.hours,
        minutesUntilReset: resetInfo.minutes
      },
      // General
      plan: userLimits.plan,
      reason: reason,
      voiceBlockedReason,  // NEW: Specific reason why voice is blocked (null if allowed)
      chatBlockedReason    // NEW: Specific reason why chat is blocked (null if allowed)
    };
  } catch (error) {
    console.error('🔥 Error checking can use tokens:', error.message);
    throw error;
  }
}

/**
 * Record request usage (voice or chat) in Firestore
 * Updates daily and monthly request counts
 * 
 * @param {string} uid - User ID
 * @param {string} requestType - Type of request ('voice' or 'chat')
 * @param {number} count - Number of requests to add (default: 1)
 * @returns {Promise<Object>} Updated usage record
 * @throws {Error} If limits exceeded or Firestore error
 */
export async function recordRequestUsage(uid, requestType, count = 1) {
  try {
    // Validate request type
    if (!['voice', 'chat'].includes(requestType)) {
      throw new Error(`Invalid request type: ${requestType}. Must be 'voice' or 'chat'`);
    }

    // Get user limits
    const userLimits = await getUserLimits(uid);
    const dailyLimit = requestType === 'voice' 
      ? userLimits.limits.voiceRequestsDaily 
      : userLimits.limits.chatRequestsDaily;

    // Get current usage
    const usage = await getMonthlyUsage(uid);
    const dailyUsed = requestType === 'voice' 
      ? getDailyVoiceRequestsUsed(uid, usage)
      : getDailyChatRequestsUsed(uid, usage);

    // Check limits BEFORE recording
    if (dailyUsed + count > dailyLimit) {
      throw {
        code: `DAILY_${requestType.toUpperCase()}_LIMIT_EXCEEDED`,
        message: `Daily ${requestType} request limit exceeded. Used: ${dailyUsed}, Limit: ${dailyLimit}`,
        statusCode: 429
      };
    }

    // Prepare Firestore update
    const month = getCurrentMonth();
    const docId = `${uid}_${month}`;
    const today = getTodayDate();
    const usageRef = doc(db, 'usage', docId);

    // Build updates object
    const updates = {};
    updates[`requests.${requestType}.daily.${today}`] = increment(count);
    updates[`requests.${requestType}.monthly`] = increment(count);
    updates['lastReportedAt'] = new Date().toISOString();

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
          daily: {},
          monthly: 0
        },
        requests: {
          voice: {
            daily: requestType === 'voice' ? { [today]: count } : {},
            monthly: requestType === 'voice' ? count : 0
          },
          chat: {
            daily: requestType === 'chat' ? { [today]: count } : {},
            monthly: requestType === 'chat' ? count : 0
          }
        },
        totalCostUSD: 0,
        lastReportedAt: new Date().toISOString()
      };
      await setDoc(usageRef, newUsageDoc);
    }

    console.log(`✅ Recorded ${requestType} request usage for ${uid}: +${count} requests`);

    // Verify the data was written
    const verifyUsage = await getMonthlyUsage(uid);
    const verifyDailyUsed = requestType === 'voice' 
      ? getDailyVoiceRequestsUsed(uid, verifyUsage)
      : getDailyChatRequestsUsed(uid, verifyUsage);

    return {
      success: true,
      requestType,
      requestsAdded: count,
      newDailyTotal: verifyDailyUsed
    };

  } catch (error) {
    console.error(`🔥 Error recording ${requestType} request usage:`, error.message);
    throw error;
  }
}
