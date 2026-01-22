/**
 * Admin Data Routes
 * Protected routes to access all project data
 */

import express from 'express';
import { adminAuthMiddleware, checkPermission } from '../../middleware/adminAuth.js';
import { db } from '../../firebase.js';
import {
  collection,
  getDocs,
  doc,
  getDoc,
  query,
  where,
  orderBy,
  limit,
} from 'firebase/firestore';
import { Timestamp } from 'firebase/firestore';

const router = express.Router();

/**
 * @route GET /api/admin/data/users
 * @desc Get all users with pagination and search
 * @access Admin (read users)
 */
router.get('/users', adminAuthMiddleware, checkPermission('users', 'read'), async (req, res) => {
  try {
    const { pageSize = 50, pageNumber = 1, search } = req.query;
    const offset = (pageNumber - 1) * pageSize;

    // Get all users
    const usersSnapshot = await getDocs(collection(db, 'users'));

    let users = usersSnapshot.docs.map(docSnap => ({
      uid: docSnap.id,
      email: docSnap.data().email,
      firstName: docSnap.data().firstName,
      lastName: docSnap.data().lastName,
      is_payed: docSnap.data().is_payed || false,
      createdAt: docSnap.data().createdAt,
      subscription: docSnap.data().subscription || null,
      tokenBalance: docSnap.data().tokenBalance || 0,
    }));

    // Filter by search
    if (search) {
      users = users.filter(u =>
        u.email?.toLowerCase().includes(search.toLowerCase()) ||
        u.firstName?.toLowerCase().includes(search.toLowerCase()) ||
        u.lastName?.toLowerCase().includes(search.toLowerCase())
      );
    }

    // Pagination
    const total = users.length;
    const paginatedUsers = users.slice(offset, offset + pageSize);

    res.json({
      success: true,
      users: paginatedUsers,
      pagination: {
        total,
        pageSize: parseInt(pageSize),
        pageNumber: parseInt(pageNumber),
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error('🔥 Error fetching users:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @route GET /api/admin/data/users/:userId
 * @desc Get specific user details
 * @access Admin (read users)
 */
router.get('/users/:userId', adminAuthMiddleware, checkPermission('users', 'read'), async (req, res) => {
  try {
    const { userId } = req.params;

    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.json({
      success: true,
      user: {
        uid: userId,
        ...userSnap.data(),
      },
    });
  } catch (error) {
    console.error('🔥 Error fetching user:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @route GET /api/admin/data/subscriptions
 * @desc Get all subscriptions
 * @access Admin (read subscriptions)
 * @disabled - Commented out for now
 */
// router.get('/subscriptions', adminAuthMiddleware, checkPermission('subscriptions', 'read'), async (req, res) => {
//   try {
//     const { pageSize = 50, pageNumber = 1 } = req.query;
//     const offset = (pageNumber - 1) * pageSize;
//
//     const usersSnapshot = await getDocs(collection(db, 'users'));
//
//     let subscriptions = usersSnapshot.docs
//       .map(docSnap => ({
//         userId: docSnap.id,
//         email: docSnap.data().email,
//         firstName: docSnap.data().firstName,
//         ...docSnap.data().subscription,
//       }))
//       .filter(s => s.subscription_end_date);
//
//     const total = subscriptions.length;
//     const paginatedSubscriptions = subscriptions.slice(offset, offset + pageSize);
//
//     res.json({
//       success: true,
//       subscriptions: paginatedSubscriptions,
//       pagination: {
//         total,
//         pageSize: parseInt(pageSize),
//         pageNumber: parseInt(pageNumber),
//         totalPages: Math.ceil(total / pageSize),
//       },
//     });
//   } catch (error) {
//     console.error('🔥 Error fetching subscriptions:', error.message);
//     res.status(500).json({
//       success: false,
//       error: error.message,
//     });
//   }
// });

/**
 * @route GET /api/admin/data/tokens/transactions
 * @desc Get all token transactions
 * @access Admin (read tokens)
 */
router.get('/tokens/transactions', adminAuthMiddleware, checkPermission('tokens', 'read'), async (req, res) => {
  try {
    const { pageSize = 50, pageNumber = 1 } = req.query;
    const offset = (pageNumber - 1) * pageSize;

    const transactionsSnapshot = await getDocs(collection(db, 'tokenTransactions'));

    let transactions = transactionsSnapshot.docs
      .map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data(),
      }))
      .sort((a, b) => {
        const timeA = a.timestamp?.toDate?.() || new Date(0);
        const timeB = b.timestamp?.toDate?.() || new Date(0);
        return timeB - timeA;
      });

    const total = transactions.length;
    const paginatedTransactions = transactions.slice(offset, offset + pageSize);

    res.json({
      success: true,
      transactions: paginatedTransactions,
      pagination: {
        total,
        pageSize: parseInt(pageSize),
        pageNumber: parseInt(pageNumber),
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error('🔥 Error fetching token transactions:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @route GET /api/admin/data/payments
 * @desc Get all payments (Stripe checkout sessions)
 * @access Admin (read payments)
 */
router.get('/payments', adminAuthMiddleware, checkPermission('payments', 'read'), async (req, res) => {
  try {
    const usersSnapshot = await getDocs(collection(db, 'users'));

    const payments = usersSnapshot.docs
      .flatMap(docSnap => {
        const user = docSnap.data();
        const subscription = user.subscription || {};

        return {
          userId: docSnap.id,
          email: user.email,
          firstName: user.firstName,
          amount: subscription.amount_paid || 0,
          currency: 'usd',
          status: subscription.status || 'unknown',
          paymentMethod: subscription.payment_method || 'card',
          timestamp: subscription.last_payment_date,
          stripeSessionId: subscription.stripe_session_id,
        };
      })
      .filter(p => p.amount > 0)
      .sort((a, b) => {
        const timeA = a.timestamp?.toDate?.() || new Date(0);
        const timeB = b.timestamp?.toDate?.() || new Date(0);
        return timeB - timeA;
      });

    res.json({
      success: true,
      payments,
      total: payments.length,
    });
  } catch (error) {
    console.error('🔥 Error fetching payments:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @route GET /api/admin/data/analytics
 * @desc Get dashboard analytics
 * @access Admin (read analytics)
 */
router.get('/analytics', adminAuthMiddleware, checkPermission('analytics', 'read'), async (req, res) => {
  try {
    const usersSnapshot = await getDocs(collection(db, 'users'));
    const tokenTransactionsSnapshot = await getDocs(collection(db, 'tokenTransactions'));
    const partnersSnapshot = await getDocs(collection(db, 'partners'));
    const ambassadorsSnapshot = await getDocs(collection(db, 'ambassadors'));

    const users = usersSnapshot.docs.map(d => d.data());
    const transactions = tokenTransactionsSnapshot.docs.map(d => d.data());
    const partners = partnersSnapshot.docs.map(d => d.data());
    const ambassadors = ambassadorsSnapshot.docs.map(d => d.data());

    // Calculate metrics
    const totalUsers = users.length;
    const activeSubscriptions = users.filter(u => {
      const endDate = u.subscription?.subscription_end_date?.toDate?.() || new Date(0);
      return endDate > new Date() && u.subscription?.is_payed;
    }).length;

    const totalRevenue = users.reduce((sum, u) => {
      return sum + (u.subscription?.amount_paid || 0);
    }, 0);

    const tokensSold = transactions
      .filter(t => t.source === 'purchase')
      .reduce((sum, t) => sum + (t.amount || 0), 0);

    const tokensUsed = transactions
      .filter(t => t.type === 'debit')
      .reduce((sum, t) => sum + (t.amount || 0), 0);

    const approvedPartners = partners.filter(p => p.status === 'approved').length;
    const approvedAmbassadors = ambassadors.filter(a => a.status === 'approved').length;

    res.json({
      success: true,
      analytics: {
        totalUsers,
        activeSubscriptions,
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        tokensSold,
        tokensUsed,
        approvedPartners,
        approvedAmbassadors,
        lastUpdated: new Date(),
      },
    });
  } catch (error) {
    console.error('🔥 Error fetching analytics:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @route GET /api/admin/data/partners
 * @desc Get all partners
 * @access Admin (read partners)
 */
router.get('/partners', adminAuthMiddleware, checkPermission('partners', 'read'), async (req, res) => {
  try {
    const partnersSnapshot = await getDocs(collection(db, 'partners'));

    const partners = partnersSnapshot.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));

    res.json({
      success: true,
      partners,
      total: partners.length,
    });
  } catch (error) {
    console.error('🔥 Error fetching partners:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @route GET /api/admin/data/ambassadors
 * @desc Get all ambassadors
 * @access Admin (read ambassadors)
 */
router.get('/ambassadors', adminAuthMiddleware, checkPermission('ambassadors', 'read'), async (req, res) => {
  try {
    const ambassadorsSnapshot = await getDocs(collection(db, 'ambassadors'));

    const ambassadors = ambassadorsSnapshot.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));

    res.json({
      success: true,
      ambassadors,
      total: ambassadors.length,
    });
  } catch (error) {
    console.error('🔥 Error fetching ambassadors:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
