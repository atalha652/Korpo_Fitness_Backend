/**
 * Admin Stats Service
 * Aggregates and calculates analytics data for admin dashboard
 * 
 * Queries:
 * - Overall platform statistics
 * - Usage breakdown by model, date, user
 * - Revenue analytics
 * - Top users metrics
 */

import { db } from '../../firebase.js';
import {
  collection,
  getDocs,
  doc,
  getDoc,
  query,
  where,
  orderBy,
  limit
} from 'firebase/firestore';

/**
 * Get overall platform overview statistics
 * 
 * @returns {Promise<Object>} Overview data with totals and metrics
 */
export async function getOverviewStats() {
  try {
    // Get all users
    const usersSnapshot = await getDocs(collection(db, 'users'));
    const users = usersSnapshot.docs.map(d => d.data());

    // Get all usage records
    const usageSnapshot = await getDocs(collection(db, 'usage'));
    const usageRecords = usageSnapshot.docs.map(d => d.data());

    // Calculate metrics
    const totalUsers = users.length;
    const activeSubscriptions = users.filter(u => {
      const endDate = u.subscription?.subscription_end_date?.toDate?.() || new Date(0);
      return endDate > new Date() && u.subscription?.is_payed;
    }).length;

    const totalRevenue = users.reduce((sum, u) => {
      return sum + (u.subscription?.amount_paid || 0);
    }, 0);

    const totalTokensUsed = usageRecords.reduce((sum, record) => {
      return sum + (record.chatTokens?.monthly || 0);
    }, 0);

    const totalCostUSD = usageRecords.reduce((sum, record) => {
      return sum + (record.totalCostUSD || 0);
    }, 0);

    const freeUsers = users.filter(u => u.plan !== 'premium').length;
    const premiumUsers = users.filter(u => u.plan === 'premium').length;

    return {
      totalUsers,
      freeUsers,
      premiumUsers,
      activeSubscriptions,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      totalTokensUsed,
      totalCostUSD: parseFloat(totalCostUSD.toFixed(2)),
      averageCostPerUser: totalUsers > 0 ? parseFloat((totalCostUSD / totalUsers).toFixed(2)) : 0,
      averageTokensPerUser: totalUsers > 0 ? Math.round(totalTokensUsed / totalUsers) : 0,
      lastUpdated: new Date().toISOString()
    };
  } catch (error) {
    console.error('🔥 Error getting overview stats:', error.message);
    throw error;
  }
}

/**
 * Get detailed usage statistics with optional filters
 * 
 * @param {Object} filters - { startDate, endDate, model, userId }
 * @returns {Promise<Object>} Usage breakdown data
 */
export async function getUsageStats(filters = {}) {
  try {
    const usageSnapshot = await getDocs(collection(db, 'usage'));
    let usageRecords = usageSnapshot.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    // Filter by user if specified
    if (filters.userId) {
      usageRecords = usageRecords.filter(r => r.uid === filters.userId);
    }

    // Calculate totals and breakdown
    const totalTokens = usageRecords.reduce((sum, r) => sum + (r.chatTokens?.monthly || 0), 0);
    const totalCost = usageRecords.reduce((sum, r) => sum + (r.totalCostUSD || 0), 0);
    const recordCount = usageRecords.length;

    // Group by month
    const byMonth = {};
    usageRecords.forEach(record => {
      const month = record.month || 'unknown';
      if (!byMonth[month]) {
        byMonth[month] = { tokens: 0, cost: 0, users: new Set() };
      }
      byMonth[month].tokens += record.chatTokens?.monthly || 0;
      byMonth[month].cost += record.totalCostUSD || 0;
      byMonth[month].users.add(record.uid);
    });

    // Convert users Set to count
    const monthlyBreakdown = Object.entries(byMonth).map(([month, data]) => ({
      month,
      tokens: data.tokens,
      cost: parseFloat(data.cost.toFixed(2)),
      activeUsers: data.users.size
    }));

    return {
      total: {
        tokens: totalTokens,
        cost: parseFloat(totalCost.toFixed(2)),
        recordCount,
        uniqueUsers: new Set(usageRecords.map(r => r.uid)).size
      },
      byMonth: monthlyBreakdown.sort((a, b) => b.month.localeCompare(a.month)),
      records: usageRecords.map(r => ({
        uid: r.uid,
        month: r.month,
        tokens: r.chatTokens?.monthly || 0,
        cost: parseFloat((r.totalCostUSD || 0).toFixed(2))
      }))
    };
  } catch (error) {
    console.error('🔥 Error getting usage stats:', error.message);
    throw error;
  }
}

/**
 * Get revenue analytics
 * 
 * @returns {Promise<Object>} Revenue breakdown by source
 */
export async function getRevenueStats() {
  try {
    const usersSnapshot = await getDocs(collection(db, 'users'));
    const users = usersSnapshot.docs.map(d => d.data());

    const usageSnapshot = await getDocs(collection(db, 'usage'));
    const usageRecords = usageSnapshot.docs.map(d => d.data());

    // Calculate subscription revenue
    const subscriptionRevenue = users.reduce((sum, u) => {
      return sum + (u.subscription?.amount_paid || 0);
    }, 0);

    // Calculate API usage revenue
    const apiUsageRevenue = usageRecords.reduce((sum, r) => {
      return sum + (r.totalCostUSD || 0);
    }, 0);

    // Count paid vs free users
    const paidSubscriptions = users.filter(u => u.subscription?.is_payed).length;
    const totalSubscriptions = users.filter(u => u.subscription).length;

    // Get monthly revenue
    const monthlyRevenue = {};
    usageRecords.forEach(record => {
      const month = record.month || 'unknown';
      if (!monthlyRevenue[month]) {
        monthlyRevenue[month] = 0;
      }
      monthlyRevenue[month] += record.totalCostUSD || 0;
    });

    users.forEach(u => {
      const month = u.subscription?.current_period_start 
        ? new Date(u.subscription.current_period_start).toISOString().slice(0, 7)
        : 'unknown';
      if (u.subscription?.is_payed) {
        if (!monthlyRevenue[month]) monthlyRevenue[month] = 0;
        monthlyRevenue[month] += u.subscription.amount_paid || 0;
      }
    });

    const monthlyBreakdown = Object.entries(monthlyRevenue)
      .map(([month, revenue]) => ({ month, revenue: parseFloat(revenue.toFixed(2)) }))
      .sort((a, b) => b.month.localeCompare(a.month));

    const totalRevenue = subscriptionRevenue + apiUsageRevenue;

    return {
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      subscriptionRevenue: parseFloat(subscriptionRevenue.toFixed(2)),
      apiUsageRevenue: parseFloat(apiUsageRevenue.toFixed(2)),
      subscriptionPercentage: parseFloat(((subscriptionRevenue / totalRevenue) * 100 || 0).toFixed(2)),
      apiUsagePercentage: parseFloat(((apiUsageRevenue / totalRevenue) * 100 || 0).toFixed(2)),
      paidSubscriptions,
      totalSubscriptions,
      conversionRate: parseFloat(((paidSubscriptions / users.length) * 100 || 0).toFixed(2)),
      monthlyBreakdown
    };
  } catch (error) {
    console.error('🔥 Error getting revenue stats:', error.message);
    throw error;
  }
}

/**
 * Get top users by various metrics
 * 
 * @param {string} metric - 'spenders' | 'tokens' | 'subscriptions'
 * @param {number} count - Number of top users to return (default: 10)
 * @returns {Promise<Array>} Sorted array of top users
 */
export async function getTopUsers(metric = 'spenders', count = 10) {
  try {
    const usersSnapshot = await getDocs(collection(db, 'users'));
    const users = usersSnapshot.docs.map(d => ({
      uid: d.id,
      ...d.data()
    }));

    const usageSnapshot = await getDocs(collection(db, 'usage'));
    const usageMap = {};
    usageSnapshot.docs.forEach(d => {
      const data = d.data();
      if (!usageMap[data.uid]) {
        usageMap[data.uid] = { tokens: 0, cost: 0 };
      }
      usageMap[data.uid].tokens += data.chatTokens?.monthly || 0;
      usageMap[data.uid].cost += data.totalCostUSD || 0;
    });

    let rankedUsers = [];

    if (metric === 'spenders') {
      rankedUsers = users
        .map(u => ({
          uid: u.uid,
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          totalSpent: (usageMap[u.uid]?.cost || 0) + (u.subscription?.amount_paid || 0),
          apiUsageCost: usageMap[u.uid]?.cost || 0,
          subscriptionCost: u.subscription?.amount_paid || 0,
          plan: u.plan,
          createdAt: u.createdAt
        }))
        .sort((a, b) => b.totalSpent - a.totalSpent)
        .slice(0, count);
    } else if (metric === 'tokens') {
      rankedUsers = users
        .map(u => ({
          uid: u.uid,
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          tokensUsed: usageMap[u.uid]?.tokens || 0,
          apiCost: usageMap[u.uid]?.cost || 0,
          plan: u.plan,
          createdAt: u.createdAt
        }))
        .sort((a, b) => b.tokensUsed - a.tokensUsed)
        .slice(0, count);
    } else if (metric === 'subscriptions') {
      rankedUsers = users
        .filter(u => u.subscription?.is_payed)
        .map(u => ({
          uid: u.uid,
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          subscriptionAmount: u.subscription?.amount_paid || 0,
          subscriptionStatus: u.subscription?.status,
          subscriptionEndDate: u.subscription?.subscription_end_date,
          createdAt: u.createdAt
        }))
        .sort((a, b) => b.subscriptionAmount - a.subscriptionAmount)
        .slice(0, count);
    }

    return rankedUsers;
  } catch (error) {
    console.error('🔥 Error getting top users:', error.message);
    throw error;
  }
}

/**
 * Get AI model usage statistics
 * 
 * @returns {Promise<Object>} Usage breakdown by model
 */
export async function getModelUsageStats() {
  try {
    // Get all token transactions to track model usage
    const transactionsSnapshot = await getDocs(collection(db, 'tokenTransactions'));
    const transactions = transactionsSnapshot.docs.map(d => d.data());

    // Also get usage records which have model info
    const usageSnapshot = await getDocs(collection(db, 'usage'));
    const usageRecords = usageSnapshot.docs.map(d => d.data());

    // Group by model from transactions
    const modelStats = {};
    
    transactions.forEach(tx => {
      const model = tx.model || 'unknown';
      if (!modelStats[model]) {
        modelStats[model] = {
          model,
          tokens: 0,
          cost: 0,
          count: 0
        };
      }
      modelStats[model].tokens += (tx.amount || 0);
      modelStats[model].cost += (tx.costUSD || 0);
      modelStats[model].count += 1;
    });

    const modelBreakdown = Object.values(modelStats)
      .sort((a, b) => b.tokens - a.tokens);

    const totalTokens = modelBreakdown.reduce((sum, m) => sum + m.tokens, 0);
    const totalCost = modelBreakdown.reduce((sum, m) => sum + m.cost, 0);

    return {
      total: {
        tokens: totalTokens,
        cost: parseFloat(totalCost.toFixed(2)),
        models: modelBreakdown.length,
        transactions: transactions.length
      },
      byModel: modelBreakdown.map(m => ({
        ...m,
        cost: parseFloat(m.cost.toFixed(2)),
        percentage: totalTokens > 0 ? parseFloat(((m.tokens / totalTokens) * 100).toFixed(2)) : 0
      }))
    };
  } catch (error) {
    console.error('🔥 Error getting model usage stats:', error.message);
    throw error;
  }
}

/**
 * Get user growth statistics over time
 * 
 * @returns {Promise<Object>} User growth metrics
 */
export async function getUserGrowthStats() {
  try {
    const usersSnapshot = await getDocs(collection(db, 'users'));
    const users = usersSnapshot.docs.map(d => d.data());

    // Group users by creation month
    const byMonth = {};
    users.forEach(u => {
      const createdDate = u.createdAt?.toDate?.() || new Date(u.createdAt);
      const month = createdDate.toISOString().slice(0, 7);
      
      if (!byMonth[month]) {
        byMonth[month] = { total: 0, free: 0, premium: 0 };
      }
      byMonth[month].total += 1;
      if (u.plan === 'premium') {
        byMonth[month].premium += 1;
      } else {
        byMonth[month].free += 1;
      }
    });

    // Calculate cumulative
    const monthlyBreakdown = Object.entries(byMonth)
      .map(([month, data]) => ({ month, ...data }))
      .sort((a, b) => a.month.localeCompare(b.month));

    let cumulative = 0;
    const cumulativeGrowth = monthlyBreakdown.map(m => {
      cumulative += m.total;
      return {
        ...m,
        cumulative
      };
    });

    return {
      totalUsers: users.length,
      freeUsers: users.filter(u => u.plan !== 'premium').length,
      premiumUsers: users.filter(u => u.plan === 'premium').length,
      monthlyBreakdown: cumulativeGrowth
    };
  } catch (error) {
    console.error('🔥 Error getting user growth stats:', error.message);
    throw error;
  }
}
