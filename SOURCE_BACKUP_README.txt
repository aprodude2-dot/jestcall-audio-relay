# Zilos Tools — partial source backup (2026-10-08)

This archive includes 9 source files recovered intact from the live Vercel deployment.
It is NOT a complete deployable project. Eight serverless API files remain missing because the source-read service truncated those files.

MISSING FILES:
- api/audio-config.js
- api/call.js
- api/end-call.js
- api/guide.js
- api/numbers.js
- api/relay-end.js
- api/swml.js
- api/transcript.js

Do NOT overwrite or redeploy the working Vercel website using this partial archive.
Do NOT replace the GitHub main branch with this archive until all missing backend files are recovered. An incomplete deployment will break outbound calling.

The files index.html and relay-runtime.js reflect the live website and AI conversation behavior on 2026-10-08.
Private service credentials should remain in provider environment settings rather than GitHub.
