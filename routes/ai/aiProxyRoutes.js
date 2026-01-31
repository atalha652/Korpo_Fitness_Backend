/**
 * AI Proxy Routes
 * Mobile app calls these endpoints instead of calling OpenAI directly
 * Backend handles: Authentication, Usage Tracking, Token Counting, Billing
 */

import express from 'express';
import multer from 'multer';
import { verifyFirebaseToken } from '../../middleware/firebaseAuthMiddleware.js';
import { recordTokenUsage, checkCanUseTokens, getUsageSummary, getUserLimits } from '../../services/usageService.js';
import { calculateTokenCost } from '../../utils/tokenPricing.js';
import { trackHourlyApiUsage } from '../../services/billingService.js';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/**
 * POST /api/ai/chat
 * Chat completion endpoint for mobile app
 * 
 * Replaces direct OpenAI calls from mobile app
 * - Checks user limits
 * - Calls OpenAI (backend has API key)
 * - Records usage
 * - Returns response + remaining tokens
 * 
 * Body:
 * {
 *   messages: [{role: "user/assistant/system", content: "..."}, ...],
 *   model: "gpt-4o" | "gpt-4o-mini" (default: "gpt-4o-mini"),
 *   temperature: 0.7 (optional, default: 0.7)
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   choices: [{text: "...", message: {role: "assistant", content: "..."}}],
 *   usage: {promptTokens, completionTokens, totalTokens},
 *   plan: "free" | "premium",
 *   cost: 0.00045,
 *   remainingDaily: 49500,
 *   remainingMonthly: 999500,
 *   totalCostUSD: 0.25
 * }
 */
router.post('/chat', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { 
      messages,
      model = 'gpt-4o-mini',
      temperature = 0.7
    } = req.body;

    // ============ VALIDATION ============
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'messages array is required and must not be empty',
        code: 'INVALID_MESSAGES'
      });
    }

    // Validate each message has role and content
    for (let i = 0; i < messages.length; i++) {
      if (!messages[i].role || !messages[i].content) {
        return res.status(400).json({
          success: false,
          error: `Message ${i} must have 'role' and 'content' fields`,
          code: 'INVALID_MESSAGE_FORMAT'
        });
      }
    }

    // ============ CHECK LIMITS ============
    const canUse = await checkCanUseTokens(uid);
    if (!canUse.allowed) {
      return res.status(429).json({
        success: false,
        error: canUse.reason || 'Limit exceeded',
        code: 'LIMIT_EXCEEDED',
        remaining: canUse.remaining
      });
    }

    // ============ CALL OPENAI ============
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: messages,
        temperature: temperature || 0.7,
        max_tokens: 2000
      })
    });

    const aiData = await openaiResponse.json();

    if (!openaiResponse.ok) {
      console.error('OpenAI API Error:', aiData);
      return res.status(500).json({
        success: false,
        error: aiData.error?.message || 'OpenAI request failed',
        code: 'AI_ERROR'
      });
    }

    const promptTokens = aiData.usage?.prompt_tokens || 0;
    const completionTokens = aiData.usage?.completion_tokens || 0;
    const totalTokens = promptTokens + completionTokens;
    
    const aiResponse = {
      choices: aiData.choices.map(choice => ({
        text: choice.message.content,
        message: choice.message
      })),
      usage: {
        promptTokens,
        completionTokens,
        totalTokens
      }
    };

    // ============ GET USER PLAN ============
    const userLimits = await getUserLimits(uid);
    const ispremium = userLimits.plan === 'premium';

    // ============ CALCULATE COST ============
    // Free users show $0, premium users show actual cost
    const cost = ispremium ? calculateTokenCost(model, promptTokens, completionTokens) : 0;

    // ============ RECORD USAGE ============
    try {
      await recordTokenUsage(
        uid,
        {
          model,
          promptTokens,
          completionTokens,
          timestamp: new Date().toISOString()
        },
        userLimits.chatTokensDaily,
        userLimits.chatTokensMonthly
      );

      // ============ TRACK HOURLY USAGE FOR BILLING ============
      if (ispremium && cost > 0) {
        await trackHourlyApiUsage(uid, cost, {
          model,
          promptTokens,
          completionTokens,
          endpoint: 'chat',
          timestamp: new Date().toISOString()
        });
      }
    } catch (usageError) {
      console.error('Failed to record usage:', usageError.message);
      // Continue anyway - user got the response
    }

    // ============ GET REMAINING ============
    const usageSummary = await getUsageSummary(uid);

    // ============ RESPONSE ============
    res.json({
      success: true,
      choices: aiResponse.choices,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens
      },
      plan: userLimits.plan,
      cost: cost,
      remainingDaily: usageSummary.remainingDaily,
      remainingMonthly: usageSummary.remainingMonthly,
      totalCostUSD: ispremium ? usageSummary.totalCostUSD : 0
    });

  } catch (error) {
    console.error('🔥 Error in POST /api/ai/chat:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /api/ai/transcribe
 * Audio transcription endpoint for mobile app
 * 
 * Converts audio file to text using OpenAI Whisper API
 * 
 * Body: multipart/form-data
 * {
 *   file: <audio file (m4a, mp3, wav, etc)> (required),
 *   model: "whisper-1" | "gpt-4o-mini-transcribe" (optional, maps to whisper-1),
 *   language: "en" (optional, ISO-639-1 code, default: "en")
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   text: "transcribed text",
 *   language: "en",
 *   usage: {promptTokens, completionTokens, totalTokens},
 *   plan: "free" | "premium",
 *   cost: 0.00025,
 *   remainingDaily: 49500,
 *   remainingMonthly: 999500,
 *   totalCostUSD: 0.25
 * }
 */
router.post('/transcribe', verifyFirebaseToken, upload.single('file'), async (req, res) => {
  try {
    const uid = req.user.uid;

    // Get user info
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);
    
    if (!userSnap.exists()) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const userPlan = userSnap.data().plan || 'free';

    // Check limits (applicable for all users)
    const canUse = await checkCanUseTokens(uid);
    if (!canUse.allowed) {
      return res.status(429).json({
        success: false,
        error: 'Token limit exceeded',
        code: 'LIMIT_EXCEEDED'
      });
    }

    // Get the audio file from request
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Audio file is required - send as "file" field in multipart form data',
        code: 'MISSING_FILE'
      });
    }

    const file = req.file;
    
    console.log('📁 File received:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      fieldname: file.fieldname
    });
    
    // Model validation: Map common names to whisper-1
    let model = req.body.model || 'whisper-1';
    if (model === 'gpt-4o-mini-transcribe') {
      console.log('📝 Mapping gpt-4o-mini-transcribe → whisper-1');
      model = 'whisper-1';
    }
    
    const language = req.body.language || 'en';

    // ============ CALL OPENAI TRANSCRIPTION ============
    let openaiResponse;
    let transcriptionData;
    
    try {
      // Use native FormData (Node 18+) instead of form-data package
      const formData = new FormData();
      
      // Create a Blob from the buffer
      const blob = new Blob([file.buffer], { type: file.mimetype || 'audio/mp4' });
      
      // Append the blob as a file
      formData.append('file', blob, file.originalname || 'audio.m4a');
      formData.append('model', model || 'whisper-1');
      
      if (language && language !== 'auto') {
        formData.append('language', language);
      }

      console.log('📤 Sending to OpenAI:', {
        filename: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        model: model || 'whisper-1',
        language: language
      });

      openaiResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          // Don't include Content-Type header - let fetch set it with boundary
        },
        body: formData
      });

      transcriptionData = await openaiResponse.json();

    } catch (apiError) {
      console.error('🔥 OpenAI API error:', apiError.message);
      return res.status(500).json({
        success: false,
        error: apiError.message || 'Transcription failed',
        code: 'TRANSCRIPTION_ERROR'
      });
    }

    // Check if we have a valid response
    if (!openaiResponse) {
      return res.status(500).json({
        success: false,
        error: 'Failed to get response from OpenAI',
        code: 'TRANSCRIPTION_ERROR'
      });
    }

    if (!openaiResponse.ok) {
      console.error('OpenAI Transcription Error:', transcriptionData);
      return res.status(500).json({
        success: false,
        error: transcriptionData.error?.message || 'Transcription failed',
        code: 'TRANSCRIPTION_ERROR'
      });
    }

    const transcribedText = transcriptionData.text || '';

    // ============ ESTIMATE TOKEN USAGE ============
    // Whisper API charges per minute of audio, we estimate tokens from text length
    const estimatedTokens = Math.ceil(transcribedText.length / 4); // rough estimate: ~4 chars per token
    const promptTokens = Math.ceil(estimatedTokens * 0.5);
    const completionTokens = Math.ceil(estimatedTokens * 0.5);
    const totalTokens = promptTokens + completionTokens;
    
    const ispremium = userPlan === 'premium';
    // Calculate actual cost based on model used (whisper-1)
    const cost = ispremium ? calculateTokenCost('whisper-1', promptTokens, completionTokens) : 0;

    // ============ RECORD USAGE ============
    try {
      const userLimits = await getUserLimits(uid);
      await recordTokenUsage(
        uid,
        {
          model: 'whisper-1', // Always record as whisper-1, regardless of input
          promptTokens,
          completionTokens,
          timestamp: new Date().toISOString()
        },
        userLimits.chatTokensDaily,
        userLimits.chatTokensMonthly
      );

      // ============ TRACK HOURLY USAGE FOR BILLING ============
      if (ispremium && cost > 0) {
        await trackHourlyApiUsage(uid, cost, {
          model: 'whisper-1',
          promptTokens,
          completionTokens,
          endpoint: 'transcribe',
          audioFileName: file?.originalname,
          timestamp: new Date().toISOString()
        });
      }
    } catch (usageError) {
      console.error('⚠️ Failed to record transcription usage:', usageError.message);
      // Don't fail the request if recording fails
    }

    // ============ GET REMAINING ============
    const usageSummary = await getUsageSummary(uid);

    // ============ RESPONSE ============
    res.json({
      success: true,
      text: transcribedText,
      language: language,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens
      },
      plan: userPlan,
      cost: cost,
      remainingDaily: usageSummary.remainingDaily,
      remainingMonthly: usageSummary.remainingMonthly,
      totalCostUSD: ispremium ? usageSummary.totalCostUSD : 0
    });

  } catch (error) {
    console.error('🔥 Error in POST /api/ai/transcribe:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Transcription failed',
      code: 'TRANSCRIPTION_ERROR',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * POST /api/ai/speak
 * Text-to-speech endpoint for mobile app
 * 
 * Converts text to speech using OpenAI TTS API
 * 
 * Body:
 * {
 *   text: "string" (required),
 *   voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" (default: alloy),
 *   speed: 0.5-2.0 (default: 1.0),
 *   tone: "calm" | "energetic" | "motivational" (optional),
 *   language: "en" | "es" | "ar" (default: en)
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   audio: "base64 encoded audio data",
 *   mimeType: "audio/mpeg",
 *   usage: {promptTokens, estimatedTokens, totalTokens},
 *   plan: "premium",
 *   cost: 0.00015,
 *   remainingDaily: 49500,
 *   remainingMonthly: 999500,
 *   totalCostUSD: 0.25
 * }
 */
 router.post('/speak', verifyFirebaseToken, async (req, res) => {
   try {
     const uid = req.user.uid;
     const { text, voice = 'alloy', speed = 1.0, tone = '', language = 'en' } = req.body;

     // Validation
     if (!text || typeof text !== 'string' || text.trim() === '') {
       return res.status(400).json({
         success: false,
         error: 'Valid text is required',
         code: 'INVALID_TEXT'
       });
     }

     // ============ GET USER PLAN ============
     const userRef = doc(db, 'users', uid);
     const userSnap = await getDoc(userRef);
     
     if (!userSnap.exists()) {
       return res.status(404).json({
         success: false,
         error: 'User not found',
         code: 'USER_NOT_FOUND'
       });
     }

     const userPlan = userSnap.data().plan || 'free';
     
     if (userPlan !== 'premium') {
       return res.status(403).json({
         success: false,
         error: 'TTS restricted to premium users',
         code: 'premium_REQUIRED',
         plan: userPlan
       });
     }

    // ============ PREPARE TEXT BASED ON TONE ============
    let finalText = text;
    const toneLower = tone?.toLowerCase() || '';
    
    if (toneLower === 'calm') {
      // Make text more mellow with pauses
      finalText = text
        .replace(/[.!?]/g, '…')
        .replace(/\b(and|but|so|then)\b/gi, '… $1')
        .trim();
    } else if (toneLower === 'energetic') {
      // Add energy indicators
      finalText = `${text}! Let's go!`;
    } else if (toneLower === 'motivational') {
      // Add motivational phrases
      finalText = `${text}. You've got this. Believe in yourself!`;
    }

    // ============ CALL OPENAI TTS ============
    const ttsResponse = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: finalText,
        voice: voice || 'alloy',
        speed: Math.max(0.25, Math.min(4.0, parseFloat(speed) || 1.0)), // Clamp between 0.25 and 4.0
      })
    });

    if (!ttsResponse.ok) {
      const errorData = await ttsResponse.json();
      console.error('OpenAI TTS Error:', errorData);
      return res.status(500).json({
        success: false,
        error: errorData.error?.message || 'TTS request failed',
        code: 'TTS_ERROR'
      });
    }

    // ============ GET AUDIO DATA ============
    const audioBuffer = await ttsResponse.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    // ============ GET USER LIMITS ============
    const userLimits = await getUserLimits(uid);

    // ============ ESTIMATE COST ============
    // TTS costs ~$0.015 per 1K characters
    const characterCount = finalText.length;
    const estimatedTokens = Math.ceil(characterCount / 4);
    const promptTokens = Math.ceil(estimatedTokens * 0.3);
    const completionTokens = Math.ceil(estimatedTokens * 0.7);
    const estimatedCost = (characterCount / 1000) * 0.015;

    // ============ RECORD USAGE ============
    try {
      await recordTokenUsage(
        uid,
        {
          model: 'tts-1',
          promptTokens,
          completionTokens,
          timestamp: new Date().toISOString()
        },
        userLimits.chatTokensDaily,
        userLimits.chatTokensMonthly
      );

      // ============ TRACK HOURLY USAGE FOR BILLING ============
      if (userPlan === 'premium' && estimatedCost > 0) {
        await trackHourlyApiUsage(uid, estimatedCost, {
          model: 'tts-1',
          promptTokens,
          completionTokens,
          endpoint: 'tts',
          characterCount,
          voice,
          timestamp: new Date().toISOString()
        });
      }
    } catch (usageError) {
      console.error('Failed to record usage:', usageError.message);
    }

    // ============ GET REMAINING ============
    const usageSummary = await getUsageSummary(uid);

    // ============ RESPONSE ============
    res.json({
      success: true,
      audio: audioBase64,
      mimeType: 'audio/mpeg',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: estimatedTokens
      },
      plan: userPlan,
      cost: estimatedCost,
      remainingDaily: usageSummary.remainingDaily,
      remainingMonthly: usageSummary.remainingMonthly,
      totalCostUSD: usageSummary.totalCostUSD
    });

  } catch (error) {
    console.error('🔥 Error in POST /api/ai/speak:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /api/ai/text-to-speech
 * Text-to-speech endpoint for mobile app
 * 
 * Converts text to speech using OpenAI TTS API
 * 
 * Body:
 * {
 *   model: "tts-1" (required),
 *   input: "string" (required, the text to convert),
 *   voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" (default: alloy),
 *   speed: 0.25-4.0 (default: 1.0),
 *   pitch: -0.1-0.2 (optional, affects tone)
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   audio: "base64 encoded audio data",
 *   mimeType: "audio/mpeg",
 *   usage: {promptTokens, completionTokens, totalTokens},
 *   plan: "free" | "premium",
 *   cost: 0.00015,
 *   remainingDaily: 49500,
 *   remainingMonthly: 999500,
 *   totalCostUSD: 0.25
 * }
 */
router.post('/text-to-speech', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { 
      model = 'tts-1', 
      input, 
      voice = 'alloy', 
      speed = 1.0,
      pitch = 0.0
    } = req.body;

    // ============ VALIDATION ============
    if (!input || typeof input !== 'string' || input.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Valid input text is required',
        code: 'INVALID_INPUT'
      });
    }

    if (!model || typeof model !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Valid model is required',
        code: 'INVALID_MODEL'
      });
    }

    // ============ GET USER PLAN ============
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);
    
    if (!userSnap.exists()) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const userPlan = userSnap.data().plan || 'free';
    
    if (userPlan !== 'premium') {
      return res.status(403).json({
        success: false,
        error: 'TTS restricted to premium users',
        code: 'premium_REQUIRED',
        plan: userPlan
      });
    }

    // ============ CALL OPENAI TTS ============
    // Note: OpenAI TTS API doesn't support pitch parameter directly
    // Pitch is handled by voice selection on frontend, we just pass through the input as-is
    const ttsResponse = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || 'tts-1',
        input: input.trim(),
        voice: voice || 'alloy',
        speed: Math.max(0.25, Math.min(4.0, parseFloat(speed) || 1.0)) // Clamp between 0.25 and 4.0
      })
    });

    if (!ttsResponse.ok) {
      const errorData = await ttsResponse.json();
      console.error('OpenAI TTS Error:', errorData);
      return res.status(500).json({
        success: false,
        error: errorData.error?.message || 'TTS request failed',
        code: 'TTS_ERROR'
      });
    }

    // ============ GET AUDIO DATA ============
    const audioBuffer = await ttsResponse.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    // ============ GET USER LIMITS ============
    const userLimits = await getUserLimits(uid);

    // ============ ESTIMATE COST ============
    // TTS costs ~$0.015 per 1K characters
    const characterCount = input.length;
    const estimatedTokens = Math.ceil(characterCount / 4);
    const promptTokens = Math.ceil(estimatedTokens * 0.3);
    const completionTokens = Math.ceil(estimatedTokens * 0.7);
    const estimatedCost = (characterCount / 1000) * 0.015;

    // ============ RECORD USAGE ============
    try {
      await recordTokenUsage(
        uid,
        {
          model: model || 'tts-1',
          promptTokens,
          completionTokens,
          timestamp: new Date().toISOString()
        },
        userLimits.chatTokensDaily,
        userLimits.chatTokensMonthly
      );

      // ============ TRACK HOURLY USAGE FOR BILLING ============
      if (userPlan === 'premium' && estimatedCost > 0) {
        await trackHourlyApiUsage(uid, estimatedCost, {
          model: model || 'tts-1',
          promptTokens,
          completionTokens,
          endpoint: 'tts-stream',
          characterCount,
          voice,
          speed,
          timestamp: new Date().toISOString()
        });
      }
    } catch (usageError) {
      console.error('Failed to record usage:', usageError.message);
    }

    // ============ GET REMAINING ============
    const usageSummary = await getUsageSummary(uid);

    // ============ RESPONSE ============
    res.json({
      success: true,
      audio: audioBase64,
      mimeType: 'audio/mpeg',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: estimatedTokens
      },
      plan: userPlan,
      cost: estimatedCost,
      remainingDaily: usageSummary.remainingDaily,
      remainingMonthly: usageSummary.remainingMonthly,
      totalCostUSD: usageSummary.totalCostUSD
    });

  } catch (error) {
    console.error('🔥 Error in POST /api/ai/text-to-speech:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /api/ai/generate-questions
 * Generate AI questions for quizzes/surveys
 * 
 * Uses OpenAI to generate category-based questions in specified language
 * 
 * Body:
 * {
 *   category: "fitness" | "wellness" | "health" | etc (required),
 *   language: "en" | "es" | "ar" (default: en),
 *   count: 5 (default: 5, max: 10)
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   questions: [
 *     {
 *       "id": "q1",
 *       "question": "Would you describe yourself as a social person?",
 *       "type": "single",
 *       "options": ["Very social", "Somewhat social", "Prefer to be alone"]
 *     },
 *     ...
 *   ],
 *   language: "en",
 *   category: "fitness",
 *   count: 5,
 *   usage: {promptTokens, completionTokens, totalTokens},
 *   plan: "free",
 *   cost: 0.00045,
 *   remainingDaily: 49500,
 *   remainingMonthly: 999500,
 *   totalCostUSD: 0
 * }
 */
 router.post('/generate-questions', verifyFirebaseToken, async (req, res) => {
   try {
     const uid = req.user.uid;
     const { category = 'fitness', language = 'en', count = 5 } = req.body;

     // Validation
     if (!category || typeof category !== 'string') {
       return res.status(400).json({
         success: false,
         error: 'Valid category is required',
         code: 'INVALID_CATEGORY'
       });
     }

     const questionCount = Math.min(Math.max(parseInt(count) || 5, 1), 10); // Between 1-10

     // ============ GET USER PLAN ============
     const userLimits = await getUserLimits(uid);
     const userPlan = userLimits.plan || 'free';

     // Check limits
     const canUse = await checkCanUseTokens(uid);
     if (!canUse.allowed) {
       return res.status(429).json({
         success: false,
         error: 'Limit exceeded',
         code: 'LIMIT_EXCEEDED'
       });
     }

    // ============ GET LANGUAGE-SPECIFIC INSTRUCTIONS ============
    const getLanguageInstructions = () => {
      switch (language) {
        case 'es':
          return 'Generate all questions and options in Spanish language. Ensure proper Spanish grammar and cultural context.';
        case 'ar':
          return 'Generate all questions and options in Arabic language. Ensure proper Arabic grammar and cultural context. Use formal Arabic (Modern Standard Arabic).';
        case 'en':
        default:
          return 'Generate all questions and options in English language. Ensure proper English grammar and cultural context.';
      }
    };

    // ============ GET EXAMPLE STRUCTURE ============
    const getExampleStructure = () => {
      switch (language) {
        case 'es':
          return `[
  {
    "id": "q1",
    "question": "¿Te describirías como una persona social?",
    "type": "single",
    "options": ["Muy social", "Algo social", "Prefiero estar solo"]
  },
  {
    "id": "q2",
    "question": "¿A menudo te sientes estresado o abrumado?",
    "type": "conditional",
    "options": ["Sí", "No"],
    "followUp": {
      "question": "Si es así, ¿con qué frecuencia?",
      "type": "text"
    }
  }
]`;
        case 'ar':
          return `[
  {
    "id": "q1",
    "question": "هل تصف نفسك كشخص اجتماعي؟",
    "type": "single",
    "options": ["اجتماعي جداً", "اجتماعي إلى حد ما", "أفضل أن أكون وحيداً"]
  },
  {
    "id": "q2",
    "question": "هل تشعر غالباً بالتوتر أو الإرهاق؟",
    "type": "conditional",
    "options": ["نعم", "لا"],
    "followUp": {
      "question": "إذا كانت الإجابة نعم، كم مرة؟",
      "type": "text"
    }
  }
]`;
        case 'en':
        default:
          return `[
  {
    "id": "q1",
    "question": "Would you describe yourself as a social person?",
    "type": "single",
    "options": ["Very social", "Somewhat social", "Prefer to be alone"]
  },
  {
    "id": "q2",
    "question": "Do you often feel stressed or overwhelmed?",
    "type": "conditional",
    "options": ["Yes", "No"],
    "followUp": {
      "question": "If yes, how often?",
      "type": "text"
    }
  }
]`;
      }
    };

    // ============ CALL OPENAI ============
    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a JSON generator. Always return valid JSON ONLY, no explanation. ${getLanguageInstructions()}`
          },
          {
            role: 'user',
            content: `Generate ${questionCount} new ${category} questions in this exact JSON structure, with varied question types (single, conditional, multiple, text):
${getExampleStructure()}`
          }
        ],
        temperature: 0.7,
        max_tokens: 2000
      })
    });

    const aiData = await aiResponse.json();

    if (!aiResponse.ok) {
      console.error('OpenAI API Error:', aiData);
      return res.status(500).json({
        success: false,
        error: aiData.error?.message || 'Failed to generate questions',
        code: 'AI_ERROR'
      });
    }

    let questionsText = aiData.choices?.[0]?.message?.content?.trim() || '[]';

    // ============ PARSE JSON RESPONSE ============
    let questions = [];
    try {
      questions = JSON.parse(questionsText);
    } catch (parseError) {
      console.warn('Failed to parse questions JSON, attempting extraction:', parseError.message);
      // Try extracting JSON from response
      const jsonMatch = questionsText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          questions = JSON.parse(jsonMatch[0]);
        } catch (retryError) {
          console.error('Failed to extract questions:', retryError.message);
          return res.status(500).json({
            success: false,
            error: 'Invalid response format from AI',
            code: 'PARSE_ERROR'
          });
        }
      }
    }

    // Add IDs if missing
    questions = questions.map((q, idx) => ({
      ...q,
      id: q.id || `q${idx + 1}`
    }));

    // ============ CALCULATE COST ============
    const promptTokens = aiData.usage?.prompt_tokens || 0;
    const completionTokens = aiData.usage?.completion_tokens || 0;
    const totalTokens = promptTokens + completionTokens;
    const ispremium = userPlan === 'premium';
    const cost = ispremium ? calculateTokenCost('gpt-4o-mini', promptTokens, completionTokens) : 0;

    // ============ RECORD USAGE ============
    try {
      await recordTokenUsage(
        uid,
        {
          model: 'gpt-4o-mini',
          promptTokens,
          completionTokens,
          timestamp: new Date().toISOString()
        },
        userLimits.chatTokensDaily,
        userLimits.chatTokensMonthly
      );

      // ============ TRACK HOURLY USAGE FOR BILLING ============
      if (ispremium && cost > 0) {
        await trackHourlyApiUsage(uid, cost, {
          model: 'gpt-4o-mini',
          promptTokens,
          completionTokens,
          endpoint: 'generate-questions',
          timestamp: new Date().toISOString()
        });
      }
    } catch (usageError) {
      console.error('Failed to record usage:', usageError.message);
    }

    // ============ GET REMAINING ============
    const usageSummary = await getUsageSummary(uid);

    // ============ RESPONSE ============
    res.json({
      success: true,
      questions,
      language,
      category,
      count: questions.length,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens
      },
      plan: userPlan,
      cost,
      remainingDaily: usageSummary.remainingDaily,
      remainingMonthly: usageSummary.remainingMonthly,
      totalCostUSD: ispremium ? usageSummary.totalCostUSD : 0
    });

  } catch (error) {
    console.error('🔥 Error in POST /api/ai/generate-questions:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /api/ai/extract-keywords
 * Extract keywords from text for voice memory feature
 * 
 * Uses OpenAI to extract relevant keywords from provided text
 * 
 * Body:
 * {
 *   messages: [{role: "user/assistant/system", content: "..."}, ...],
 *   model: "gpt-4o-mini" (default: "gpt-4o-mini"),
 *   temperature: 0.3 (optional, default: 0.3)
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   keywords: ["keyword1", "keyword2", "keyword3"],
 *   count: 3,
 *   usage: {promptTokens, completionTokens, totalTokens},
 *   plan: "free",
 *   cost: 0.00015,
 *   remainingDaily: 49500,
 *   remainingMonthly: 999500,
 *   totalCostUSD: 0
 * }
 */
router.post('/extract-keywords', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { 
      messages,
      model = 'gpt-4o-mini',
      temperature = 0.3
    } = req.body;

    // ============ VALIDATION ============
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'messages array is required and must not be empty',
        code: 'INVALID_MESSAGES'
      });
    }

    // Validate each message has role and content
    for (let i = 0; i < messages.length; i++) {
      if (!messages[i].role || !messages[i].content) {
        return res.status(400).json({
          success: false,
          error: `Message ${i} must have 'role' and 'content' fields`,
          code: 'INVALID_MESSAGE_FORMAT'
        });
      }
    }

    // ============ GET USER PLAN ============
    const userLimits = await getUserLimits(uid);
    const userPlan = userLimits.plan || 'free';

    // ============ CHECK LIMITS ============
    const canUse = await checkCanUseTokens(uid);
    if (!canUse.allowed) {
      return res.status(429).json({
        success: false,
        error: 'Limit exceeded',
        code: 'LIMIT_EXCEEDED'
      });
    }

    // ============ CALL OPENAI ============
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: messages,
        temperature: temperature || 0.3,
        max_tokens: 200
      })
    });

    const aiData = await response.json();

    if (!response.ok) {
      console.error('OpenAI API Error:', aiData);
      return res.status(500).json({
        success: false,
        error: aiData.error?.message || 'Failed to extract keywords',
        code: 'AI_ERROR'
      });
    }

    // ============ PARSE KEYWORDS ============
    let keywordsText = aiData.choices?.[0]?.message?.content?.trim() || '[]';
    let keywords = [];

    try {
      keywords = JSON.parse(keywordsText);
    } catch (parseError) {
      console.warn('Failed to parse keywords JSON, attempting extraction:', parseError.message);
      // Try extracting JSON array from response
      const jsonMatch = keywordsText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          keywords = JSON.parse(jsonMatch[0]);
        } catch (retryError) {
          console.error('Failed to extract keywords:', retryError.message);
          // Fallback: extract quoted strings
          const matches = keywordsText.match(/"([^"]+)"/g);
          keywords = matches ? matches.map(m => m.replace(/"/g, '')) : [];
        }
      }
    }

    // Ensure it's an array
    if (!Array.isArray(keywords)) {
      keywords = [];
    }

    // ============ CALCULATE COST ============
    const promptTokens = aiData.usage?.prompt_tokens || 0;
    const completionTokens = aiData.usage?.completion_tokens || 0;
    const totalTokens = promptTokens + completionTokens;
    const ispremium = userPlan === 'premium';
    const cost = ispremium ? calculateTokenCost('gpt-4o-mini', promptTokens, completionTokens) : 0;

    // ============ RECORD USAGE ============
    try {
      await recordTokenUsage(
        uid,
        {
          model: 'gpt-4o-mini',
          promptTokens,
          completionTokens,
          timestamp: new Date().toISOString()
        },
        userLimits.chatTokensDaily,
        userLimits.chatTokensMonthly
      );
    } catch (usageError) {
      console.error('Failed to record usage:', usageError.message);
    }

    // ============ GET REMAINING ============
    const usageSummary = await getUsageSummary(uid);

    // ============ RESPONSE ============
    res.json({
      success: true,
      keywords,
      count: keywords.length,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens
      },
      plan: userPlan,
      cost,
      remainingDaily: usageSummary.remainingDaily,
      remainingMonthly: usageSummary.remainingMonthly,
      totalCostUSD: ispremium ? usageSummary.totalCostUSD : 0
    });

  } catch (error) {
    console.error('🔥 Error in POST /api/ai/extract-keywords:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /api/ai/models
 * Get available OpenAI models
 * 
 * Returns list of models available for use in the API
 * 
 * Response:
 * {
 *   success: true,
 *   data: {
 *     models: [
 *       { id: "gpt-4o", name: "GPT-4 Omni", type: "chat" },
 *       { id: "gpt-4o-mini", name: "GPT-4 Mini", type: "chat" },
 *       { id: "tts-1", name: "Text-to-Speech", type: "tts" },
 *       { id: "whisper-1", name: "Whisper", type: "transcription" }
 *     ],
 *     defaultModel: "gpt-4o-mini"
 *   }
 * }
 */
router.get('/models', verifyFirebaseToken, async (req, res) => {
  try {
    // Return supported models without calling OpenAI
    // (since not all models are available from the models endpoint)
    const supportedModels = {
      chat: [
        { id: 'gpt-4o', name: 'GPT-4 Omni', description: 'Latest multimodal model' },
        { id: 'gpt-4o-mini', name: 'GPT-4 Mini', description: 'Lightweight chat model' }
      ],
      tts: [
        { id: 'tts-1', name: 'Text-to-Speech', description: 'Real-time text to speech' }
      ],
      transcription: [
        { id: 'whisper-1', name: 'Whisper', description: 'Audio transcription model' }
      ]
    };

    res.json({
      success: true,
      data: {
        models: {
          chat: supportedModels.chat,
          tts: supportedModels.tts,
          transcription: supportedModels.transcription
        },
        defaultModel: 'gpt-4o-mini',
        chatModels: supportedModels.chat.map(m => m.id),
        ttsModels: supportedModels.tts.map(m => m.id),
        transcriptionModels: supportedModels.transcription.map(m => m.id)
      }
    });

  } catch (error) {
    console.error('🔥 Error in GET /api/ai/models:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

export default router;
