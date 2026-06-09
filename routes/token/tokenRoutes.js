/**
 * Token Routes
 * API endpoints for token management
 * Implements blended token pricing for B2C users
 */

import express from 'express';
import {
    getUserTokenBalance,
    addTokensToUser,
    deductTokensFromUser,
    processAIServiceRequest,
    getOpenRouterCredits,
    getOpenRouterAccountCredits,
    validateTokenPurchase,
    getTokenTransactionHistory,
} from '../../controllers/token/tokenController.js';
import {
    createTokenPurchaseSession,
    createTokenPaymentIntent,
    getCheckoutSession,
    verifyWebhookSignature,
} from '../../services/stripe/tokenStripeService.js';
import { getPlatformFee } from '../../utils/platformFeeHelper.js';
import { db } from '../../firebase.js';
import { doc, getDoc, collection, query, where, getDocs, updateDoc, increment, addDoc, Timestamp } from 'firebase/firestore';
import { checkUserBalance, requirePositiveBalance } from '../../middleware/balanceChecker.js';

const router = express.Router();

/**
 * @route GET /api/tokens/balance/:userId
 * @desc Get user's token balance
 */
router.get('/balance/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await getUserTokenBalance(userId);
        res.json(result);
    } catch (error) {
        console.error('Error in GET /api/tokens/balance:', error);
        res.status(error.message === 'User not found' ? 404 : 500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route GET /api/tokens/pricing/limits
 * @desc Get token purchase limits and pricing info
 */
router.get('/pricing/limits', async (req, res) => {
    try {
        const platformFee = getPlatformFee();
        res.json({
            success: true,
            platformFee: platformFee,
            description: 'Platform fee for token purchases and premium plan'
        });
    } catch (error) {
        console.error('Error in GET /api/tokens/pricing/limits:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route GET /api/tokens/platform-fee/status/:userId
 * @desc Check if user needs to pay platform fee
 */
router.get('/platform-fee/status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const status = await checkPlatformFeeRequired(userId);
        res.json({
            success: true,
            ...status,
        });
    } catch (error) {
        console.error('Error in GET /api/tokens/platform-fee/status:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route POST /api/tokens/purchase/checkout
 * @desc Create Stripe checkout session for token purchase
 * Backend validates token quantity and recalculates price
 */
router.post('/purchase/checkout', async (req, res) => {
    try {
        const { userId, tokens, price, successUrl, cancelUrl, platformFeePaid } = req.body;

        console.log(`📥 Checkout request received:`, {
            userId,
            tokens,
            price,
            platformFeePaid,
            bodyKeys: Object.keys(req.body)
        });

        // Validation
        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            return res.status(400).json({
                success: false,
                error: 'Valid userId is required',
            });
        }

        // TODO: Token validation commented out for platform fee-only payments
        // if (!tokens || typeof tokens !== 'number' || tokens <= 0 || !Number.isInteger(tokens)) {
        //     return res.status(400).json({
        //         success: false,
        //         error: 'Valid positive integer tokens required',
        //     });
        // }

        const session = await createTokenPurchaseSession({
            userId,
            tokens,
            price, // Optional: for validation
            successUrl,
            cancelUrl,
            platformFeePaid, // Pass the platform fee override
        });

        res.json(session);
    } catch (error) {
        console.error('Error in POST /api/tokens/purchase/checkout:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route POST /api/tokens/purchase/intent
 * @desc Create Stripe payment intent for token purchase
 */
router.post('/purchase/intent', async (req, res) => {
    try {
        const { userId, tokens, price } = req.body;

        // Validation
        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            return res.status(400).json({
                success: false,
                error: 'Valid userId is required',
            });
        }

        if (!tokens || typeof tokens !== 'number' || tokens <= 0 || !Number.isInteger(tokens)) {
            return res.status(400).json({
                success: false,
                error: 'Valid positive integer tokens required',
            });
        }

        const intent = await createTokenPaymentIntent({
            userId,
            tokens,
            price, // Optional: for validation
        });

        res.json(intent);
    } catch (error) {
        console.error('Error in POST /api/tokens/purchase/intent:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route POST /api/tokens/purchase/confirm
 * @desc Confirm token purchase after successful payment
 */
router.post('/purchase/confirm', async (req, res) => {
    try {
        const { sessionId } = req.body;

        if (!sessionId || typeof sessionId !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Valid sessionId is required',
            });
        }

        const sessionResult = await getCheckoutSession(sessionId);
        const session = sessionResult.session;

        if (session.payment_status !== 'paid') {
            return res.status(400).json({
                success: false,
                error: 'Payment not completed',
            });
        }

        const { userId, tokens, tokenPrice, platformFee, totalPrice } = session.metadata;

        if (!userId || !tokens) {
            return res.status(400).json({
                success: false,
                error: 'Invalid session metadata',
            });
        }

        // Add tokens to user
        const result = await addTokensToUser(
            userId,
            parseInt(tokens),
            'purchase',
            {
                sessionId,
                tokenPrice: tokenPrice ? parseFloat(tokenPrice) : undefined,
                platformFee: platformFee ? parseFloat(platformFee) : undefined,
                totalPrice: totalPrice ? parseFloat(totalPrice) : session.amount_total / 100, // Convert from cents
                paymentIntentId: session.payment_intent,
            }
        );

        res.json({
            success: true,
            message: 'Tokens added successfully',
            ...result,
        });
    } catch (error) {
        console.error('Error in POST /api/tokens/purchase/confirm:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route POST /api/tokens/webhook
 * @desc Stripe webhook handler for token purchases
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['stripe-signature'];

        if (!signature) {
            return res.status(400).json({
                success: false,
                error: 'Missing stripe-signature header',
            });
        }

        const result = verifyWebhookSignature(req.body, signature);
        const event = result.event;

        // Handle the event
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;

            if (session.metadata?.type === 'token_purchase' && session.payment_status === 'paid') {
                const { userId, tokens } = session.metadata;

                if (userId && tokens) {
                    const { tokenPrice, platformFee, totalPrice } = session.metadata;
                    await addTokensToUser(
                        userId,
                        parseInt(tokens),
                        'purchase',
                        {
                            sessionId: session.id,
                            tokenPrice: tokenPrice ? parseFloat(tokenPrice) : undefined,
                            platformFee: platformFee ? parseFloat(platformFee) : undefined,
                            totalPrice: totalPrice ? parseFloat(totalPrice) : session.amount_total / 100,
                            paymentIntentId: session.payment_intent,
                        }
                    );

                    console.log(`✅ Tokens added to user ${userId}: ${tokens} tokens`);
                    
                    // ---- 🆕 PARTNER COMMISSION LOGIC ----
                    try {
                        const userRef = doc(db, 'users', userId);
                        const userSnap = await getDoc(userRef);
                        if (userSnap.exists()) {
                            const user = userSnap.data();
                            if (user.isPromo && user.promoCodeUsed) {
                                const promoCodesRef = collection(db, "promoCodes");
                                const promoQuery1 = query(promoCodesRef, where("code", "==", user.promoCodeUsed));
                                let promoSnap = await getDocs(promoQuery1);
                                
                                if (promoSnap.empty) {
                                    const promoQuery2 = query(promoCodesRef, where("promoCode", "==", user.promoCodeUsed));
                                    promoSnap = await getDocs(promoQuery2);
                                }
                                
                                if (!promoSnap.empty) {
                                    const promoData = promoSnap.docs[0].data();
                                    const partnerId = promoData.partnerId;
                                    const promoId = promoSnap.docs[0].id;
                                    
                                    if (partnerId) {
                                        const partnerRef = doc(db, "partners", partnerId);
                                        const partnerSnap = await getDoc(partnerRef);
                                        
                                        if (partnerSnap.exists()) {
                                            const partnerData = partnerSnap.data();
                                            const commissionRate = partnerData.commissionRate || 0.2; // default 20%
                                            const discountRate = partnerData.discountRate || 0;
                                            
                                            const finalAmount = session.amount_total / 100;
                                            const originalAmount = discountRate > 0 ? finalAmount / (1 - discountRate) : finalAmount;
                                            const discountAmount = originalAmount - finalAmount;
                                            
                                            const commissionEarned = finalAmount * commissionRate;
                                            const companyRevenue = finalAmount - commissionEarned;
                                            
                                            await updateDoc(partnerRef, {
                                                availableBalance: increment(commissionEarned),
                                                totalPartnerRevenue: increment(commissionEarned),
                                                totalPromos: increment(1),
                                                updatedAt: Timestamp.fromDate(new Date())
                                            });
                                            console.log(`✅ Partner ${partnerId} rewarded with $${commissionEarned} commission in token webhook.`);

                                            // Add to partnerTracking collection
                                            const trackingRef = collection(db, "partnerTracking");
                                            await addDoc(trackingRef, {
                                                companyRevenue: companyRevenue,
                                                discountAmount: discountAmount,
                                                discountPercentage: discountRate,
                                                finalAmount: finalAmount,
                                                originalAmount: originalAmount,
                                                partnerId: partnerId,
                                                partnerRevenue: commissionEarned,
                                                partnerSharePercentage: commissionRate,
                                                promoCode: user.promoCodeUsed,
                                                promoId: promoId,
                                                usedAt: Timestamp.fromDate(new Date()),
                                                userId: userId
                                            });
                                            console.log(`✅ Logged transaction in partnerTracking.`);
                                        }
                                    }
                                }
                            } else if (user.referralUsed) {
                                // ---- 🆕 AMBASSADOR REFERRAL COMMISSION LOGIC ----
                                const referralCodesRef = collection(db, "referralCodes");
                                const refQuery = query(referralCodesRef, where("referralCode", "==", user.referralUsed));
                                const refSnap = await getDocs(refQuery);
                                
                                if (!refSnap.empty) {
                                    const refData = refSnap.docs[0].data();
                                    const ambassadorId = refData.ambassadorId;
                                    const referralId = refSnap.docs[0].id;
                                    
                                    const now = new Date();
                                    const validTo = refData.validTo?.toDate ? refData.validTo.toDate() : (refData.validTo ? new Date(refData.validTo) : new Date(8640000000000000));
                                    const validFrom = refData.validFrom?.toDate ? refData.validFrom.toDate() : (refData.validFrom ? new Date(refData.validFrom) : new Date(0));
                                    
                                    if (ambassadorId && refData.status === "active" && now <= validTo && now >= validFrom) {
                                        const ambassadorRef = doc(db, "ambassadors", ambassadorId);
                                        const ambassadorSnap = await getDoc(ambassadorRef);
                                        
                                        if (ambassadorSnap.exists()) {
                                            const ambassadorData = ambassadorSnap.data();
                                            const commissionRate = ambassadorData.commissionRate || 0.1; // default 10%
                                            
                                            const finalAmount = session.amount_total / 100;
                                            // Since referral discount is hardcoded 10%, original is finalAmount / 0.9
                                            const originalAmount = finalAmount / 0.9;
                                            const commissionEarned = originalAmount * commissionRate;
                                            
                                            await updateDoc(ambassadorRef, {
                                                availableBalance: increment(commissionEarned),
                                                totalReferrals: increment(1),
                                                updatedAt: Timestamp.fromDate(new Date())
                                            });
                                            
                                            // Increment timesUsed on referral code
                                            await updateDoc(doc(db, "referralCodes", referralId), {
                                                timesUsed: increment(1)
                                            });
                                            
                                            console.log(`✅ Ambassador ${ambassadorId} rewarded with $${commissionEarned} commission in token webhook.`);

                                            // Add to referralTracking collection
                                            const trackingRef = collection(db, "referralTracking");
                                            await addDoc(trackingRef, {
                                                ambassadorId: ambassadorId,
                                                amount: originalAmount,
                                                commissionEarned: commissionEarned,
                                                commissionRate: commissionRate,
                                                referralCode: user.referralUsed,
                                                referralId: referralId,
                                                usedAt: Timestamp.fromDate(new Date()),
                                                userId: userId
                                            });
                                            console.log(`✅ Logged transaction in referralTracking.`);
                                        }
                                    } else {
                                        console.log(`⚠️ Referral code ${user.referralUsed} is expired or inactive, skipping commission.`);
                                    }
                                }
                            }
                        }
                    } catch (promoError) {
                        console.error("❌ Error applying commission in token webhook:", promoError);
                    }
                    // ---- END COMMISSION LOGIC ----
                }
            }
        } else if (event.type === 'payment_intent.succeeded') {
            const paymentIntent = event.data.object;

            if (paymentIntent.metadata?.type === 'token_purchase') {
                const { userId, tokens } = paymentIntent.metadata;

                if (userId && tokens) {
                    const { tokenPrice, platformFee, totalPrice } = paymentIntent.metadata;
                    await addTokensToUser(
                        userId,
                        parseInt(tokens),
                        'purchase',
                        {
                            paymentIntentId: paymentIntent.id,
                            tokenPrice: tokenPrice ? parseFloat(tokenPrice) : undefined,
                            platformFee: platformFee ? parseFloat(platformFee) : undefined,
                            totalPrice: totalPrice ? parseFloat(totalPrice) : paymentIntent.amount / 100,
                        }
                    );

                    console.log(`✅ Tokens added to user ${userId}: ${tokens} tokens`);
                }
            }
        }

        res.json({ received: true });
    } catch (error) {
        console.error('Error in POST /api/tokens/webhook:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route POST /api/tokens/ai/request
 * @desc Process AI service request and deduct tokens
 * Model: google/gemini-3-flash-preview
 * UPDATED: Added check for user.amount > 0
 */
router.post('/ai/request', async (req, res) => {
    try {
        const { userId, messages, model, options } = req.body;

        // Validation
        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            return res.status(400).json({
                success: false,
                error: 'Valid userId is required',
            });
        }

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Valid messages array is required',
            });
        }

        // Validate message structure
        for (const msg of messages) {
            if (!msg.role || !msg.content) {
                return res.status(400).json({
                    success: false,
                    error: 'Each message must have role and content',
                });
            }
        }

        // ✅ NEW: Check user balance first
        const balanceCheck = await checkUserBalance(userId);
        if (!balanceCheck.hasBalance) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient balance. Please purchase to continue.',
                currentBalance: balanceCheck.balance,
                requiredBalance: '> 0',
                message: balanceCheck.message
            });
        }

        const result = await processAIServiceRequest(userId, {
            messages,
            model: model || 'google/gemini-3-flash-preview',
            options: options || {},
        });

        res.json(result);
    } catch (error) {
        console.error('Error in POST /api/tokens/ai/request:', error);
        const statusCode = error.message.includes('Insufficient') ? 403 : 500;
        res.status(statusCode).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route GET /api/tokens/openrouter/credits
 * @desc Get OpenRouter credit information
 */
router.get('/openrouter/credits', async (req, res) => {
    try {
        const result = await getOpenRouterCredits();
        res.json(result);
    } catch (error) {
        console.error('Error in GET /api/tokens/openrouter/credits:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route GET /api/tokens/openrouter/account/credits
 * @desc Get OpenRouter account remaining credits from /credits endpoint (uses server API key from env)
 */
router.get('/openrouter/account/credits', async (req, res) => {
    try {
        const { includeRaw } = req.query;
        const result = await getOpenRouterAccountCredits(null, includeRaw === 'true');
        res.json(result);
    } catch (error) {
        console.error('Error in GET /api/tokens/openrouter/account/credits:', error);
        const statusCode = error.message.includes('required') ? 400 :
            error.message.includes('401') || error.message.includes('403') ? 401 : 500;
        res.status(statusCode).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route POST /api/tokens/openrouter/account/credits
 * @desc Get OpenRouter account remaining credits using provided API key
 * API key can be passed in Authorization header: Bearer <apiKey>
 * If not provided, uses OPENROUTER_API_KEY from environment
 */
router.post('/openrouter/account/credits', async (req, res) => {
    try {
        const { includeRaw } = req.body;

        // Get API key from Authorization header (optional)
        let apiKey = null;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            apiKey = authHeader.substring(7).trim(); // Remove "Bearer " prefix
        }

        const result = await getOpenRouterAccountCredits(apiKey || null, includeRaw || false);
        res.json(result);
    } catch (error) {
        console.error('Error in POST /api/tokens/openrouter/account/credits:', error);
        const statusCode = error.message.includes('required') ? 400 :
            error.message.includes('401') || error.message.includes('403') ? 401 : 500;
        res.status(statusCode).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route POST /api/tokens/purchase/validate
 * @desc Validate if token purchase is allowed based on OpenRouter credits
 * API key can be passed in Authorization header: Bearer <apiKey>
 * If not provided, uses OPENROUTER_API_KEY from environment
 */
router.post('/purchase/validate', async (req, res) => {
    try {
        const { tokens } = req.body;

        // Validation
        if (!tokens || typeof tokens !== 'number' || tokens <= 0 || !Number.isInteger(tokens)) {
            return res.status(400).json({
                success: false,
                canPurchase: false,
                error: 'Valid positive integer tokens required',
            });
        }

        // Get API key from Authorization header (optional)
        let apiKey = null;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            apiKey = authHeader.substring(7).trim(); // Remove "Bearer " prefix
        }

        const result = await validateTokenPurchase(tokens, apiKey || null);
        res.json(result);
    } catch (error) {
        console.error('Error in POST /api/tokens/purchase/validate:', error);
        const statusCode = error.message.includes('required') ? 400 : 500;
        res.status(statusCode).json({
            success: false,
            canPurchase: false,
            error: error.message,
        });
    }
});

/**
 * @route GET /api/tokens/history/:userId
 * @desc Get token transaction history
 */
router.get('/history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit } = req.query;

        const result = await getTokenTransactionHistory(
            userId,
            limit ? parseInt(limit) : 50
        );

        res.json(result);
    } catch (error) {
        console.error('Error in GET /api/tokens/history:', error);
        res.status(error.message === 'Valid user ID is required' ? 400 : 500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route POST /api/tokens/add
 * @desc Manually add tokens to user (admin/manual operation)
 */
router.post('/add', async (req, res) => {
    try {
        const { userId, tokens, source, metadata } = req.body;

        // Validation
        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            return res.status(400).json({
                success: false,
                error: 'Valid userId is required',
            });
        }

        if (!tokens || typeof tokens !== 'number' || tokens <= 0 || !Number.isInteger(tokens)) {
            return res.status(400).json({
                success: false,
                error: 'Valid positive integer tokens required',
            });
        }

        const result = await addTokensToUser(
            userId,
            tokens,
            source || 'manual',
            metadata || {}
        );

        res.json(result);
    } catch (error) {
        console.error('Error in POST /api/tokens/add:', error);
        res.status(error.message === 'User not found' ? 404 : 500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route POST /api/tokens/deduct
 * @desc Manually deduct tokens from user (admin/manual operation)
 */
router.post('/deduct', async (req, res) => {
    try {
        const { userId, tokens, reason, metadata } = req.body;

        // Validation
        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            return res.status(400).json({
                success: false,
                error: 'Valid userId is required',
            });
        }

        if (!tokens || typeof tokens !== 'number' || tokens <= 0 || !Number.isInteger(tokens)) {
            return res.status(400).json({
                success: false,
                error: 'Valid positive integer tokens required',
            });
        }

        const result = await deductTokensFromUser(
            userId,
            tokens,
            reason || 'manual',
            metadata || {}
        );

        res.json(result);
    } catch (error) {
        console.error('Error in POST /api/tokens/deduct:', error);
        const statusCode = error.message.includes('Insufficient') ? 403 :
            error.message === 'User not found' ? 404 : 500;
        res.status(statusCode).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * @route GET /api/chat/debug/:userId
 * @desc DEBUG: Show all fields in user document
 * @access Public
 * @param {string} userId - User ID
 */
router.get('/chat/debug/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            return res.status(400).json({
                success: false,
                error: 'Valid userId is required'
            });
        }

        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);

        if (!userSnap.exists()) {
            return res.json({
                success: false,
                message: 'User not found in Firestore',
                userId: userId,
                allFields: null
            });
        }

        const userData = userSnap.data();

        res.json({
            success: true,
            userId: userId,
            message: 'Here are ALL fields in this user document',
            allFields: userData,
            hasTokenBalanceField: 'tokenBalance' in userData,
            tokenBalanceValue: userData.tokenBalance || 'FIELD NOT FOUND',
            tokenBalanceType: typeof userData.tokenBalance,
            allKeys: Object.keys(userData)
        });
    } catch (error) {
        console.error('Error in debug endpoint:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
* @route POST /api/chat/validate-access
* @desc Check if user can chat (amount > 0)
* @access Public
* @body { userId }
*/
router.post('/chat/validate-access', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            return res.status(400).json({
                success: false,
                error: 'Valid userId is required'
            });
        }

        const balanceCheck = await checkUserBalance(userId);

        res.json({
            success: true,
            canChat: balanceCheck.hasBalance,
            balance: balanceCheck.balance,
            message: balanceCheck.message
        });
    } catch (error) {
        console.error('Error in POST /api/chat/validate-access:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
* @route GET /api/chat/balance/:userId
* @desc Get user's balance (amount field)
* @access Public
* @param {string} userId - User ID
*/
router.get('/chat/balance/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            return res.status(400).json({
                success: false,
                error: 'Valid userId is required'
            });
        }

        const balanceCheck = await checkUserBalance(userId);

        res.json({
            success: true,
            userId,
            canChat: balanceCheck.hasBalance,
            balance: balanceCheck.balance,
            message: balanceCheck.message
        });
    } catch (error) {
        console.error('Error in GET /api/chat/balance:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;

