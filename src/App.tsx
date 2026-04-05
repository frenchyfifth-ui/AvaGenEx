import React, { useState, useRef } from 'react';
import { Upload, Download, Trash2, Image as ImageIcon, Sparkles, UserCircle, CheckCircle2, AlertCircle, Plus, X, SlidersHorizontal, LayoutGrid, DownloadCloud } from 'lucide-react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { GoogleGenAI, Type } from '@google/genai';

const DEFAULT_EXPRESSIONS = [
  'happy', 'sad', 'angry', 'surprised', 
  'laughing', 'crying', 'thinking', 'winking', 
  'scared', 'confused', 'smug', 'shocked'
];

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

export default function App() {
  const [referenceSrc, setReferenceSrc] = useState<string | null>(null);
  const [expressions, setExpressions] = useState<GeneratedExpression[]>(
    DEFAULT_EXPRESSIONS.map(name => ({ id: crypto.randomUUID(), name, status: 'idle' }))
  );
  const [newExpressionName, setNewExpressionName] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  
  // Settings
  const [intensity, setIntensity] = useState<Intensity>('normal');
  const [scope, setScope] = useState<GenerationScope>('face_only');
  const [customPrompt, setCustomPrompt] = useState('');
  
  const refInputRef = useRef<HTMLInputElement>(null);

  const handleReferenceUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setReferenceSrc(event.target?.result as string);
        // Reset all expressions to idle when a new reference is uploaded
        setExpressions(prev => prev.map(exp => ({ ...exp, status: 'idle', dataUrl: undefined, errorMessage: undefined, progressMessage: undefined })));
      };
      reader.readAsDataURL(file);
    }
  };

  const addExpression = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newExpressionName.trim().toLowerCase().replace(/\s+/g, '_');
    if (trimmed && !expressions.some(exp => exp.name === trimmed)) {
      setExpressions(prev => [...prev, { id: crypto.randomUUID(), name: trimmed, status: 'idle' }]);
      setNewExpressionName('');
    }
  };

  const removeExpression = (id: string) => {
    setExpressions(prev => prev.filter(exp => exp.id !== id));
  };

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const generateWithRetry = async (apiCall: () => Promise<any>, maxRetries = 3) => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await apiCall();
      } catch (error: any) {
        const isRateLimit = error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('quota');
        if (isRateLimit && i < maxRetries - 1) {
          const delay = Math.pow(2, i) * 3000; // 3s, 6s, 12s
          console.log(`Rate limited. Retrying in ${delay}ms...`);
          await sleep(delay);
        } else {
          throw error;
        }
      }
    }
  };

  const optimizeSinglePrompt = async (name: string, currentIntensity: Intensity, currentScope: GenerationScope, customInstructions: string) => {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const enhancerPrompt = `You are an expert prompt engineer for an image-to-image AI model.
Your task is to write a highly optimized prompt to edit a reference image of a character.

Target Expression/Action: "${name}"
Modification Scope: ${currentScope === 'face_only' ? 'Modify ONLY the facial features. The body, pose, and clothing MUST remain exactly the same.' : 'Modify the facial features, and ALSO change the body language, hand gestures, and add relevant props (like tears, sweat drops, hearts, etc.) to match the emotion.'}
Intensity: ${currentIntensity === 'subtle' ? 'Subtle and natural.' : currentIntensity === 'exaggerated' ? 'Highly exaggerated, cartoonish, and dynamic.' : 'Clear and distinct.'}
Additional Instructions: ${customInstructions || 'None'}

Write ONLY the final prompt. The prompt MUST start with "Edit this image to ". Keep it under 3 sentences.`;

    const textResponse = await generateWithRetry(() => ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview',
      contents: enhancerPrompt,
    }));
    
    return textResponse.text?.trim() || `Edit this image to show the character with a ${name} expression.`;
  };

  const executeImageGeneration = async (id: string, name: string, refImage: string, optimizedPrompt: string) => {
    setExpressions(prev => prev.map(exp => exp.id === id ? { ...exp, progressMessage: 'Rendering image...' } : exp));
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const mimeType = refImage.split(';')[0].split(':')[1];
      const base64Data = refImage.split(',')[1];

      const response = await generateWithRetry(() => ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            { inlineData: { data: base64Data, mimeType: mimeType } },
            { text: optimizedPrompt },
          ],
        },
      }));

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
        setExpressions(prev => prev.map(exp => exp.id === id ? { ...exp, status: 'done', dataUrl: imageUrl } : exp));
      } else {
        throw new Error("No image data returned from AI.");
      }
    } catch (error: any) {
      console.error(`Error generating ${name}:`, error);
      setExpressions(prev => prev.map(exp => exp.id === id ? { ...exp, status: 'error', errorMessage: error.message || "Failed to generate" } : exp));
    }
  };

  const generateSingleExpression = async (id: string, name: string, refImage: string, currentIntensity: Intensity, currentScope: GenerationScope, customInstructions: string) => {
    setExpressions(prev => prev.map(exp => exp.id === id ? { ...exp, status: 'generating', progressMessage: 'Optimizing prompt...', errorMessage: undefined } : exp));
    try {
      const optimizedPrompt = await optimizeSinglePrompt(name, currentIntensity, currentScope, customInstructions);
      await executeImageGeneration(id, name, refImage, optimizedPrompt);
    } catch (error: any) {
      setExpressions(prev => prev.map(exp => exp.id === id ? { ...exp, status: 'error', errorMessage: error.message || "Failed to generate" } : exp));
    }
  };

  const optimizeBatchPrompts = async (names: string[], currentIntensity: Intensity, currentScope: GenerationScope, customInstructions: string) => {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const enhancerPrompt = `You are an expert prompt engineer for an image-to-image AI model.
Write highly optimized prompts to edit a reference image of a character for the following expressions/actions: ${names.join(', ')}.

Modification Scope: ${currentScope === 'face_only' ? 'Modify ONLY the facial features. The body, pose, and clothing MUST remain exactly the same.' : 'Modify the facial features, and ALSO change the body language, hand gestures, and add relevant props to match the emotion.'}
Intensity: ${currentIntensity === 'subtle' ? 'Subtle and natural.' : currentIntensity === 'exaggerated' ? 'Highly exaggerated, cartoonish, and dynamic.' : 'Clear and distinct.'}
Additional Instructions: ${customInstructions || 'None'}

For each expression, write a prompt starting with "Edit this image to ". Keep each prompt under 3 sentences.`;

    const textResponse = await generateWithRetry(() => ai.models.generateContent({
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
    }));

    try {
      const parsed = JSON.parse(textResponse.text?.trim() || "[]");
      const result: Record<string, string> = {};
      if (Array.isArray(parsed)) {
        parsed.forEach((p: any) => { result[p.name] = p.prompt; });
      }
      return result;
    } catch (e) {
      console.error("Failed to parse batch prompts", e);
      return {};
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

    // Batch optimize
    const names = pending.map(e => e.name);
    const batchPrompts = await optimizeBatchPrompts(names, intensity, scope, customPrompt);
    
    // Process sequentially to avoid rate limits and ensure stability
    for (let i = 0; i < pending.length; i++) {
      const exp = pending[i];
      const prompt = batchPrompts[exp.name] || `Edit this image to show the character with a ${exp.name} expression.`;
      await executeImageGeneration(exp.id, exp.name, referenceSrc, prompt);
      
      // Add a small delay between requests to help avoid rate limits
      if (i < pending.length - 1) {
        await sleep(2000);
      }
    }
    
    setIsGenerating(false);
  };

  const downloadZip = async () => {
    const completed = expressions.filter(exp => exp.status === 'done' && exp.dataUrl);
    if (completed.length === 0) return;
    
    const zip = new JSZip();
    completed.forEach((exp) => {
      const base64Data = exp.dataUrl!.replace(/^data:image\/(png|jpeg);base64,/, "");
      zip.file(`${exp.name}.png`, base64Data, {base64: true});
    });
    
    const content = await zip.generateAsync({type: "blob"});
    saveAs(content, "avatar_expressions.zip");
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
      if (blob) saveAs(blob, "avatar_spritesheet.png");
    });
  };

  const downloadSingle = (exp: GeneratedExpression) => {
    if (exp.dataUrl) {
      saveAs(exp.dataUrl, `${exp.name}.png`);
    }
  };

  const completedCount = expressions.filter(e => e.status === 'done').length;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans flex flex-col">
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
              >
                <LayoutGrid size={16} />
                Sprite Sheet
              </button>
              <button
                onClick={downloadZip}
                className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-md transition-colors text-sm font-medium shadow-sm"
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
          
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">1. Base Character</h2>
            <p className="text-xs text-gray-500">Upload a neutral reference image of your character.</p>
            
            {referenceSrc ? (
              <div className="relative border border-gray-200 rounded-xl p-2 bg-gray-50 flex flex-col items-center gap-3 group">
                <img src={referenceSrc} alt="Reference" className="w-full aspect-square object-contain rounded-lg border border-gray-200 bg-white checkerboard-bg" />
                <button 
                  onClick={() => setReferenceSrc(null)} 
                  className="absolute top-4 right-4 bg-white/90 text-red-500 p-2 rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-50"
                  title="Remove Reference"
                >
                  <Trash2 size={16} />
                </button>
                <p className="text-xs font-medium text-indigo-600 w-full text-center pb-1">Reference Active</p>
              </div>
            ) : (
              <div 
                className="border-2 border-dashed border-gray-300 rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-indigo-50 hover:border-indigo-400 transition-all group"
                onClick={() => refInputRef.current?.click()}
              >
                <input 
                  type="file" 
                  ref={refInputRef} 
                  onChange={handleReferenceUpload} 
                  accept="image/*" 
                  className="hidden" 
                />
                <div className="bg-indigo-100 text-indigo-600 p-4 rounded-full mb-4 group-hover:scale-110 transition-transform">
                  <UserCircle size={32} />
                </div>
                <p className="text-sm font-medium text-gray-700">Upload Reference</p>
                <p className="text-xs text-gray-400 mt-1">Clear, neutral face works best</p>
              </div>
            )}
          </div>

          <div className={`space-y-4 transition-opacity duration-300 ${!referenceSrc ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">2. Expressions Template</h2>
            
            <form onSubmit={addExpression} className="flex gap-2">
              <input 
                type="text" 
                value={newExpressionName}
                onChange={(e) => setNewExpressionName(e.target.value)}
                placeholder="Add custom (e.g. sleepy)"
                className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
              <button 
                type="submit"
                disabled={!newExpressionName.trim()}
                className="bg-gray-100 text-gray-700 p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50 transition-colors"
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
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className={`space-y-4 transition-opacity duration-300 ${!referenceSrc ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
              <SlidersHorizontal size={16} />
              3. Generation Settings
            </h2>
            
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1 block">Modification Scope</label>
                <div className="bg-gray-50 p-1 rounded-lg border border-gray-200 flex text-xs font-medium">
                  <button
                    onClick={() => setScope('face_only')}
                    className={`flex-1 py-1.5 px-2 rounded-md transition-all ${
                      scope === 'face_only' ? 'bg-white text-indigo-700 shadow-sm border border-gray-200' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 border border-transparent'
                    }`}
                  >
                    Face Only
                  </button>
                  <button
                    onClick={() => setScope('pose_and_props')}
                    className={`flex-1 py-1.5 px-2 rounded-md transition-all ${
                      scope === 'pose_and_props' ? 'bg-white text-indigo-700 shadow-sm border border-gray-200' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 border border-transparent'
                    }`}
                  >
                    Pose & Props
                  </button>
                </div>
              </div>

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
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-700 mb-1 block">Custom Instructions (Optional)</label>
                <textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="e.g., 'Make it 3D style', 'Add text bubbles'"
                  className="w-full text-xs border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-none h-16"
                />
              </div>
            </div>

            <button
              onClick={generateAllPending}
              disabled={!referenceSrc || isGenerating || expressions.filter(e => e.status === 'idle' || e.status === 'error').length === 0}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2 shadow-sm mt-4"
            >
              {isGenerating ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles size={18} />
                  Generate Missing Expressions
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
                <UserCircle size={64} className="opacity-20" />
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
                          <img src={exp.dataUrl} alt={exp.name} className="max-w-full max-h-full object-contain" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                            <button 
                              onClick={() => generateSingleExpression(exp.id, exp.name, referenceSrc, intensity, scope, customPrompt)}
                              className="bg-white text-indigo-600 p-2 rounded-full hover:bg-indigo-50 hover:scale-110 transition-all shadow-lg"
                              title="Regenerate"
                            >
                              <Sparkles size={16} />
                            </button>
                            <button 
                              onClick={() => downloadSingle(exp)}
                              className="bg-white text-gray-700 p-2 rounded-full hover:bg-gray-50 hover:scale-110 transition-all shadow-lg"
                              title="Download Image"
                            >
                              <DownloadCloud size={16} />
                            </button>
                          </div>
                        </>
                      ) : exp.status === 'generating' ? (
                        <div className="flex flex-col items-center gap-3 text-indigo-500">
                          <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-500 rounded-full animate-spin"></div>
                          <span className="text-xs font-medium animate-pulse text-center px-2">{exp.progressMessage || 'Generating...'}</span>
                        </div>
                      ) : exp.status === 'error' ? (
                        <div className="flex flex-col items-center gap-2 text-red-500 p-4 text-center">
                          <AlertCircle size={24} />
                          <span className="text-[10px] leading-tight">{exp.errorMessage || 'Failed'}</span>
                          <button 
                            onClick={() => generateSingleExpression(exp.id, exp.name, referenceSrc, intensity, scope, customPrompt)}
                            className="mt-1 text-xs bg-red-100 hover:bg-red-200 text-red-700 px-2 py-1 rounded transition-colors"
                          >
                            Retry
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-gray-400 opacity-50">
                          <ImageIcon size={32} />
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
      <style dangerouslySetInnerHTML={{__html: `
        .checkerboard-bg {
          background-image: 
            linear-gradient(45deg, #f0f0f0 25%, transparent 25%), 
            linear-gradient(-45deg, #f0f0f0 25%, transparent 25%), 
            linear-gradient(45deg, transparent 75%, #f0f0f0 75%), 
            linear-gradient(-45deg, transparent 75%, #f0f0f0 75%);
          background-size: 20px 20px;
          background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
        }
      `}} />
    </div>
  );
}
