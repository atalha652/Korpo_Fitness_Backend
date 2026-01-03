/**
 * User Token History Service
 * Manages token purchasing history per user
 */

import { db } from '../../firebase.js';
import {
  doc,
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
  getDoc,
} from 'firebase/firestore';

/**
 * Log token purchase to user's history
 * @param {string} userId - User ID
 * @param {number} tokens - Tokens purchased
 * @param {number} price - Price paid in $
 * @param {Object} metadata - Additional metadata (sessionId, etc)
 * @returns {Promise<Object>} Created purchase record
 */
export async function logTokenPurchase(userId, tokens, price, metadata = {}) {
  try {
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('Valid user ID is required');
    }

    if (!tokens || tokens <= 0 || !Number.isInteger(tokens)) {
      throw new Error('Valid positive integer tokens required');
    }

    if (!price || price <= 0) {
      throw new Error('Valid price is required');
    }

    // Get user's current data
    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);

    let totalPurchased = 0;
    let totalUsed = 0;
    let currentWallet = 0;

    if (userSnap.exists()) {
      const userData = userSnap.data();
      currentWallet = userData.tokenBalance || 0;

      // Calculate cumulative totals from existing history if available
      if (userData.tokenHistory && Array.isArray(userData.tokenHistory)) {
        for (const txn of userData.tokenHistory) {
          if (txn.type === 'credit' && txn.source === 'purchase') {
            totalPurchased += txn.amount || 0;
          } else if (txn.type === 'debit') {
            totalUsed += txn.amount || 0;
          }
        }
      }
    }

    // Add new purchase to total
    totalPurchased += tokens;

    // Create purchase record
    const historyRef = collection(db, 'users', userId, 'token_purchasing_history');
    const purchaseRecord = await addDoc(historyRef, {
      purchaseId: `purchase_${Date.now()}`,
      amount: tokens,
      price: price,
      timestamp: serverTimestamp(),
      walletAfterPurchase: currentWallet,
      totalPurchased: totalPurchased,
      totalUsed: totalUsed,
      remainingInWallet: currentWallet,
      sessionId: metadata.sessionId || null,
      paymentStatus: metadata.paymentStatus || 'completed',
      transactionId: metadata.transactionId || null,
      metadata: metadata,
    });

    console.log(`✅ Logged token purchase for user ${userId}: ${tokens} tokens`);

    return {
      success: true,
      purchaseId: purchaseRecord.id,
      amount: tokens,
      price: price,
      totalPurchased: totalPurchased,
      walletAfterPurchase: currentWallet,
    };
  } catch (error) {
    console.error('🔥 Error logging token purchase:', error);
    throw error;
  }
}

/**
 * Log token consumption (when user uses AI)
 * @param {string} userId - User ID
 * @param {number} tokens - Tokens consumed
 * @param {string} reason - Reason for consumption (ai_service, etc)
 * @param {Object} metadata - Additional metadata
 * @returns {Promise<Object>} Created consumption record
 */
export async function logTokenConsumption(userId, tokens, reason = 'ai_service', metadata = {}) {
  try {
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('Valid user ID is required');
    }

    if (!tokens || tokens <= 0 || !Number.isInteger(tokens)) {
      throw new Error('Valid positive integer tokens required');
    }

    // Get user's current data
    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      throw new Error('User not found');
    }

    const userData = userSnap.data();
    const currentWallet = userData.tokenBalance || 0;

    // Calculate cumulative totals
    let totalPurchased = 0;
    let totalUsed = 0;

    if (userData.tokenHistory && Array.isArray(userData.tokenHistory)) {
      for (const txn of userData.tokenHistory) {
        if (txn.type === 'credit' && txn.source === 'purchase') {
          totalPurchased += txn.amount || 0;
        } else if (txn.type === 'debit') {
          totalUsed += txn.amount || 0;
        }
      }
    }

    // Add new consumption to total
    totalUsed += tokens;

    // Create consumption record
    const historyRef = collection(db, 'users', userId, 'token_purchasing_history');
    const consumptionRecord = await addDoc(historyRef, {
      consumptionId: `consumption_${Date.now()}`,
      type: 'ai_consumption',
      amount: tokens,
      reason: reason,
      timestamp: serverTimestamp(),
      walletAfterConsumption: currentWallet,
      totalPurchased: totalPurchased,
      totalUsed: totalUsed,
      remainingInWallet: currentWallet,
      metadata: metadata,
    });

    console.log(`✅ Logged token consumption for user ${userId}: ${tokens} tokens`);

    return {
      success: true,
      consumptionId: consumptionRecord.id,
      amount: tokens,
      totalUsed: totalUsed,
      walletAfterConsumption: currentWallet,
    };
  } catch (error) {
    console.error('🔥 Error logging token consumption:', error);
    throw error;
  }
}

/**
 * Get user's token purchasing history
 * @param {string} userId - User ID
 * @param {number} limit - Number of records to return
 * @returns {Promise<Object>} User's token history
 */
export async function getUserTokenHistory(userId, limit = 50) {
  try {
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('Valid user ID is required');
    }

    const historyRef = collection(db, 'users', userId, 'token_purchasing_history');
    const q = query(historyRef, orderBy('timestamp', 'desc'));

    const snapshot = await getDocs(q);
    const history = snapshot.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data(),
      }))
      .slice(0, limit);

    return {
      success: true,
      userId,
      history,
      count: history.length,
    };
  } catch (error) {
    console.error('🔥 Error fetching user token history:', error);
    throw error;
  }
}

/**
 * Get user's token summary
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Token summary
 */
export async function getUserTokenSummary(userId) {
  try {
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('Valid user ID is required');
    }

    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      throw new Error('User not found');
    }

    const userData = userSnap.data();
    const currentWallet = userData.tokenBalance || 0;

    // Calculate totals from token history
    let totalPurchased = 0;
    let totalUsed = 0;
    let totalSpent = 0;
    let lastPurchaseDate = null;

    if (userData.tokenHistory && Array.isArray(userData.tokenHistory)) {
      for (const txn of userData.tokenHistory) {
        if (txn.type === 'credit' && txn.source === 'purchase') {
          totalPurchased += txn.amount || 0;
          totalSpent += txn.metadata?.totalPrice || 0;
          if (!lastPurchaseDate || new Date(txn.timestamp) > new Date(lastPurchaseDate)) {
            lastPurchaseDate = txn.timestamp;
          }
        } else if (txn.type === 'debit') {
          totalUsed += txn.amount || 0;
        }
      }
    }

    return {
      success: true,
      userId,
      totalPurchased,
      totalUsed,
      remainingInWallet: currentWallet,
      spentTotal: parseFloat(totalSpent.toFixed(2)),
      lastPurchase: lastPurchaseDate,
      percentageUsed: totalPurchased > 0 ? Math.round((totalUsed / totalPurchased) * 100) : 0,
    };
  } catch (error) {
    console.error('🔥 Error fetching user token summary:', error);
    throw error;
  }
}
