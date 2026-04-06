import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Budget & Quota Configuration ---
// Environment variables (set in .env or hosting platform):
//   MAX_DAILY_IMAGE_CALLS - Max image generation calls per day (default: 10)
//   MAX_DAILY_PROMPT_CALLS - Max prompt optimization calls per day (default: 50)
//   SESSION_MAX_IMAGES - Max images a single session can generate (default: 5)
const MAX_DAILY_IMAGE_CALLS = parseInt(process.env.MAX_DAILY_IMAGE_CALLS || '10', 10);
const MAX_DAILY_PROMPT_CALLS = parseInt(process.env.MAX_DAILY_PROMPT_CALLS || '50', 10);
const SESSION_MAX_IMAGES = parseInt(process.env.SESSION_MAX_IMAGES || '5', 10);

// --- Usage Tracking (In-Memory) ---
interface UsageRecord {
  imageCalls: number;
  promptCalls: number;
  sessionImageCalls: Map<string, number>; // sessionId -> count
  resetAt: number;
}

let usage: UsageRecord = {
  imageCalls: 0,
  promptCalls: 0,
  sessionImageCalls: new Map(),
  resetAt: Date.now() + 24 * 60 * 60 * 1000, // Reset every 24 hours
};

function resetDailyUsage(): void {
  usage = {
    imageCalls: 0,
    promptCalls: 0,
    sessionImageCalls: new Map(),
    resetAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  console.log('📊 Daily usage reset.');
}

function checkDailyLimits(res: Response): boolean {
  if (Date.now() > usage.resetAt) {
    resetDailyUsage();
  }

  if (usage.imageCalls >= MAX_DAILY_IMAGE_CALLS) {
    res.status(429).json({
      error: `Daily image generation limit reached (${MAX_DAILY_IMAGE_CALLS}/${MAX_DAILY_IMAGE_CALLS}). Try again tomorrow.`,
      limitReached: true,
      limitType: 'daily_images',
    });
    return false;
  }

  if (usage.promptCalls >= MAX_DAILY_PROMPT_CALLS) {
    res.status(429).json({
      error: `Daily prompt optimization limit reached (${MAX_DAILY_PROMPT_CALLS}/${MAX_DAILY_PROMPT_CALLS}). Try again tomorrow.`,
      limitReached: true,
      limitType: 'daily_prompts',
    });
    return false;
  }

  return true;
}

function checkSessionLimit(sessionId: string, res: Response): boolean {
  const count = usage.sessionImageCalls.get(sessionId) || 0;
  if (count >= SESSION_MAX_IMAGES) {
    res.status(429).json({
      error: `Session image limit reached (${SESSION_MAX_IMAGES}/${SESSION_MAX_IMAGES}). Please refresh for a new session.`,
      limitReached: true,
      limitType: 'session_images',
    });
    return false;
  }
  return true;
}

function incrementUsage(endpoint: 'image' | 'prompt', sessionId?: string): void {
  if (endpoint === 'image') {
    usage.imageCalls++;
    if (sessionId) {
      const count = usage.sessionImageCalls.get(sessionId) || 0;
      usage.sessionImageCalls.set(sessionId, count + 1);
    }
  } else {
    usage.promptCalls++;
  }
}

// --- Response Caching ---
// Cache key = hash of request body. Stores result for 1 hour.
interface CacheEntry {
  data: any;
  expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheKey(req: Request): string {
  const bodyStr = JSON.stringify(req.body);
  return crypto.createHash('sha256').update(bodyStr).digest('hex');
}

function getFromCache(key: string): any | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  return entry.data;
}

function setInCache(key: string, data: any): void {
  responseCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of responseCache.entries()) {
    if (now > entry.expiresAt) {
      responseCache.delete(key);
    }
  }
}, 5 * 60 * 1000); // Clean every 5 minutes

// --- Middleware ---

// Rate limiting (simple in-memory, per-IP)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute (reduced)

function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now > record.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }

  record.count++;
  if (record.count > RATE_LIMIT_MAX) {
    res.set('Retry-After', String(Math.ceil((record.resetAt - now) / 1000)));
    res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
    return;
  }

  next();
}

// Increase payload size to handle base64 images (up to 5MB)
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Rate limit API only
app.use('/api', rateLimiter);

// --- CORS ---
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.length === 0 || allowedOrigins.includes(origin || '')) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// --- Gemini AI ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Sanitize input to prevent prompt injection
function sanitizeInput(input: string): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\b(ignore all|system prompt|previous instructions|disregard|override)\b/gi, '')
    .trim();
}

// --- Client-Side Prompt Templates (No API Call Needed) ---
const PROMPT_TEMPLATES: Record<string, Record<string, string>> = {
  face_only: {
    subtle: 'Edit this image to show the character with a {expression} expression. Keep the pose and body exactly the same. Only subtle facial change.',
    normal: 'Edit this image to show the character with a {expression} expression. Keep the pose, body, and clothing exactly the same. Only modify the face.',
    exaggerated: 'Edit this image to show the character with a highly exaggerated {expression} expression. Keep the pose and body the same but make the face very expressive and cartoonish.',
  },
  pose_and_props: {
    subtle: 'Edit this image to show the character with a {expression} expression. Subtle changes to pose and body language to match the mood.',
    normal: 'Edit this image to show the character with a {expression} expression. Modify the face, pose, and body language to match. Add relevant props if it fits the emotion.',
    exaggerated: 'Edit this image to show the character with a very exaggerated {expression} expression. Change the pose, body language, and add dramatic props like sweat drops, tears, or hearts.',
  },
};

function generateTemplatePrompt(expression: string, intensity: string, scope: string): string {
  const template = PROMPT_TEMPLATES[scope]?.[intensity] || PROMPT_TEMPLATES.face_only.normal;
  return template.replace('{expression}', sanitizeInput(expression));
}

// --- API Routes ---

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    usage: {
      dailyImages: `${usage.imageCalls}/${MAX_DAILY_IMAGE_CALLS}`,
      dailyPrompts: `${usage.promptCalls}/${MAX_DAILY_PROMPT_CALLS}`,
      resetsAt: new Date(usage.resetAt).toISOString(),
    },
  });
});

// Usage stats endpoint
app.get('/api/usage', (_req: Request, res: Response) => {
  res.json({
    dailyImages: { used: usage.imageCalls, limit: MAX_DAILY_IMAGE_CALLS },
    dailyPrompts: { used: usage.promptCalls, limit: MAX_DAILY_PROMPT_CALLS },
    sessionLimit: SESSION_MAX_IMAGES,
    resetsAt: new Date(usage.resetAt).toISOString(),
  });
});

// Optimize a single expression prompt
app.post('/api/optimize-prompt', async (req: Request, res: Response) => {
  try {
    const { name, intensity, scope, customInstructions, skipAI } = req.body;

    if (!name || !intensity || !scope) {
      res.status(400).json({ error: 'Missing required fields: name, intensity, scope' });
      return;
    }

    // Check cache first
    const key = cacheKey(req);
    const cached = getFromCache(key);
    if (cached) {
      res.json(cached);
      return;
    }

    // If skipAI is true, use template instead of calling the AI
    if (skipAI || usage.promptCalls >= MAX_DAILY_PROMPT_CALLS) {
      const templatePrompt = generateTemplatePrompt(name, intensity, scope);
      const finalPrompt = customInstructions
        ? `${templatePrompt} Additional: ${sanitizeInput(customInstructions)}`
        : templatePrompt;
      const result = { prompt: finalPrompt, fromTemplate: true };
      setInCache(key, result);
      res.json(result);
      return;
    }

    // Use AI to optimize (costs API call)
    incrementUsage('prompt');

    const enhancerPrompt = `You are an expert prompt engineer for an image-to-image AI model.
Your task is to write a highly optimized prompt to edit a reference image of a character.

Target Expression/Action: "${sanitizeInput(name)}"
Modification Scope: ${scope === 'face_only' ? 'Modify ONLY the facial features. The body, pose, and clothing MUST remain exactly the same.' : 'Modify the facial features, and ALSO change the body language, hand gestures, and add relevant props (like tears, sweat drops, hearts, etc.) to match the emotion.'}
Intensity: ${intensity === 'subtle' ? 'Subtle and natural.' : intensity === 'exaggerated' ? 'Highly exaggerated, cartoonish, and dynamic.' : 'Clear and distinct.'}
Additional Instructions: ${sanitizeInput(customInstructions) || 'None'}

Write ONLY the final prompt. The prompt MUST start with "Edit this image to ". Keep it under 3 sentences.`;

    const textResponse = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview',
      contents: enhancerPrompt,
    });

    const optimizedPrompt = textResponse.text?.trim() || generateTemplatePrompt(name, intensity, scope);
    const result = { prompt: optimizedPrompt, fromTemplate: false };
    setInCache(key, result);
    res.json(result);
  } catch (error: any) {
    console.error('Error optimizing prompt:', error);
    // Fallback to template on error
    const { name, intensity, scope, customInstructions } = req.body;
    const fallback = generateTemplatePrompt(name, intensity, scope);
    res.json({ prompt: fallback, fromTemplate: true, error: error.message });
  }
});

// Optimize batch prompts for multiple expressions
app.post('/api/optimize-batch-prompts', async (req: Request, res: Response) => {
  try {
    const { expressions, intensity, scope, customInstructions, skipAI } = req.body;

    if (!expressions || !Array.isArray(expressions) || !intensity || !scope) {
      res.status(400).json({ error: 'Missing required fields: expressions (array), intensity, scope' });
      return;
    }

    // Check cache first
    const key = cacheKey(req);
    const cached = getFromCache(key);
    if (cached) {
      res.json(cached);
      return;
    }

    // If skipAI is true or daily limit reached, use templates
    if (skipAI || usage.promptCalls >= MAX_DAILY_PROMPT_CALLS) {
      const prompts: Record<string, string> = {};
      for (const name of expressions) {
        let p = generateTemplatePrompt(name, intensity, scope);
        if (customInstructions) {
          p += ` Additional: ${sanitizeInput(customInstructions)}`;
        }
        prompts[name] = p;
      }
      const result = { prompts, fromTemplate: true };
      setInCache(key, result);
      res.json(result);
      return;
    }

    // Use AI to optimize (costs 1 API call for all expressions)
    incrementUsage('prompt');

    const sanitizedExpressions = expressions.map((e: string) => sanitizeInput(e));

    const enhancerPrompt = `You are an expert prompt engineer for an image-to-image AI model.
Write highly optimized prompts to edit a reference image of a character for the following expressions/actions: ${sanitizedExpressions.join(', ')}.

Modification Scope: ${scope === 'face_only' ? 'Modify ONLY the facial features. The body, pose, and clothing MUST remain exactly the same.' : 'Modify the facial features, and ALSO change the body language, hand gestures, and add relevant props to match the emotion.'}
Intensity: ${intensity === 'subtle' ? 'Subtle and natural.' : intensity === 'exaggerated' ? 'Highly exaggerated, cartoonish, and dynamic.' : 'Clear and distinct.'}
Additional Instructions: ${sanitizeInput(customInstructions) || 'None'}

For each expression, write a prompt starting with "Edit this image to ". Keep each prompt under 3 sentences.`;

    const textResponse = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview',
      contents: enhancerPrompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING, description: "The exact expression name from the list" },
              prompt: { type: Type.STRING, description: "The optimized prompt" }
            },
            required: ["name", "prompt"]
          }
        }
      }
    });

    try {
      const parsed = JSON.parse(textResponse.text?.trim() || "[]");
      const result: Record<string, string> = {};
      if (Array.isArray(parsed)) {
        parsed.forEach((p: any) => {
          result[p.name] = sanitizeInput(p.prompt);
        });
      }
      const response = { prompts: result, fromTemplate: false };
      setInCache(key, response);
      res.json(response);
    } catch (parseError) {
      console.error('Failed to parse batch prompts:', parseError);
      // Fallback to templates
      const prompts: Record<string, string> = {};
      for (const name of expressions) {
        let p = generateTemplatePrompt(name, intensity, scope);
        if (customInstructions) {
          p += ` Additional: ${sanitizeInput(customInstructions)}`;
        }
        prompts[name] = p;
      }
      res.json({ prompts, fromTemplate: true });
    }
  } catch (error: any) {
    console.error('Error optimizing batch prompts:', error);
    // Fallback to templates
    const { expressions, intensity, scope, customInstructions } = req.body;
    const prompts: Record<string, string> = {};
    for (const name of expressions) {
      let p = generateTemplatePrompt(name, intensity, scope);
      if (customInstructions) {
        p += ` Additional: ${sanitizeInput(customInstructions)}`;
      }
      prompts[name] = p;
    }
    res.json({ prompts, fromTemplate: true });
  }
});

// Generate image from reference + prompt
app.post('/api/generate-image', async (req: Request, res: Response) => {
  try {
    const { refImage, prompt, sessionId } = req.body;

    if (!refImage || !prompt) {
      res.status(400).json({ error: 'Missing required fields: refImage, prompt' });
      return;
    }

    // Check daily limits
    if (!checkDailyLimits(res)) return;

    // Check session limit
    const sid = sessionId || req.ip || 'anonymous';
    if (!checkSessionLimit(sid, res)) return;

    // Validate refImage is a valid data URL
    const dataUrlMatch = refImage.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    if (!dataUrlMatch) {
      res.status(400).json({ error: 'Invalid image format. Expected PNG, JPEG, or WebP base64 data URL.' });
      return;
    }

    // Check cache
    const key = cacheKey(req);
    const cached = getFromCache(key);
    if (cached) {
      res.json(cached);
      return;
    }

    const mimeType = dataUrlMatch[1];
    const base64Data = dataUrlMatch[2];

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [
          { inlineData: { data: base64Data, mimeType: `image/${mimeType}` } },
          { text: sanitizeInput(prompt) },
        ],
      },
    });

    let imageUrl = '';
    if (response.candidates && response.candidates[0] && response.candidates[0].content.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          imageUrl = `data:image/png;base64,${part.inlineData.data}`;
          break;
        }
      }
    }

    if (imageUrl) {
      incrementUsage('image', sid);
      const result = { imageUrl };
      setInCache(key, result);
      res.json(result);
    } else {
      res.status(500).json({ error: 'No image data returned from AI.' });
    }
  } catch (error: any) {
    console.error('Error generating image:', error);
    const statusCode = error?.status === 429 ? 429 : 500;
    res.status(statusCode).json({ error: error.message || 'Failed to generate image' });
  }
});

// --- Static Frontend (Production) ---
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

// SPA fallback: serve index.html for any non-API route
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// --- Error Handling ---
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Start Server ---
const server = app.listen(PORT, () => {
  console.log(`✅ AvaGenEx server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Budget Limits: ${MAX_DAILY_IMAGE_CALLS} images/day, ${MAX_DAILY_PROMPT_CALLS} prompts/day, ${SESSION_MAX_IMAGES} images/session`);
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
});

// Graceful shutdown
function gracefulShutdown(signal: string): void {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('✅ Server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('⚠️  Forced shutdown after timeout.');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
