# Contributing to Crisp

Crisp is maintained by Alpha AI.

If you want to contribute, extend the editor, improve transcription/rendering
quality, or discuss a larger collaboration, contact:

corporate@alphaai.biz

## Contribution Guidelines

- Do not commit API keys or credentials.
- Do not commit private audio, video, transcript, upload, proxy, or export data.
- Keep the product non-destructive: originals must not be modified during edit
  preview or rendering.
- The editor must not automatically remove speech without explicit user
  confirmation.
- Prefer provider-neutral transcription data structures so Groq/local Whisper
  changes do not leak into the UI.

## Development

```bash
npm install
npm run dev
npm run build
```

