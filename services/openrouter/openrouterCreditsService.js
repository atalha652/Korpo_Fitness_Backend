/**
 * OpenRouter Credits Service
 * Manages admin's credit balance and token allocation
 */

import { db } from '../../firebase.js';
import {
  doc,
  getDoc,
  updateDoc,
  setDoc,
  collection,
  addDoc,
  serverTimestamp,
  getDocs,
  query,
  orderBy,
  limit,
} from 'firebase/firestore';

const OPENROUTER_CREDITS_DOC = 'main';
const PRICE_PER_M_TOKEN = 1.30;

/**
 * Initialize openrouter_credits collection if it doesn't exist
 * @returns {Promise<void>}
 */
export async function initializeOpenrouterCredits() {
  try {
    const creditsRef = doc(db, 'openrouter_credits', OPENROUTER_CREDITS_DOC);
    const creditsSnap = await getDoc(creditsRef);

    if (!creditsSnap.exists()) {
      console.log('📝 Initializing openrouter_credits collection...');
      await setDoc(creditsRef, {
        credit: 0,
        total: 0,
        wallet: 0,
        used: 0,
        lastUpdated: serverTimestamp(),
        createdAt: serverTimestamp(),
      });
      console.log('✅ openrouter_credits initialized');
    }
  } catch (error) {
    console.error('🔥 Error initializing openrouter_credits:', error);
    throw error;
  }
}

/**
 * Get current openrouter credits status
 * @returns {Promise<Object>} Credits data
 */
export async function getOpenrouterStatus() {
  try {
    const creditsRef = doc(db, 'openrouter_credits', OPENROUTER_CREDITS_DOC);
    const creditsSnap = await getDoc(creditsRef);

    if (!creditsSnap.exists()) {
      await initializeOpenrouterCredits();
      return {
        credit: 0,
        total: 0,
        wallet: 0,
        used: 0,
        lastUpdated: new Date(),
        createdAt: new Date(),
      };
    }

    return creditsSnap.data();
  } catch (error) {
    console.error('🔥 Error getting openrouter status:', error);
    throw error;
  }
}

/**
 * Add credits manually (admin action)
 * @param {number} creditAmount - Dollar amount to add
 * @returns {Promise<Object>} Updated status
 */
export async function addCreditsManually(creditAmount) {
  try {
    if (!creditAmount || creditAmount <= 0) {
      throw new Error('Credit amount must be greater than 0');
    }

    const creditsRef = doc(db, 'openrouter_credits', OPENROUTER_CREDITS_DOC);
    const creditsSnap = await getDoc(creditsRef);

    if (!creditsSnap.exists()) {
      await initializeOpenrouterCredits();
    }

    const currentData = creditsSnap.exists() ? creditsSnap.data() : { credit: 0, total: 0, wallet: 0, used: 0 };

    // Calculate tokens from credit
    const tokensToAdd = Math.floor((creditAmount / PRICE_PER_M_TOKEN) * 1000000);

    const newCredit = (currentData.credit || 0) + creditAmount;
    const newTotal = (currentData.total || 0) + tokensToAdd;
    const newWallet = (currentData.wallet || 0) + tokensToAdd;

    // Update main document
    await updateDoc(creditsRef, {
      credit: newCredit,
      total: newTotal,
      wallet: newWallet,
      lastUpdated: serverTimestamp(),
    });

    // Log transaction
    await addTransactionLog({
      type: 'admin_add',
      creditAdded: creditAmount,
      tokensAdded: tokensToAdd,
      description: 'Admin credit addition',
      balanceAfter: {
        credit: newCredit,
        wallet: newWallet,
        used: currentData.used || 0,
      },
    });

    console.log(`✅ Added $${creditAmount} (${tokensToAdd} tokens) to openrouter credits`);

    return {
      success: true,
      message: `Added $${creditAmount}`,
      credit: newCredit,
      total: newTotal,
      wallet: newWallet,
      used: currentData.used || 0,
    };
  } catch (error) {
    console.error('🔥 Error adding credits:', error);
    throw error;
  }
}

/**
 * Deduct from wallet when user buys tokens
 * @param {number} tokens - Number of tokens purchased
 * @param {number} tokenPrice - Price per token in $
 * @returns {Promise<void>}
 */
export async function deductFromWalletOnPurchase(tokens, tokenPrice) {
  try {
    if (!tokens || tokens <= 0) {
      throw new Error('Token amount must be greater than 0');
    }

    const creditsRef = doc(db, 'openrouter_credits', OPENROUTER_CREDITS_DOC);
    const creditsSnap = await getDoc(creditsRef);

    if (!creditsSnap.exists()) {
      throw new Error('OpenRouter credits not initialized');
    }

    const currentData = creditsSnap.data();
    const currentWallet = currentData.wallet || 0;

    if (currentWallet < tokens) {
      throw new Error(`Insufficient wallet balance. Available: ${currentWallet}, Requested: ${tokens}`);
    }

    const newWallet = currentWallet - tokens;
    const newUsed = (currentData.used || 0) + tokens;
    const creditDeducted = tokenPrice || (tokens / 1000000) * PRICE_PER_M_TOKEN;
    const newCredit = Math.max(0, (currentData.credit || 0) - creditDeducted);

    // Update main document
    await updateDoc(creditsRef, {
      wallet: newWallet,
      used: newUsed,
      credit: newCredit,
      lastUpdated: serverTimestamp(),
    });

    // Log transaction
    await addTransactionLog({
      type: 'user_purchase',
      tokens: tokens,
      creditDeducted: creditDeducted,
      description: `User purchased ${tokens} tokens`,
      balanceAfter: {
        credit: newCredit,
        wallet: newWallet,
        used: newUsed,
      },
    });

    console.log(`✅ Deducted ${tokens} tokens from wallet (User purchase)`);
  } catch (error) {
    console.error('🔥 Error deducting from wallet on purchase:', error);
    throw error;
  }
}

/**
 * Update wallet when user consumes tokens (AI usage)
 * @param {number} tokens - Number of tokens consumed
 * @returns {Promise<void>}
 */
export async function updateWalletOnConsumption(tokens) {
  try {
    if (!tokens || tokens <= 0) {
      throw new Error('Token amount must be greater than 0');
    }

    const creditsRef = doc(db, 'openrouter_credits', OPENROUTER_CREDITS_DOC);
    const creditsSnap = await getDoc(creditsRef);

    if (!creditsSnap.exists()) {
      throw new Error('OpenRouter credits not initialized');
    }

    const currentData = creditsSnap.data();
    const currentWallet = currentData.wallet || 0;
    const currentUsed = currentData.used || 0;

    // Note: Wallet doesn't go negative for consumption (it's deducted from user's balance)
    const newWallet = Math.max(0, currentWallet - tokens);
    const newUsed = currentUsed + tokens;

    // Update main document
    await updateDoc(creditsRef, {
      wallet: newWallet,
      used: newUsed,
      lastUpdated: serverTimestamp(),
    });

    // Log transaction
    await addTransactionLog({
      type: 'user_consumed',
      tokens: tokens,
      description: `User consumed ${tokens} tokens via AI service`,
      balanceAfter: {
        credit: currentData.credit || 0,
        wallet: newWallet,
        used: newUsed,
      },
    });

    console.log(`✅ Updated wallet on consumption: ${tokens} tokens used`);
  } catch (error) {
    console.error('🔥 Error updating wallet on consumption:', error);
    throw error;
  }
}

/**
 * Log transaction to sub-collection
 * @param {Object} transactionData - Transaction details
 * @returns {Promise<void>}
 */
export async function addTransactionLog(transactionData) {
  try {
    const transactionsRef = collection(db, 'openrouter_credits', OPENROUTER_CREDITS_DOC, 'transactions');
    
    await addDoc(transactionsRef, {
      ...transactionData,
      timestamp: serverTimestamp(),
    });

    console.log('✅ Transaction logged');
  } catch (error) {
    console.error('🔥 Error logging transaction:', error);
    // Don't throw - log failure shouldn't block main operations
  }
}

/**
 * Get transaction history
 * @param {number} pageSize - Number of records per page
 * @param {number} pageNumber - Page number
 * @returns {Promise<Object>} Paginated transactions
 */
export async function getTransactionHistory(pageSize = 50, pageNumber = 1) {
  try {
    const transactionsRef = collection(db, 'openrouter_credits', OPENROUTER_CREDITS_DOC, 'transactions');
    
    const q = query(transactionsRef, orderBy('timestamp', 'desc'), limit(pageSize * pageNumber));
    const snapshot = await getDocs(q);

    const transactions = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    const offset = (pageNumber - 1) * pageSize;
    const paginatedTransactions = transactions.slice(offset, offset + pageSize);

    return {
      success: true,
      transactions: paginatedTransactions,
      pagination: {
        total: transactions.length,
        pageSize,
        pageNumber,
        totalPages: Math.ceil(transactions.length / pageSize),
      },
    };
  } catch (error) {
    console.error('🔥 Error fetching transaction history:', error);
    throw error;
  }
}

/**
 * Manual update (admin correction)
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated status
 */
export async function updateOpenrouterStatus(updates) {
  try {
    const creditsRef = doc(db, 'openrouter_credits', OPENROUTER_CREDITS_DOC);
    const creditsSnap = await getDoc(creditsRef);

    if (!creditsSnap.exists()) {
      throw new Error('OpenRouter credits not initialized');
    }

    // Validate updates
    const validFields = ['credit', 'total', 'wallet', 'used'];
    const fieldsToUpdate = {};

    for (const [key, value] of Object.entries(updates)) {
      if (validFields.includes(key)) {
        if (value < 0) {
          throw new Error(`${key} cannot be negative`);
        }
        fieldsToUpdate[key] = value;
      }
    }

    fieldsToUpdate.lastUpdated = serverTimestamp();

    await updateDoc(creditsRef, fieldsToUpdate);

    // Log the update
    const currentData = creditsSnap.data();
    await addTransactionLog({
      type: 'admin_update',
      changes: updates,
      description: 'Admin manual update',
      balanceAfter: { ...currentData, ...fieldsToUpdate },
    });

    console.log('✅ OpenRouter credits updated');

    return {
      success: true,
      message: 'Updated successfully',
      ...fieldsToUpdate,
    };
  } catch (error) {
    console.error('🔥 Error updating openrouter status:', error);
    throw error;
  }
}

/**
 * Reset openrouter credits (use with caution)
 * @returns {Promise<void>}
 */
export async function resetOpenrouterCredits() {
  try {
    const creditsRef = doc(db, 'openrouter_credits', OPENROUTER_CREDITS_DOC);

    await updateDoc(creditsRef, {
      credit: 0,
      total: 0,
      wallet: 0,
      used: 0,
      lastUpdated: serverTimestamp(),
    });

    await addTransactionLog({
      type: 'admin_reset',
      description: 'Admin reset all credits',
      balanceAfter: { credit: 0, total: 0, wallet: 0, used: 0 },
    });

    console.log('⚠️ OpenRouter credits reset');
  } catch (error) {
    console.error('🔥 Error resetting credits:', error);
    throw error;
  }
}

export { PRICE_PER_M_TOKEN };
