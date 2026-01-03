/**
 * Admin Authentication Middleware
 * Verifies admin token and permissions
 */

import { verifyAdminToken, hasPermission } from '../services/admin/firebaseAdminService.js';

/**
 * Middleware to verify admin token
 * Adds admin data to req.admin
 */
export async function adminAuthMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No authorization token provided',
      });
    }

    const adminData = await verifyAdminToken(token);
    req.admin = adminData;

    console.log(`✅ Admin authenticated: ${adminData.email}`);
    next();
  } catch (error) {
    console.error('🔥 Admin auth error:', error.message);
    res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
    });
  }
}

/**
 * Middleware to check admin permission for resource action
 * @param {string} resource - Resource name (users, tokens, etc)
 * @param {string} action - Action (read, write, delete)
 */
export function checkPermission(resource, action) {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({
        success: false,
        error: 'Admin not authenticated',
      });
    }

    if (!hasPermission(req.admin, resource, action)) {
      console.warn(
        `⚠️ Permission denied for ${req.admin.email}: ${resource}.${action}`
      );
      return res.status(403).json({
        success: false,
        error: `Permission denied for ${action} on ${resource}`,
      });
    }

    next();
  };
}
