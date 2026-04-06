<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Avatar Expression Generator (AvaGenEx)

Generate consistent AI-powered facial expressions for your character from a single reference image.

## Features

- 🎨 **Single Reference Upload** — Upload one neutral character image; AI generates all expressions
- 🤖 **AI-Optimized Prompts** — Gemini AI intelligently crafts detailed image generation prompts
- ⚙️ **Customizable Settings** — Control scope (face only / pose & props), intensity, and custom instructions
- 📦 **Export Options** — Download as ZIP or sprite sheet
- 🔒 **Secure Backend** — API keys never touch the browser
- ✅ **Input Validation** — Image size limits, client-side resizing, prompt sanitization

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Tailwind CSS 4 |
| Build Tool | Vite 6 |
| Backend | Express.js with TypeScript (tsx) |
| AI | Google Gemini (`gemini-2.5-flash-image`, `gemini-3.1-flash-lite-preview`) |
| Utilities | JSZip, FileSaver, Lucide React icons |

## Prerequisites

- Node.js 18+
- A [Gemini API key](https://aistudio.google.com/app/apikey)

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and add your Gemini API key:
   ```
   GEMINI_API_KEY=your_actual_api_key_here
   ```

3. **Run the app:**
   ```bash
   npm run dev
   ```
   This starts both the frontend (port 3000) and backend (port 3001) simultaneously.

4. **Open your browser:** Navigate to `http://localhost:3000`

## How to Use

### Step-by-Step Workflow

**1. Upload a Reference Character**
- Click the upload area in the left sidebar
- Select a clear, neutral-facing image of your character (PNG, JPEG, or WebP, max 5MB)
- The image will be automatically resized if it's too large

**2. Choose Expressions**
- 12 default expressions are pre-loaded: `happy`, `sad`, `angry`, `surprised`, `laughing`, `crying`, `thinking`, `winking`, `scared`, `confused`, `smug`, `shocked`
- Add custom expressions by typing a name and clicking **+** (e.g. `sleepy`, `excited`)
- Remove unwanted expressions by clicking the **×** on each tag

**3. Configure Generation Settings**
| Setting | Options | Description |
|---------|---------|-------------|
| **Scope** | Face Only / Pose & Props | Face Only keeps pose/body unchanged. Pose & Props allows body language and props (tears, hearts, etc.) |
| **Intensity** | Subtle / Normal / Exaggerated | Controls how strong the expression appears |
| **Custom Instructions** | Free text (200 chars) | Optional: add style notes like "3D render style" or "add sweat drops" |

**4. Generate**
- Click **Generate Missing Expressions** to process all pending expressions at once
- The AI first optimizes prompts, then generates each image one-by-one
- A 2-second delay between generations prevents rate limiting
- Failed expressions show a **Retry** button

**5. Export**
| Button | Output |
|--------|--------|
| **Sprite Sheet** | Single PNG with all expressions in a grid |
| **ZIP (N)** | ZIP file containing all individual expression PNGs |
| **Individual Download** | Hover over any completed expression and click the download icon |

**6. Regenerate**
- Hover over any completed expression and click the **✨** icon to regenerate it with current settings
- This is useful if you want to tweak a specific expression without re-running everything

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start both frontend and backend (development) |
| `npm run dev:client` | Start frontend only (port 3000) |
| `npm run dev:server` | Start backend only (port 3001) |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm start` | Run backend server in production |
| `npm run lint` | Run TypeScript type checking |
| `npm run clean` | Remove build artifacts |

## Project Structure

```
├── server/
│   └── index.ts          # Express backend (API proxy for Gemini)
├── src/
│   ├── App.tsx           # Main application component
│   ├── ErrorBoundary.tsx # React error boundary
│   ├── main.tsx          # Entry point
│   └── index.css         # Global styles
├── index.html
├── vite.config.ts        # Vite configuration (includes API proxy)
├── tsconfig.json
└── package.json
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/optimize-prompt` | POST | Optimize a single expression prompt |
| `/api/optimize-batch-prompts` | POST | Optimize prompts for multiple expressions |
| `/api/generate-image` | POST | Generate image from reference + prompt |
| `/api/health` | GET | Health check |

## Security

- **API keys are server-side only** — The Gemini API key never leaves the backend
- **Input sanitization** — All user inputs are sanitized to prevent prompt injection
- **Image validation** — File type and size validation before upload
- **Client-side resize** — Images are resized before transmission to reduce costs
- **Rate limiting** — 30 requests per minute per IP to prevent abuse
- **Security headers** — XSS protection, frame denial, content-type sniffing prevention

## Deploy to Production

### Option 1: Render (Easiest — Free Tier)

1. Push your repo to GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Select your repo
4. Set the environment variable:
   - `GEMINI_API_KEY` = your Gemini API key
5. Click **Deploy**

Render will auto-detect the `render.yaml` config and handle everything.

### Option 2: Railway (Free Trial)

1. Push your repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select your repo
4. Add environment variable:
   - `GEMINI_API_KEY` = your Gemini API key
5. Railway auto-detects Node.js and runs `npm run build` + `npm start`

### Option 3: Fly.io (Free Allowance)

1. Install [flyctl](https://fly.io/docs/hands-on/install-flyctl/)
2. Run:
   ```bash
   fly launch
   ```
3. Set your API key:
   ```bash
   fly secrets set GEMINI_API_KEY=your_key_here
   ```
4. Deploy:
   ```bash
   fly deploy
   ```

### Option 4: Docker (Anywhere)

```bash
# Build
docker build -t avagenex .

# Run
docker run -d -p 3000:3000 --env GEMINI_API_KEY=your_key_here avagenex
```

Or with Docker Compose:
```bash
# Set GEMINI_API_KEY in your .env file
docker-compose up -d
```

### Option 5: Self-Hosted VPS

```bash
# On your server:
git clone <your-repo>
cd AvaGenEx
npm install
npm run build
GEMINI_API_KEY=your_key_here npm start
```

Use PM2 to keep it running:
```bash
pm2 start "NODE_ENV=production npx tsx server/index.ts" --name avagenex
pm2 save
pm2 startup
```

## License

MIT
