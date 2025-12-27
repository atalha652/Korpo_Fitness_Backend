/**
 * Token Controller
 * Handles token-related business logic
 */

import { db } from '../../firebase.js';
import {
  doc,
  getDoc,
  updateDoc,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  increment,
  serverTimestamp,
} from 'firebase/firestore';
import { createChatCompletion, fetchUserCredits } from '../../services/openrouter/openRouterService.js';
import { calculateInternalCost } from '../../utils/tokenPricing.js';

/**
 * Get user's token balance
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Token balance information
 */
export async function getUserTokenBalance(userId) {
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
    const tokenBalance = userData.tokenBalance || 0;
    const tokenHistory = userData.tokenHistory || [];

    return {
      success: true,
      userId,
      balance: tokenBalance,
      history: tokenHistory.slice(-10), // Last 10 transactions
    };
  } catch (error) {
    console.error('Error getting user token balance:', error);
    throw error;
  }
}

/**
 * Add tokens to user's balance
 * @param {string} userId - User ID
 * @param {number} tokens - Number of tokens to add
 * @param {string} source - Source of tokens (purchase, subscription, bonus, etc.)
 * @param {Object} metadata - Additional metadata
 * @returns {Promise<Object>} Updated balance
 */
export async function addTokensToUser(userId, tokens, source = 'manual', metadata = {}) {
  try {
    // Validation
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('Valid user ID is required');
    }
    if (!tokens || typeof tokens !== 'number' || tokens <= 0 || !Number.isInteger(tokens)) {
      throw new Error('Valid positive integer tokens required');
    }

    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      throw new Error('User not found');
    }

    const userData = userSnap.data();
    const currentBalance = userData.tokenBalance || 0;
    const newBalance = currentBalance + tokens;

    // Update user balance and platform fee payment date if this is a purchase
    const updateData = {
      tokenBalance: newBalance,
      lastTokenUpdate: serverTimestamp(),
    };

    // If this is a purchase with platform fee, update last platform fee payment date
    if (source === 'purchase' && metadata.platformFee && metadata.platformFee > 0) {
      updateData.lastPlatformFeePaymentDate = serverTimestamp();
    }

    await updateDoc(userRef, updateData);

    // Record transaction
    const transactionRef = await addDoc(collection(db, 'tokenTransactions'), {
      userId,
      type: 'credit',
      amount: tokens,
      previousBalance: currentBalance,
      newBalance: newBalance,
      source,
      metadata,
      timestamp: serverTimestamp(),
    });

    // Update user's token history
    const tokenHistory = userData.tokenHistory || [];
    tokenHistory.push({
      transactionId: transactionRef.id,
      type: 'credit',
      amount: tokens,
      source,
      timestamp: new Date(),
      ...metadata,
    });

    await updateDoc(userRef, {
      tokenHistory: tokenHistory.slice(-100), // Keep last 100 transactions
    });

    return {
      success: true,
      userId,
      tokensAdded: tokens,
      previousBalance: currentBalance,
      newBalance: newBalance,
      transactionId: transactionRef.id,
    };
  } catch (error) {
    console.error('Error adding tokens to user:', error);
    throw error;
  }
}

/**
 * Deduct tokens from user's balance
 * @param {string} userId - User ID
 * @param {number} tokens - Number of tokens to deduct
 * @param {string} reason - Reason for deduction
 * @param {Object} metadata - Additional metadata
 * @returns {Promise<Object>} Updated balance
 */
export async function deductTokensFromUser(userId, tokens, reason = 'usage', metadata = {}) {
  try {
    // Validation
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('Valid user ID is required');
    }
    if (!tokens || typeof tokens !== 'number' || tokens <= 0 || !Number.isInteger(tokens)) {
      throw new Error('Valid positive integer tokens required');
    }

    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      throw new Error('User not found');
    }

    const userData = userSnap.data();
    const currentBalance = userData.tokenBalance || 0;

    if (currentBalance < tokens) {
      throw new Error('Insufficient token balance');
    }

    const newBalance = currentBalance - tokens;

    // Update user balance
    await updateDoc(userRef, {
      tokenBalance: newBalance,
      lastTokenUpdate: serverTimestamp(),
    });

    // Record transaction
    const transactionRef = await addDoc(collection(db, 'tokenTransactions'), {
      userId,
      type: 'debit',
      amount: tokens,
      previousBalance: currentBalance,
      newBalance: newBalance,
      reason,
      metadata,
      timestamp: serverTimestamp(),
    });

    // Update user's token history
    const tokenHistory = userData.tokenHistory || [];
    tokenHistory.push({
      transactionId: transactionRef.id,
      type: 'debit',
      amount: tokens,
      reason,
      timestamp: new Date(),
      ...metadata,
    });

    await updateDoc(userRef, {
      tokenHistory: tokenHistory.slice(-100), // Keep last 100 transactions
    });

    return {
      success: true,
      userId,
      tokensDeducted: tokens,
      previousBalance: currentBalance,
      newBalance: newBalance,
      transactionId: transactionRef.id,
    };
  } catch (error) {
    console.error('Error deducting tokens from user:', error);
    throw error;
  }
}

/**
 * Process AI service request and deduct tokens
 * @param {string} userId - User ID
 * @param {Object} requestParams - AI service request parameters
 * @returns {Promise<Object>} AI response and token usage
 */
export async function processAIServiceRequest(userId, requestParams) {
  try {
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('Valid user ID is required');
    }

    // Check user balance first
    const balanceInfo = await getUserTokenBalance(userId);
    if (balanceInfo.balance <= 0) {
      throw new Error('Insufficient token balance. Please purchase tokens.');
    }

    // Make AI request to OpenRouter
    const aiResponse = await createChatCompletion({
      messages: requestParams.messages,
      model: requestParams.model || 'google/gemini-3-flash-preview',
      options: requestParams.options || {},
    });

    // Calculate tokens used
    const tokensUsed = aiResponse.usage.totalTokens || 0;
    const promptTokens = aiResponse.usage.promptTokens || 0;
    const completionTokens = aiResponse.usage.completionTokens || 0;

    if (tokensUsed > 0) {
      // Calculate internal cost for tracking
      const internalCost = calculateInternalCost({
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        audioTokens: 0, // Audio tokens if available from OpenRouter
      });

      // Deduct tokens
      await deductTokensFromUser(userId, tokensUsed, 'ai_service', {
        model: requestParams.model || 'google/gemini-3-flash-preview',
        promptTokens,
        completionTokens,
        totalTokens: tokensUsed,
        requestId: aiResponse.id,
        internalCost: internalCost.totalCost,
      });
    }

    return {
      success: true,
      response: aiResponse.choices,
      usage: aiResponse.usage,
      tokensUsed,
      remainingBalance: balanceInfo.balance - tokensUsed,
    };
  } catch (error) {
    console.error('Error processing AI service request:', error);
    throw error;
  }
}

/**
 * Get OpenRouter credit information
 * @returns {Promise<Object>} Credit information
 */
export async function getOpenRouterCredits() {
  try {
    const credits = await fetchUserCredits();
    return {
      success: true,
      ...credits,
    };
  } catch (error) {
    console.error('Error fetching OpenRouter credits:', error);
    throw error;
  }
}

/**
 * Get token transaction history
 * @param {string} userId - User ID
 * @param {number} limit - Number of transactions to retrieve
 * @returns {Promise<Object>} Transaction history
 */
export async function getTokenTransactionHistory(userId, limit = 50) {
  try {
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('Valid user ID is required');
    }

    const transactionsQuery = query(
      collection(db, 'tokenTransactions'),
      where('userId', '==', userId)
    );

    const snapshot = await getDocs(transactionsQuery);
    const transactions = snapshot.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data(),
      }))
      .sort((a, b) => {
        const timeA = a.timestamp?.toDate?.() || new Date(0);
        const timeB = b.timestamp?.toDate?.() || new Date(0);
        return timeB - timeA;
      })
      .slice(0, limit);

    return {
      success: true,
      userId,
      transactions,
      count: transactions.length,
    };
  } catch (error) {
    console.error('Error getting token transaction history:', error);
    throw error;
  }
}

