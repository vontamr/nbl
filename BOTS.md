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

# NBL Map Bots (Spark · Connector · Scout · Host)

Files: `mapbots.js`, `mapbots.css` (one extra `<link>` and `<script>` in `index.html`).

These are official **NBL Bots** that appear as clearly labeled markers on the court map. They are not player accounts, they never show a human name without an "NBL Bot" badge, and they are never added to a run roster.

- **Spark** — hypes the visitor to start a run at the nearby park.
- **Connector** — points people at Live Matching to land a game with real players.
- **Scout** — adds live open-meteo weather for that court when the popup opens.
- **Host** — points people at the park card / local board so they can invite real players.

Placement: if the site already has the visitor's location, the four bots sit just off the nearest parks (spread at least ~1.2 km apart). Otherwise they start at Lake Eola and Cypress Grove (Orlando) plus Hermann Park (Houston) and Reverchon Park (Dallas).

Popup buttons call existing site functions only: `switchTab('compete')` (and pre-select the park for "Start a run here"), `fillNearestCourts`, `openParkCard`, `showAuthModal`, and `NBLBots.open('matchmaker')`. Nothing is written to Firestore.

Player or run counts appear only when the page already loaded that data. If the board is empty or Firestore reads failed, the copy stays generic ("No run listed yet", "The board looks quiet") — never a made-up number or a fake name.
