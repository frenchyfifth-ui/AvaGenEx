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

## License

MIT
