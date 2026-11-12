# NBL Helper Bots (Coach · Matchmaker · Ref)

Files: `bots.js`, `bots.css` (referenced from `index.html` with one `<link>` and one `<script>`).

- **Coach Flex** 🏀 — drills, skill tips, workout plans (uses the signed-in profile's position + skill).
- **Matchmaker** 🤝 — finds open runs from the Live Matching board, explains matching, buttons jump to Live Matching / parks near me / log in.
- **The Ref** 🦓 — answers from the NBL Pickup Standards text read straight from the Rules section.

## Turning on the AI (Firebase AI Logic, Gemini Developer API)
Until this is done the bots run in "Playbook mode" (scripted answers) — nothing breaks.

1. Open https://console.firebase.google.com/project/nbl-basketball/ailogic/ → **Get started**.
2. Choose **Gemini Developer API** (free tier, no billing needed on Spark). Finish the workflow.
3. The workflow enforces **App Check** for AI Logic. Register the web app with App Check:
   - Create a reCAPTCHA v3 site key (https://www.google.com/recaptcha/admin) for your domain(s) (e.g. `vontamr.github.io`).
   - Firebase console → Security → App Check → Apps → your web app → reCAPTCHA → paste the **secret** key.
   - Put the **site** key in the page before `bots.js`:
     ```html
     <script>window.NBL_BOTS_CONFIG = { appCheckSiteKey: 'YOUR_SITE_KEY' };</script>
     ```
   - For localhost testing add `appCheckDebug: true`, open DevTools, copy the printed debug token, and add it under App Check → Apps → ⋮ → Manage debug tokens.
4. Reload. The footer of the chat switches from "Playbook mode" to "AI on".

Options in `window.NBL_BOTS_CONFIG`: `ai` (false = scripted only), `model` (default `gemini-3.8-flash`), `appCheckProvider` (`'v3'` or `'enterprise'`).
Chat history lives in memory only (per bot, per page load); nothing is written to Firestore.
