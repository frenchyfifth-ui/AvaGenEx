import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, Download, Trash2, Image as ImageIcon, Sparkles, UserCircle, CheckCircle2, AlertCircle, Plus, X, SlidersHorizontal, LayoutGrid, DownloadCloud, Wallet, Zap } from 'lucide-react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

// --- Constants ---
const DEFAULT_EXPRESSIONS = [
  'happy', 'sad', 'angry', 'surprised',
  'laughing', 'crying', 'thinking', 'winking',
  'scared', 'confused', 'smug', 'shocked'
];

const MAX_IMAGE_SIZE_MB = 5;
const MAX_IMAGE_DIMENSION = 1024; // Resize images larger than this

// --- Types ---
interface GeneratedExpression {
  id: string;
  name: string;
  status: 'idle' | 'generating' | 'done' | 'error';
  dataUrl?: string;
  errorMessage?: string;
  progressMessage?: string;
}

type Intensity = 'subtle' | 'normal' | 'exaggerated';
type GenerationScope = 'face_only' | 'pose_and_props';

// --- Utility Functions ---
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Sanitize user input to prevent prompt injection
const sanitizeInput = (input: string): string => {
  if (typeof input !== 'string') return '';
  return input
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
    .replace(/\b(ignore all|system prompt|previous instructions|disregard|override)\b/gi, '') // Remove injection keywords
    .trim();
};

// Resize image client-side to reduce API costs and improve performance
const resizeImage = (dataUrl: string, maxSizeMB: number, maxDimension: number): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let { width, height } = img;

      // Scale down if exceeds max dimension
      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = (height / width) * maxDimension;
          width = maxDimension;
        } else {
          width = (width / height) * maxDimension;
          height = maxDimension;
        }
      }

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);
      const resizedDataUrl = canvas.toDataURL('image/jpeg', 0.85);
      resolve(resizedDataUrl);
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
};

// Validate image file
const validateImageFile = (file: File): string | null => {
  if (!file.type.startsWith('image/')) {
    return 'Please upload a valid image file (PNG, JPEG, WebP)';
  }

  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > MAX_IMAGE_SIZE_MB) {
    return `Image is too large (${sizeMB.toFixed(1)}MB). Maximum size is ${MAX_IMAGE_SIZE_MB}MB.`;
  }

  return null;
};

// --- API Functions ---
interface OptimizePromptResponse {
  prompt: string;
}

interface OptimizeBatchPromptsResponse {
  prompts: Record<string, string>;
}

interface GenerateImageResponse {
  imageUrl: string;
}

const apiRequest = async <T,>(endpoint: string, body: object): Promise<T> => {
  const response = await fetch(`/api${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `Server error: ${response.status}` }));
    throw new Error(error.error || `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
};

// Usage tracking
interface UsageInfo {
  dailyImages: { used: number; limit: number };
  dailyPrompts: { used: number; limit: number };
  sessionLimit: number;
  resetsAt: string;
}

const fetchUsage = async (): Promise<UsageInfo> => {
  try {
    const response = await fetch('/api/usage');
    if (response.ok) return response.json();
  } catch {
    // Silently fail
  }
  return { dailyImages: { used: 0, limit: 10 }, dailyPrompts: { used: 0, limit: 50 }, sessionLimit: 5, resetsAt: '' };
};

const optimizeSinglePrompt = async (
  name: string,
  currentIntensity: Intensity,
  currentScope: GenerationScope,
  customInstructions: string,
  useTemplateOnly: boolean
): Promise<string> => {
  const result = await apiRequest<OptimizePromptResponse>('/optimize-prompt', {
    name: sanitizeInput(name),
    intensity: currentIntensity,
    scope: currentScope,
    customInstructions: sanitizeInput(customInstructions),
    skipAI: useTemplateOnly,
  });
  return result.prompt;
};

const optimizeBatchPrompts = async (
  expressions: string[],
  currentIntensity: Intensity,
  currentScope: GenerationScope,
  customInstructions: string,
  useTemplateOnly: boolean
): Promise<Record<string, string>> => {
  const sanitizedExpressions = expressions.map(sanitizeInput);
  const result = await apiRequest<OptimizeBatchPromptsResponse>('/optimize-batch-prompts', {
    expressions: sanitizedExpressions,
    intensity: currentIntensity,
    scope: currentScope,
    customInstructions: sanitizeInput(customInstructions),
    skipAI: useTemplateOnly,
  });
  return result.prompts;
};

const generateImage = async (refImage: string, prompt: string): Promise<string> => {
  const result = await apiRequest<GenerateImageResponse>('/generate-image', {
    refImage,
    prompt: sanitizeInput(prompt),
  });
  return result.imageUrl;
};

// --- Main Component ---
export default function App() {
  const [referenceSrc, setReferenceSrc] = useState<string | null>(null);
  const [expressions, setExpressions] = useState<GeneratedExpression[]>(
    DEFAULT_EXPRESSIONS.map(name => ({ id: crypto.randomUUID(), name, status: 'idle' }))
  );
  const [newExpressionName, setNewExpressionName] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // Settings
  const [intensity, setIntensity] = useState<Intensity>('normal');
  const [scope, setScope] = useState<GenerationScope>('face_only');
  const [customPrompt, setCustomPrompt] = useState('');
  const [useTemplatePrompts, setUseTemplatePrompts] = useState(true); // Default: free mode
  const [usage, setUsage] = useState<UsageInfo | null>(null);

  const refInputRef = useRef<HTMLInputElement>(null);

  // Fetch usage info on mount and periodically
  useEffect(() => {
    fetchUsage().then(setUsage);
    const interval = setInterval(() => fetchUsage().then(setUsage), 30_000);
    return () => clearInterval(interval);
  }, []);

  const handleReferenceUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file
    const validationError = validateImageFile(file);
    if (validationError) {
      setImageError(validationError);
      return;
    }

    setImageError(null);

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const rawDataUrl = event.target?.result as string;
        // Resize if needed
        const processedDataUrl = await resizeImage(rawDataUrl, MAX_IMAGE_SIZE_MB, MAX_IMAGE_DIMENSION);
        setReferenceSrc(processedDataUrl);
        // Reset all expressions when a new reference is uploaded
        setExpressions(prev => prev.map(exp => ({
          ...exp,
          status: 'idle',
          dataUrl: undefined,
          errorMessage: undefined,
          progressMessage: undefined
        })));
      } catch (err: any) {
        setImageError(err.message || 'Failed to process image');
      }
    };
    reader.onerror = () => setImageError('Failed to read image file');
    reader.readAsDataURL(file);
  }, []);

  const addExpression = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = sanitizeInput(newExpressionName.trim().toLowerCase().replace(/\s+/g, '_'));
    if (trimmed && !expressions.some(exp => exp.name === trimmed)) {
      setExpressions(prev => [...prev, { id: crypto.randomUUID(), name: trimmed, status: 'idle' }]);
      setNewExpressionName('');
    }
  };

  const removeExpression = (id: string) => {
    setExpressions(prev => prev.filter(exp => exp.id !== id));
  };

  const generateWithRetry = async <T,>(apiCall: () => Promise<T>, maxRetries = 3): Promise<T> => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await apiCall();
      } catch (error: any) {
        const isRateLimit = error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('quota') || error?.message?.includes('rate limit');
        if (isRateLimit && i < maxRetries - 1) {
          const delay = Math.pow(2, i) * 3000; // 3s, 6s, 12s
          console.log(`Rate limited. Retrying in ${delay}ms...`);
          await sleep(delay);
        } else {
          throw error;
        }
      }
    }
    throw new Error('Max retries exceeded');
  };

  const executeImageGeneration = async (id: string, name: string, refImage: string, optimizedPrompt: string) => {
    setExpressions(prev => prev.map(exp => exp.id === id ? { ...exp, progressMessage: 'Rendering image...' } : exp));
    try {
      const imageUrl = await generateWithRetry(() => generateImage(refImage, optimizedPrompt));

      if (imageUrl) {
        setExpressions(prev => prev.map(exp => exp.id === id ? { ...exp, status: 'done', dataUrl: imageUrl } : exp));
      } else {
        throw new Error('No image data returned from AI.');
      }
    } catch (error: any) {
      console.error(`Error generating ${name}:`, error);
      setExpressions(prev => prev.map(exp => exp.id === id ? { ...exp, status: 'error', errorMessage: error.message || 'Failed to generate' } : exp));
    }
  };

  const generateSingleExpression = async (id: string, name: string, refImage: string, currentIntensity: Intensity, currentScope: GenerationScope, customInstructions: string) => {
    setExpressions(prev => prev.map(exp => exp.id === id ? { ...exp, status: 'generating', progressMessage: 'Preparing prompt...', errorMessage: undefined } : exp));
    try {
      const optimizedPrompt = await generateWithRetry(() => optimizeSinglePrompt(name, currentIntensity, currentScope, customInstructions, useTemplatePrompts));
      await executeImageGeneration(id, name, refImage, optimizedPrompt);
    } catch (error: any) {
      setExpressions(prev => prev.map(exp => exp.id === id ? { ...exp, status: 'error', errorMessage: error.message || 'Failed to generate' } : exp));
    }
  };

  const generateAllPending = async () => {
    if (!referenceSrc) return;
    setIsGenerating(true);

    const pending = expressions.filter(exp => exp.status === 'idle' || exp.status === 'error');
    if (pending.length === 0) {
      setIsGenerating(false);
      return;
    }

    // Mark all as generating
    setExpressions(prev => prev.map(exp => pending.find(p => p.id === exp.id) ? { ...exp, status: 'generating', progressMessage: 'Batch optimizing...', errorMessage: undefined } : exp));

    try {
      // Batch optimize
      const names = pending.map(e => e.name);
      const batchPrompts = await generateWithRetry(() => optimizeBatchPrompts(names, intensity, scope, customPrompt, useTemplatePrompts));

      // Process sequentially to avoid rate limits
      for (let i = 0; i < pending.length; i++) {
        const exp = pending[i];
        const prompt = batchPrompts[exp.name] || `Edit this image to show the character with a ${exp.name} expression.`;
        await executeImageGeneration(exp.id, exp.name, referenceSrc, prompt);

        // Add a small delay between requests to help avoid rate limits
        if (i < pending.length - 1) {
          await sleep(2000);
        }
      }
    } catch (error: any) {
      console.error('Batch generation failed:', error);
    }

    setIsGenerating(false);
  };

  const downloadZip = async () => {
    const completed = expressions.filter(exp => exp.status === 'done' && exp.dataUrl);
    if (completed.length === 0) return;

    const zip = new JSZip();
    completed.forEach((exp) => {
      const base64Data = exp.dataUrl!.replace(/^data:image\/(png|jpeg);base64,/, '');
      zip.file(`${exp.name}.png`, base64Data, { base64: true });
    });

    const content = await zip.generateAsync({ type: 'blob' });
    saveAs(content, 'avatar_expressions.zip');
  };

  const downloadSpriteSheet = async () => {
    const completed = expressions.filter(exp => exp.status === 'done' && exp.dataUrl);
    if (completed.length === 0) return;

    const images = await Promise.all(completed.map(exp => {
      return new Promise<HTMLImageElement>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.src = exp.dataUrl!;
      });
    }));

    const imgWidth = images[0].width;
    const imgHeight = images[0].height;

    const cols = Math.min(5, images.length);
    const rows = Math.ceil(images.length / cols);

    const canvas = document.createElement('canvas');
    canvas.width = cols * imgWidth;
    canvas.height = rows * imgHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    images.forEach((img, i) => {
      const x = (i % cols) * imgWidth;
      const y = Math.floor(i / cols) * imgHeight;
      ctx.drawImage(img, x, y, imgWidth, imgHeight);
    });

    canvas.toBlob((blob) => {
      if (blob) saveAs(blob, 'avatar_spritesheet.png');
    });
  };

  const downloadSingle = (exp: GeneratedExpression) => {
    if (exp.dataUrl) {
      saveAs(exp.dataUrl, `${exp.name}.png`);
    }
  };

  const completedCount = expressions.filter(e => e.status === 'done').length;
  const pendingCount = expressions.filter(e => e.status === 'idle' || e.status === 'error').length;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="bg-indigo-500 p-2 rounded-lg text-white">
            <Sparkles size={24} />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-800 tracking-tight">Avatar Expression Generator</h1>
            <p className="text-xs text-gray-500">Consistent AI character expressions</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {completedCount > 0 && (
            <>
              <button
                onClick={downloadSpriteSheet}
                className="flex items-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-md transition-colors text-sm font-medium shadow-sm"
                aria-label="Download as sprite sheet"
              >
                <LayoutGrid size={16} />
                Sprite Sheet
              </button>
              <button
                onClick={downloadZip}
                className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-md transition-colors text-sm font-medium shadow-sm"
                aria-label={`Download ${completedCount} expressions as ZIP`}
              >
                <Download size={16} />
                ZIP ({completedCount})
              </button>
            </>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Sidebar Controls */}
        <aside className="w-full lg:w-80 bg-white border-r border-gray-200 p-6 flex flex-col gap-6 overflow-y-auto shrink-0">

          {/* 1. Base Character */}
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">1. Base Character</h2>
            <p className="text-xs text-gray-500">Upload a neutral reference image of your character.</p>

            {imageError && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-xs" role="alert">
                <AlertCircle size={14} />
                <span>{imageError}</span>
              </div>
            )}

            {referenceSrc ? (
              <div className="relative border border-gray-200 rounded-xl p-2 bg-gray-50 flex flex-col items-center gap-3 group">
                <img src={referenceSrc} alt="Reference character face" className="w-full aspect-square object-contain rounded-lg border border-gray-200 bg-white checkerboard-bg" />
                <button
                  onClick={() => { setReferenceSrc(null); setImageError(null); }}
                  className="absolute top-4 right-4 bg-white/90 text-red-500 p-2 rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-50"
                  title="Remove Reference"
                  aria-label="Remove reference image"
                >
                  <Trash2 size={16} />
                </button>
                <div className="flex items-center gap-1 text-xs font-medium text-indigo-600">
                  <CheckCircle2 size={12} />
                  Reference Active
                </div>
              </div>
            ) : (
              <div
                className="border-2 border-dashed border-gray-300 rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-indigo-50 hover:border-indigo-400 transition-all group"
                onClick={() => refInputRef.current?.click()}
                role="button"
                tabIndex={0}
                aria-label="Upload reference image"
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') refInputRef.current?.click(); }}
              >
                <input
                  type="file"
                  ref={refInputRef}
                  onChange={handleReferenceUpload}
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  aria-hidden="true"
                />
                <div className="bg-indigo-100 text-indigo-600 p-4 rounded-full mb-4 group-hover:scale-110 transition-transform">
                  <Upload size={32} />
                </div>
                <p className="text-sm font-medium text-gray-700">Upload Reference</p>
                <p className="text-xs text-gray-400 mt-1">PNG, JPEG, WebP • Max {MAX_IMAGE_SIZE_MB}MB</p>
              </div>
            )}
          </div>

          {/* 2. Expressions Template */}
          <div className={`space-y-4 transition-opacity duration-300 ${!referenceSrc ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">2. Expressions Template</h2>

            <form onSubmit={addExpression} className="flex gap-2">
              <input
                type="text"
                value={newExpressionName}
                onChange={(e) => setNewExpressionName(e.target.value)}
                placeholder="Add custom (e.g. sleepy)"
                className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                maxLength={50}
                aria-label="New expression name"
              />
              <button
                type="submit"
                disabled={!newExpressionName.trim()}
                className="bg-gray-100 text-gray-700 p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50 transition-colors"
                aria-label="Add expression"
              >
                <Plus size={20} />
              </button>
            </form>

            <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto p-1">
              {expressions.map(exp => (
                <div key={exp.id} className="flex items-center gap-1 bg-white border border-gray-200 rounded-full pl-3 pr-1 py-1 text-xs font-medium text-gray-700 shadow-sm">
                  <span>{exp.name}</span>
                  <button
                    onClick={() => removeExpression(exp.id)}
                    className="text-gray-400 hover:text-red-500 p-1 rounded-full hover:bg-gray-100 transition-colors"
                    aria-label={`Remove ${exp.name} expression`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* 3. Generation Settings */}
          <div className={`space-y-4 transition-opacity duration-300 ${!referenceSrc ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
              <SlidersHorizontal size={16} />
              3. Generation Settings
            </h2>

            {/* Budget Mode Toggle */}
            <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wallet size={16} className="text-amber-600" />
                  <span className="text-sm font-semibold text-gray-800">Budget Mode</span>
                </div>
                <button
                  onClick={() => setUseTemplatePrompts(!useTemplatePrompts)}
                  className={`relative w-11 h-6 rounded-full transition-colors ${useTemplatePrompts ? 'bg-green-500' : 'bg-gray-300'}`}
                  role="switch"
                  aria-checked={useTemplatePrompts}
                  aria-label="Toggle AI optimization mode"
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${useTemplatePrompts ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>
              <div className="flex items-start gap-2">
                <Zap size={14} className={`mt-0.5 shrink-0 ${useTemplatePrompts ? 'text-green-600' : 'text-amber-600'}`} />
                <p className="text-xs text-gray-600">
                  {useTemplatePrompts
                    ? 'Using free template prompts — no AI optimization cost. Quality may vary.'
                    : 'Using AI-optimized prompts — better quality, but uses API quota.'}
                </p>
              </div>
            </div>

            {/* Usage Stats */}
            {usage && (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500 font-medium">Daily Images</span>
                  <span className={`font-mono font-bold ${usage.dailyImages.used >= usage.dailyImages.limit ? 'text-red-600' : 'text-gray-700'}`}>
                    {usage.dailyImages.used}/{usage.dailyImages.limit}
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-1.5">
                  <div
                    className={`h-1.5 rounded-full transition-all ${usage.dailyImages.used >= usage.dailyImages.limit ? 'bg-red-500' : 'bg-indigo-500'}`}
                    style={{ width: `${Math.min((usage.dailyImages.used / usage.dailyImages.limit) * 100, 100)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500 font-medium">Session Images</span>
                  <span className="font-mono font-bold text-gray-700">{usage.sessionLimit} max</span>
                </div>
                <p className="text-[10px] text-gray-400">Resets {usage.resetsAt ? new Date(usage.resetsAt).toLocaleTimeString() : 'daily'}</p>
              </div>
            )}

            <div className="space-y-3">
              {/* Scope */}
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1 block">Modification Scope</label>
                <div className="bg-gray-50 p-1 rounded-lg border border-gray-200 flex text-xs font-medium">
                  <button
                    onClick={() => setScope('face_only')}
                    className={`flex-1 py-1.5 px-2 rounded-md transition-all ${
                      scope === 'face_only' ? 'bg-white text-indigo-700 shadow-sm border border-gray-200' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 border border-transparent'
                    }`}
                    aria-pressed={scope === 'face_only'}
                  >
                    Face Only
                  </button>
                  <button
                    onClick={() => setScope('pose_and_props')}
                    className={`flex-1 py-1.5 px-2 rounded-md transition-all ${
                      scope === 'pose_and_props' ? 'bg-white text-indigo-700 shadow-sm border border-gray-200' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 border border-transparent'
                    }`}
                    aria-pressed={scope === 'pose_and_props'}
                  >
                    Pose & Props
                  </button>
                </div>
              </div>

              {/* Intensity */}
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1 block">Intensity</label>
                <div className="bg-gray-50 p-1 rounded-lg border border-gray-200 flex text-xs font-medium">
                  {(['subtle', 'normal', 'exaggerated'] as const).map((level) => (
                    <button
                      key={level}
                      onClick={() => setIntensity(level)}
                      className={`flex-1 py-1.5 px-2 rounded-md capitalize transition-all ${
                        intensity === level
                          ? 'bg-white text-indigo-700 shadow-sm border border-gray-200'
                          : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 border border-transparent'
                      }`}
                      aria-pressed={intensity === level}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom Instructions */}
              <div>
                <label htmlFor="custom-prompt" className="text-xs font-medium text-gray-700 mb-1 block">Custom Instructions (Optional)</label>
                <textarea
                  id="custom-prompt"
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="e.g., 'Make it 3D style', 'Add text bubbles'"
                  className="w-full text-xs border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-none h-16"
                  maxLength={200}
                />
              </div>
            </div>

            {/* Generate Button */}
            <button
              onClick={generateAllPending}
              disabled={!referenceSrc || isGenerating || pendingCount === 0}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2 shadow-sm mt-4"
              aria-label={`Generate ${pendingCount} pending expressions`}
            >
              {isGenerating ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" aria-hidden="true"></div>
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles size={18} />
                  {pendingCount > 0 ? `Generate ${pendingCount} Expression${pendingCount > 1 ? 's' : ''}` : 'All Complete!'}
                </>
              )}
            </button>
          </div>
        </aside>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-gray-100/50 p-6">
          <div className="flex items-center justify-between mb-4 shrink-0">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
              Generated Avatar Sheet ({completedCount}/{expressions.length})
            </h3>
          </div>

          <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-y-auto p-6">
            {!referenceSrc ? (
              <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
                <UserCircle size={64} className="opacity-20" aria-hidden="true" />
                <p className="text-base font-medium text-gray-500">Upload a reference character to begin</p>
                <p className="text-sm text-gray-400 max-w-md text-center">
                  The AI will use your reference image to generate a consistent set of facial expressions based on the template.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6">
                {expressions.map((exp) => (
                  <div key={exp.id} className="flex flex-col gap-2">
                    <div className="relative aspect-square bg-gray-50 rounded-xl border border-gray-200 flex items-center justify-center checkerboard-bg overflow-hidden group">
                      {exp.status === 'done' && exp.dataUrl ? (
                        <>
                          <img src={exp.dataUrl} alt={`Character with ${exp.name} expression`} className="max-w-full max-h-full object-contain" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                            <button
                              onClick={() => generateSingleExpression(exp.id, exp.name, referenceSrc, intensity, scope, customPrompt)}
                              className="bg-white text-indigo-600 p-2 rounded-full hover:bg-indigo-50 hover:scale-110 transition-all shadow-lg"
                              title="Regenerate"
                              aria-label={`Regenerate ${exp.name} expression`}
                            >
                              <Sparkles size={16} />
                            </button>
                            <button
                              onClick={() => downloadSingle(exp)}
                              className="bg-white text-gray-700 p-2 rounded-full hover:bg-gray-50 hover:scale-110 transition-all shadow-lg"
                              title="Download Image"
                              aria-label={`Download ${exp.name} expression`}
                            >
                              <DownloadCloud size={16} />
                            </button>
                          </div>
                        </>
                      ) : exp.status === 'generating' ? (
                        <div className="flex flex-col items-center gap-3 text-indigo-500 p-4 text-center">
                          <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-500 rounded-full animate-spin" aria-hidden="true"></div>
                          <span className="text-xs font-medium animate-pulse">{exp.progressMessage || 'Generating...'}</span>
                        </div>
                      ) : exp.status === 'error' ? (
                        <div className="flex flex-col items-center gap-2 text-red-500 p-4 text-center">
                          <AlertCircle size={24} aria-hidden="true" />
                          <span className="text-[10px] leading-tight">{exp.errorMessage || 'Failed'}</span>
                          <button
                            onClick={() => generateSingleExpression(exp.id, exp.name, referenceSrc, intensity, scope, customPrompt)}
                            className="mt-1 text-xs bg-red-100 hover:bg-red-200 text-red-700 px-2 py-1 rounded transition-colors"
                            aria-label={`Retry ${exp.name} expression`}
                          >
                            Retry
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-gray-400 opacity-50">
                          <ImageIcon size={32} aria-hidden="true" />
                          <span className="text-xs font-medium">Pending</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-center">
                      <span className="text-xs font-mono font-medium text-gray-600 bg-gray-100 px-2 py-1 rounded-md border border-gray-200">
                        {exp.name}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
