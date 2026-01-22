/**
 * AI Proxy Routes
 * Mobile app calls these endpoints instead of calling OpenAI directly
 * Backend handles: Authentication, Usage Tracking, Token Counting, Billing
 */

import express from 'express';
import { verifyFirebaseToken } from '../../middleware/firebaseAuthMiddleware.js';
import { recordTokenUsage, checkCanUseTokens, getUsageSummary, getUserLimits } from '../../services/usageService.js';
import { calculateTokenCost } from '../../utils/tokenPricing.js';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase.js';

const router = express.Router();

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
 *   prompt: "string",
 *   history: [{role, content}, ...],
 *   model: "gpt-4o" | "gpt-4o-mini",
 *   systemPrompt: "optional"
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   choices: [{text: "..."}],
 *   usage: {promptTokens, completionTokens, totalTokens},
 *   cost: 0.00045,
 *   remainingDaily: 49500,
 *   remainingMonthly: 999500
 * }
 */
router.post('/chat', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { prompt, history = [], model = 'gpt-4o-mini', systemPrompt = '' } = req.body;

    // ============ VALIDATION ============
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Valid prompt is required',
        code: 'INVALID_PROMPT'
      });
    }

    if (!Array.isArray(history)) {
      return res.status(400).json({
        success: false,
        error: 'History must be an array',
        code: 'INVALID_HISTORY'
      });
    }

    // Validate history items have role and content
    for (let i = 0; i < history.length; i++) {
      if (!history[i].role || !history[i].content) {
        return res.status(400).json({
          success: false,
          error: `History item ${i} must have 'role' and 'content' fields`,
          code: 'INVALID_HISTORY_FORMAT'
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
    const messages = [];
    
    // Add system prompt if provided
    if (systemPrompt && systemPrompt.trim()) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    
    // Add conversation history
    messages.push(...history);
    
    // Add user prompt
    messages.push({ role: 'user', content: prompt });

    // Call OpenAI directly
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: messages,
        temperature: 0.7,
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
        text: choice.message.content
      })),
      usage: {
        promptTokens,
        completionTokens,
        totalTokens
      }
    };

    // ============ GET USER PLAN ============
    const userLimits = await getUserLimits(uid);
    const isPremier = userLimits.plan === 'premier';

    // ============ CALCULATE COST ============
    // Free users show $0, premier users show actual cost
    const cost = isPremier ? calculateTokenCost(model, promptTokens, completionTokens) : 0;

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
      totalCostUSD: isPremier ? usageSummary.totalCostUSD : 0
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
 *   file: <audio file (m4a, mp3, wav, etc)>,
 *   language: "en" (optional, ISO-639-1 code)
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   text: "transcribed text",
 *   language: "en",
 *   cost: 0.00025,
 *   remainingDaily: 49500,
 *   remainingMonthly: 999500
 * }
 */
router.post('/transcribe', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;

    // Check if user is premier
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);
    
    if (!userSnap.exists() || userSnap.data().plan !== 'premier') {
      return res.status(403).json({
        success: false,
        error: 'Transcription restricted to Premier users',
        code: 'PREMIER_REQUIRED'
      });
    }

    // Check limits
    const canUse = await checkCanUseTokens(uid);
    if (!canUse.allowed) {
      return res.status(429).json({
        success: false,
        error: 'Limit exceeded',
        code: 'LIMIT_EXCEEDED'
      });
    }

    // Get the audio file from request
    if (!req.file && !req.files?.file) {
      return res.status(400).json({
        success: false,
        error: 'Audio file is required',
        code: 'MISSING_FILE'
      });
    }

    const file = req.file || req.files.file;
    const language = req.body.language || 'en';

    // ============ CALL OPENAI TRANSCRIPTION ============
    const FormData = (await import('form-data')).default;
    const fs = await import('fs');
    
    const formData = new FormData();
    formData.append('file', file.data, {
      filename: file.name || 'audio.m4a',
      contentType: file.mimetype || 'audio/m4a'
    });
    formData.append('model', 'whisper-1');
    if (language) {
      formData.append('language', language);
    }

    const openaiResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    const transcriptionData = await openaiResponse.json();

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
    // Whisper charges per minute of audio, approximate tokens
    const estimatedTokens = Math.ceil(transcribedText.length / 4); // rough estimate
    const cost = calculateTokenCost('gpt-4o-mini', Math.ceil(estimatedTokens * 0.5), Math.ceil(estimatedTokens * 0.5));

    // ============ RECORD USAGE ============
    try {
      const userLimits = await getUserLimits(uid);
      await recordTokenUsage(
        uid,
        {
          model: 'whisper-1',
          promptTokens: Math.ceil(estimatedTokens * 0.5),
          completionTokens: Math.ceil(estimatedTokens * 0.5),
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
      text: transcribedText,
      language: language,
      cost: cost,
      remainingDaily: usageSummary.remainingDaily,
      remainingMonthly: usageSummary.remainingMonthly
    });

  } catch (error) {
    console.error('🔥 Error in POST /api/ai/transcribe:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR'
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
 *   plan: "premier",
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
     
     if (userPlan !== 'premier') {
       return res.status(403).json({
         success: false,
         error: 'TTS restricted to Premier users',
         code: 'PREMIER_REQUIRED',
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
    const isPremier = userPlan === 'premier';
    const cost = isPremier ? calculateTokenCost('gpt-4o-mini', promptTokens, completionTokens) : 0;

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
      totalCostUSD: isPremier ? usageSummary.totalCostUSD : 0
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
 * Uses OpenAI to extract 3-5 relevant keywords from provided text
 * 
 * Body:
 * {
 *   text: "string" (required, the text to extract keywords from)
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
    const { text } = req.body;

    // ============ VALIDATION ============
    if (!text || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Valid text is required',
        code: 'INVALID_TEXT'
      });
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
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a keyword extraction assistant. Extract 3–5 relevant keywords or topics from the provided text. Return ONLY a pure JSON array of strings, like ["keyword1", "keyword2"]. Do not include any extra text or markdown.'
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.3,
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
    const isPremier = userPlan === 'premier';
    const cost = isPremier ? calculateTokenCost('gpt-4o-mini', promptTokens, completionTokens) : 0;

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
      totalCostUSD: isPremier ? usageSummary.totalCostUSD : 0
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
