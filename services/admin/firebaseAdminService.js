/**
 * Firebase Admin Service
 * Handles admin authentication with Firebase
 */

import admin from 'firebase-admin';
import { db } from '../../firebase.js';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';

/**
 * Create new admin account
 * @param {string} email - Admin email
 * @param {string} password - Admin password
 * @param {string} firstName - First name
 * @param {string} lastName - Last name
 * @returns {Promise<Object>} Admin data
 */
export async function createAdminAccount(email, password, firstName, lastName) {
  try {
    console.log(`📝 Creating admin account: ${email}`);

    // 1. Check if admin already exists in Firestore
    const adminRef = doc(db, 'admins', email);
    const adminSnap = await getDoc(adminRef);

    if (adminSnap.exists()) {
      throw new Error('Admin with this email already exists');
    }

    // 2. Create user in Firebase Auth
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`,
    });

    console.log(`✅ Firebase user created: ${userRecord.uid}`);

    // 3. Set custom claim (admin role)
    await admin.auth().setCustomUserClaims(userRecord.uid, { role: 'admin' });

    // 4. Create admin record in Firestore
    const adminData = {
      uid: userRecord.uid,
      email,
      firstName,
      lastName,
      role: 'admin',
      permissions: {
        users: ['read', 'write', 'delete'],
        tokens: ['read', 'write'],
        subscriptions: ['read', 'write'],
        partners: ['read', 'write'],
        ambassadors: ['read', 'write'],
        analytics: ['read'],
        payments: ['read'],
      },
      isActive: true,
      createdAt: serverTimestamp(),
      lastLogin: null,
      activityLog: [],
    };

    await setDoc(adminRef, adminData);

    console.log(`✅ Admin record created in Firestore`);

    return {
      uid: userRecord.uid,
      email,
      firstName,
      lastName,
      role: 'admin',
      message: 'Admin account created successfully',
    };
  } catch (error) {
    console.error('🔥 Error creating admin:', error.message);
    throw error;
  }
}

/**
 * Verify admin token and get permissions
 * @param {string} idToken - Firebase ID token
 * @returns {Promise<Object>} Admin data with permissions
 */
export async function verifyAdminToken(idToken) {
  try {
    // 1. Verify token with Firebase
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    console.log(`✅ Token verified for: ${decodedToken.email}`);

    // 2. Check if user has admin role
    if (decodedToken.role !== 'admin') {
      throw new Error('User is not an admin');
    }

    // 3. Get admin data from Firestore
    const adminRef = doc(db, 'admins', decodedToken.email);
    const adminSnap = await getDoc(adminRef);

    if (!adminSnap.exists()) {
      throw new Error('Admin record not found in database');
    }

    const adminData = adminSnap.data();

    if (!adminData.isActive) {
      throw new Error('Admin account is inactive');
    }

    return {
      uid: decodedToken.uid,
      email: adminData.email,
      firstName: adminData.firstName,
      lastName: adminData.lastName,
      role: adminData.role,
      permissions: adminData.permissions,
      isActive: adminData.isActive,
    };
  } catch (error) {
    console.error('🔥 Error verifying token:', error.message);
    throw error;
  }
}

/**
 * Update admin last login timestamp
 * @param {string} email - Admin email
 */
export async function updateAdminLastLogin(email) {
  try {
    const adminRef = doc(db, 'admins', email);
    await updateDoc(adminRef, {
      lastLogin: serverTimestamp(),
    });

    console.log(`✅ Last login updated for: ${email}`);
  } catch (error) {
    console.error('🔥 Error updating last login:', error.message);
    // Don't throw, just log
  }
}

/**
 * Get admin by email
 * @param {string} email - Admin email
 * @returns {Promise<Object>} Admin data
 */
export async function getAdminByEmail(email) {
  try {
    const adminRef = doc(db, 'admins', email);
    const adminSnap = await getDoc(adminRef);

    if (!adminSnap.exists()) {
      throw new Error('Admin not found');
    }

    return adminSnap.data();
  } catch (error) {
    console.error('🔥 Error getting admin:', error.message);
    throw error;
  }
}

/**
 * Check if admin has permission for resource action
 * @param {Object} admin - Admin data
 * @param {string} resource - Resource name (users, tokens, etc)
 * @param {string} action - Action (read, write, delete)
 * @returns {boolean}
 */
export function hasPermission(admin, resource, action) {
  if (!admin || !admin.permissions) {
    return false;
  }

  const resourcePermissions = admin.permissions[resource] || [];
  return resourcePermissions.includes(action);
}
