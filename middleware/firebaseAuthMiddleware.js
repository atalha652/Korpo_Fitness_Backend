/**
 * Firebase Authentication Middleware
 * Verifies Firebase ID tokens and extracts user UID
 * 
 * Usage:
 *   app.get('/api/protected', verifyFirebaseToken, (req, res) => {
 *     console.log(req.user.uid) // UID from token
 *   })
 */

import admin from 'firebase-admin';

/**
 * Middleware to verify Firebase ID token
 * Extracts UID from token and adds to req.user
 * 
 * @returns {Promise<void>}
 */
export async function verifyFirebaseToken(req, res, next) {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Missing or invalid Authorization header',
        code: 'MISSING_TOKEN'
      });
    }

    // Extract token (format: "Bearer <token>")
    const token = authHeader.split('Bearer ')[1];

    // Verify token with Firebase Admin SDK
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // Add user info to request object
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || null,
      decodedToken: decodedToken
    };

    console.log(`✅ User authenticated: ${req.user.uid}`);
    next();

  } catch (error) {
    console.error('🔥 Firebase auth error:', error.message);

    // Specific error messages for different scenarios
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({
        error: 'Token expired',
        code: 'TOKEN_EXPIRED'
      });
    }

    if (error.code === 'auth/invalid-id-token') {
      return res.status(401).json({
        error: 'Invalid token',
        code: 'INVALID_TOKEN'
      });
    }

    res.status(401).json({
      error: 'Authentication failed',
      code: 'AUTH_FAILED'
    });
  }
}
