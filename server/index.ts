import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Increase payload size to handle base64 images (up to 10MB)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS for local dev (Vite dev server runs on port 3000)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'http://localhost:3000');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- Endpoints ---

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

    const optimizedPrompt = textResponse.text?.trim() || `Edit this image to show the character with a ${name} expression.`;
    res.json({ prompt: optimizedPrompt });
  } catch (error: any) {
    console.error('Error optimizing prompt:', error);
    res.status(500).json({ error: error.message || 'Failed to optimize prompt' });
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
          // Sanitize output prompts
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
    res.status(500).json({ error: error.message || 'Failed to optimize batch prompts' });
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
    res.status(500).json({ error: error.message || 'Failed to generate image' });
  }
});

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Sanitize input to prevent prompt injection
function sanitizeInput(input: string): string {
  if (typeof input !== 'string') return '';
  // Remove potentially harmful patterns while preserving legitimate text
  return input
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
    .replace(/\b(ignore all|system prompt|previous instructions|disregard|override)\b/gi, '') // Remove injection keywords
    .trim();
}

app.listen(PORT, () => {
  console.log(`✅ Avatar Expression Generator server running on port ${PORT}`);
  console.log(`📍 API available at http://localhost:${PORT}/api/health`);
});
