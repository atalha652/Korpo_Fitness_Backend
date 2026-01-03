/**
 * Admin Authentication Routes
 * Signup and signin endpoints for admin
 */

import express from 'express';
import admin from 'firebase-admin';
import { createAdminAccount, verifyAdminToken, updateAdminLastLogin } from '../../services/admin/firebaseAdminService.js';

const router = express.Router();

/**
 * @route POST /api/admin/auth/signup
 * @desc Create new admin account
 * @access Public (first admin setup only)
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    // Validate input
    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, firstName, and lastName are required',
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format',
      });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters',
      });
    }

    // Create admin account
    const adminData = await createAdminAccount(email, password, firstName, lastName);

    res.status(201).json({
      success: true,
      message: 'Admin account created successfully',
      admin: adminData,
    });
  } catch (error) {
    console.error('🔥 Error in admin signup:', error.message);

    // Handle specific Firebase errors
    if (error.code === 'auth/email-already-exists') {
      return res.status(400).json({
        success: false,
        error: 'Email already exists',
      });
    }

    if (error.code === 'auth/invalid-email') {
      return res.status(400).json({
        success: false,
        error: 'Invalid email',
      });
    }

    if (error.code === 'auth/weak-password') {
      return res.status(400).json({
        success: false,
        error: 'Password is too weak',
      });
    }

    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @route POST /api/admin/auth/signin
 * @desc Admin signin with email and password
 * @access Public
 */
router.post('/signin', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
    }

    // Get user from Firebase Auth
    const userRecord = await admin.auth().getUserByEmail(email);

    // Check custom claims
    if (!userRecord.customClaims || userRecord.customClaims.role !== 'admin') {
      return res.status(401).json({
        success: false,
        error: 'User is not an admin',
      });
    }

    // Get ID token (note: this requires REST API call)
    // For now, return a success message that frontend should use to get token
    console.log(`✅ Admin signin attempt: ${email}`);

    res.json({
      success: true,
      message: 'Admin verified. Please use your email and password with Firebase Auth to get idToken',
      email: userRecord.email,
      uid: userRecord.uid,
    });
  } catch (error) {
    console.error('🔥 Error in admin signin:', error.message);

    if (error.code === 'auth/user-not-found') {
      return res.status(401).json({
        success: false,
        error: 'Admin not found',
      });
    }

    res.status(401).json({
      success: false,
      error: 'Invalid credentials',
    });
  }
});

/**
 * @route POST /api/admin/auth/verify-token
 * @desc Verify admin token and get admin data
 * @access Public
 */
router.post('/verify-token', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({
        success: false,
        error: 'idToken is required',
      });
    }

    // Verify token
    const adminData = await verifyAdminToken(idToken);

    // Update last login
    await updateAdminLastLogin(adminData.email);

    res.json({
      success: true,
      valid: true,
      admin: adminData,
    });
  } catch (error) {
    console.error('🔥 Error verifying token:', error.message);

    res.status(401).json({
      success: false,
      valid: false,
      error: error.message,
    });
  }
});

export default router;
