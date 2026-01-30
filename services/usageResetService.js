/**
 * Usage Reset Service
 * 
 * Handles resetting or adjusting usage counters during plan changes
 */

import { db } from '../firebase.js';
import { doc, getDoc, updateDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { getCurrentMonth } from '../utils/usageHelpers.js';

/**
 * Reset daily usage for a user (sets today's usage to 0)
 * Useful when upgrading to give immediate access to new limits
 * 
 * @param {string} uid - User ID
 * @param {string} reason - Reason for reset (e.g., 'upgrade', 'downgrade')
 * @returns {Promise<Object>} Reset summary
 */
export async function resetDailyUsage(uid, reason = 'plan_change') {
  try {
    const currentMonth = getCurrentMonth();
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    
    // Get current usage document
    const usageDocId = `${uid}_${currentMonth}`;
    const usageRef = doc(db, 'usage', usageDocId);
    const usageSnap = await getDoc(usageRef);
    
    if (!usageSnap.exists()) {
      console.log(`No usage document found for ${uid}, nothing to reset`);
      return { resetTokens: 0, resetVoiceRequests: 0, resetChatRequests: 0 };
    }
    
    const usageData = usageSnap.data();
    const dailyUsage = usageData.dailyUsage || {};
    const dailyRequests = usageData.dailyRequests || {};
    
    // Calculate what we're resetting
    const resetTokens = dailyUsage[today]?.totalTokens || 0;
    const resetVoiceRequests = dailyRequests[today]?.voice || 0;
    const resetChatRequests = dailyRequests[today]?.chat || 0;
    
    // Reset today's usage to 0 (ensure entries exist)
    const updatedDailyUsage = { ...dailyUsage };
    const updatedDailyRequests = { ...dailyRequests };
    
    // Always ensure today's entries exist and are reset to 0
    updatedDailyUsage[today] = {
      totalTokens: 0,
      totalCost: 0,
      requests: 0
    };
    
    updatedDailyRequests[today] = {
      voice: 0,
      chat: 0
    };
    
    // Update usage document
    await updateDoc(usageRef, {
      dailyUsage: updatedDailyUsage,
      dailyRequests: updatedDailyRequests,
      lastResetDate: today,
      lastResetReason: reason,
      lastResetAt: new Date().toISOString()
    });
    
    console.log(`✅ Reset daily usage for ${uid}: ${resetTokens} tokens, ${resetVoiceRequests} voice, ${resetChatRequests} chat`);
    
    return {
      resetTokens,
      resetVoiceRequests,
      resetChatRequests,
      resetDate: today,
      reason
    };
    
  } catch (error) {
    console.error('🔥 Error resetting daily usage:', error);
    throw error;
  }
}

/**
 * Reset monthly usage for a user (sets current month's usage to 0)
 * Use with caution - this resets ALL usage for the current month
 * 
 * @param {string} uid - User ID
 * @param {string} reason - Reason for reset
 * @returns {Promise<Object>} Reset summary
 */
export async function resetMonthlyUsage(uid, reason = 'plan_change') {
  try {
    const currentMonth = getCurrentMonth();
    const usageDocId = `${uid}_${currentMonth}`;
    const usageRef = doc(db, 'usage', usageDocId);
    const usageSnap = await getDoc(usageRef);
    
    if (!usageSnap.exists()) {
      console.log(`No usage document found for ${uid}, nothing to reset`);
      return { resetTokens: 0, resetCost: 0 };
    }
    
    const usageData = usageSnap.data();
    const resetTokens = usageData.totalTokensUsed || 0;
    const resetCost = usageData.totalCostUSD || 0;
    
    // Calculate total requests being reset
    const dailyRequests = usageData.dailyRequests || {};
    let resetVoiceRequests = 0;
    let resetChatRequests = 0;
    
    Object.values(dailyRequests).forEach(dayRequests => {
      resetVoiceRequests += dayRequests.voice || 0;
      resetChatRequests += dayRequests.chat || 0;
    });
    
    // Reset all usage to 0
    await updateDoc(usageRef, {
      totalTokensUsed: 0,
      totalCostUSD: 0,
      dailyUsage: {},
      dailyRequests: {},
      lastResetDate: new Date().toISOString().split('T')[0],
      lastResetReason: reason,
      lastResetAt: new Date().toISOString()
    });
    
    console.log(`✅ Reset monthly usage for ${uid}: ${resetTokens} tokens, $${resetCost}`);
    
    return {
      resetTokens,
      resetCost,
      resetVoiceRequests,
      resetChatRequests,
      resetMonth: currentMonth,
      reason
    };
    
  } catch (error) {
    console.error('🔥 Error resetting monthly usage:', error);
    throw error;
  }
}

/**
 * Apply usage adjustment during plan change
 * Provides flexible options for handling usage during upgrades/downgrades
 * 
 * @param {string} uid - User ID
 * @param {string} planChange - 'upgrade' or 'downgrade'
 * @param {Object} options - Reset options
 * @returns {Promise<Object>} Adjustment summary
 */
export async function applyUsageAdjustment(uid, planChange, options = {}) {
  const {
    resetDaily = false,
    resetMonthly = false,
    grantBonus = false,
    bonusTokens = 0
  } = options;
  
  const adjustments = {
    dailyReset: null,
    monthlyReset: null,
    bonusGranted: null
  };
  
  try {
    // Reset daily usage if requested
    if (resetDaily) {
      adjustments.dailyReset = await resetDailyUsage(uid, planChange);
    }
    
    // Reset monthly usage if requested
    if (resetMonthly) {
      adjustments.monthlyReset = await resetMonthlyUsage(uid, planChange);
    }
    
    // Grant bonus tokens if requested (for upgrades)
    if (grantBonus && bonusTokens > 0 && planChange === 'upgrade') {
      // This would require implementing a bonus system
      console.log(`Would grant ${bonusTokens} bonus tokens to ${uid}`);
      adjustments.bonusGranted = { bonusTokens };
    }
    
    console.log(`✅ Applied usage adjustments for ${uid} (${planChange}):`, adjustments);
    return adjustments;
    
  } catch (error) {
    console.error('🔥 Error applying usage adjustment:', error);
    throw error;
  }
}

/**
 * Get current usage summary for plan change decisions
 * 
 * @param {string} uid - User ID
 * @returns {Promise<Object>} Current usage summary
 */
export async function getCurrentUsageForPlanChange(uid) {
  try {
    const currentMonth = getCurrentMonth();
    const today = new Date().toISOString().split('T')[0];
    
    const usageDocId = `${uid}_${currentMonth}`;
    const usageRef = doc(db, 'usage', usageDocId);
    const usageSnap = await getDoc(usageRef);
    
    if (!usageSnap.exists()) {
      return {
        dailyTokens: 0,
        monthlyTokens: 0,
        dailyVoiceRequests: 0,
        dailyChatRequests: 0,
        monthlyCost: 0
      };
    }
    
    const usageData = usageSnap.data();
    const dailyUsage = usageData.dailyUsage || {};
    const dailyRequests = usageData.dailyRequests || {};
    
    return {
      dailyTokens: dailyUsage[today]?.totalTokens || 0,
      monthlyTokens: usageData.totalTokensUsed || 0,
      dailyVoiceRequests: dailyRequests[today]?.voice || 0,
      dailyChatRequests: dailyRequests[today]?.chat || 0,
      monthlyCost: usageData.totalCostUSD || 0,
      // Calculate monthly request totals
      monthlyVoiceRequests: Object.values(dailyRequests).reduce((sum, day) => sum + (day.voice || 0), 0),
      monthlyChatRequests: Object.values(dailyRequests).reduce((sum, day) => sum + (day.chat || 0), 0),
      currentMonth,
      today
    };
    
  } catch (error) {
    console.error('🔥 Error getting current usage:', error);
    throw error;
  }
}