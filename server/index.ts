import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---

// Rate limiting (simple in-memory, per-IP)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30; // 30 requests per minute

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

// Increase payload size to handle base64 images (up to 10MB)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
    .replace(/\b(ignore all|system prompt|previous instructions|disregard|override)\b/gi, '') // Remove injection keywords
    .trim();
}

// --- API Routes ---

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Optimize a single expression prompt
app.post('/api/optimize-prompt', async (req: Request, res: Response) => {
  try {
    const { name, intensity, scope, customInstructions } = req.body;

    if (!name || !intensity || !scope) {
      res.status(400).json({ error: 'Missing required fields: name, intensity, scope' });
      return;
    }

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

    const optimizedPrompt = textResponse.text?.trim() || `Edit this image to show the character with a ${sanitizeInput(name)} expression.`;
    res.json({ prompt: optimizedPrompt });
  } catch (error: any) {
    console.error('Error optimizing prompt:', error);
    const statusCode = error?.status === 429 ? 429 : 500;
    res.status(statusCode).json({ error: error.message || 'Failed to optimize prompt' });
  }
});

// Optimize batch prompts for multiple expressions
app.post('/api/optimize-batch-prompts', async (req: Request, res: Response) => {
  try {
    const { expressions, intensity, scope, customInstructions } = req.body;

    if (!expressions || !Array.isArray(expressions) || !intensity || !scope) {
      res.status(400).json({ error: 'Missing required fields: expressions (array), intensity, scope' });
      return;
    }

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
      res.json({ prompts: result });
    } catch (parseError) {
      console.error('Failed to parse batch prompts:', parseError);
      res.json({ prompts: {} });
    }
  } catch (error: any) {
    console.error('Error optimizing batch prompts:', error);
    const statusCode = error?.status === 429 ? 429 : 500;
    res.status(statusCode).json({ error: error.message || 'Failed to optimize batch prompts' });
  }
});

// Generate image from reference + prompt
app.post('/api/generate-image', async (req: Request, res: Response) => {
  try {
    const { refImage, prompt } = req.body;

    if (!refImage || !prompt) {
      res.status(400).json({ error: 'Missing required fields: refImage, prompt' });
      return;
    }

    // Validate refImage is a valid data URL
    const dataUrlMatch = refImage.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    if (!dataUrlMatch) {
      res.status(400).json({ error: 'Invalid image format. Expected PNG, JPEG, or WebP base64 data URL.' });
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
      res.json({ imageUrl });
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
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
});

// Graceful shutdown
function gracefulShutdown(signal: string): void {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('✅ Server closed.');
    process.exit(0);
  });
  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('⚠️  Forced shutdown after timeout.');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
