/**
 * Balance Checking Middleware
 * Uses "amount" field from users collection
 * Validates user has positive balance for chat access
 */

import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase.js';

/**
 * Check user's token balance in Firestore
 * @param {string} userId - User ID
 * @returns {Promise<Object>} { hasBalance, balance, message }
 */
export async function checkUserBalance(userId) {
  try {
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('Valid userId is required');
    }

    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return {
        hasBalance: false,
        balance: 0,
        message: 'User not found'
      };
    }

    const userData = userSnap.data();
    const balance = userData.tokenBalance || 0;  // Uses "tokenBalance" field
    const hasBalance = balance > 0;

    return {
      hasBalance: hasBalance,
      balance: balance,
      message: hasBalance 
        ? `Balance available: ${balance} tokens`
        : 'Insufficient balance. Purchase to chat.'
    };
  } catch (error) {
    console.error('Error checking user balance:', error);
    throw error;
  }
}

/**
 * Middleware: Require positive amount
 * Use in routes: router.post('/endpoint', requirePositiveBalance, handler)
 */
export async function requirePositiveBalance(req, res, next) {
  try {
    const userId = req.body.userId || req.params.userId;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    const balanceCheck = await checkUserBalance(userId);

    if (!balanceCheck.hasBalance) {
      return res.status(403).json({
        success: false,
        error: balanceCheck.message,
        balance: balanceCheck.balance,
        requiredBalance: '> 0'
      });
    }

    // Balance OK, continue to next handler
    next();
  } catch (error) {
    console.error('Error in balance middleware:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
}
