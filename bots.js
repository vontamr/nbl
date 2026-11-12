/* ═══════════════════════════════════════════════════════════
   NBL Helper Bots — Coach · Matchmaker · Ref
   ───────────────────────────────────────────────────────────
   Self-contained add-on. Loaded after the main site script.
   - UI: floating launcher + chat panel (styles in bots.css)
   - Brain: Firebase AI Logic (Gemini Developer API) loaded on demand
     from gstatic as ES modules, using the site's existing FIREBASE_CONFIG.
     No extra API key is shipped.
   - Fallback: if AI Logic is not enabled / blocked / offline, each bot
     answers from a built-in scripted playbook + the site's own content.
   Nothing in here modifies existing site functions; it only *calls*
   them (switchTab, showAuthModal, …) when they exist.
   ═══════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (window.__nblBotsLoaded) return;
    window.__nblBotsLoaded = true;

    // ── Settings (override by defining window.NBL_BOTS_CONFIG before this file) ──
    var CFG = Object.assign({
        ai: true,                         // set false to force scripted mode
        model: 'gemini-3.8-flash',        // fast Gemini model per Firebase AI Logic docs
        sdkVersion: '13.3.0',             // modular Firebase JS SDK used only for AI Logic
        appCheckSiteKey: '',              // reCAPTCHA site key for App Check (needed once App Check is enforced for AI Logic)
        appCheckProvider: 'v3',           // 'v3' (reCAPTCHA v3, free) or 'enterprise' (reCAPTCHA Enterprise)
        appCheckDebug: false,             // true on localhost to print an App Check debug token
        requestTimeoutMs: 20000,
        retryAfterMs: 5 * 60 * 1000       // after an AI failure, retry AI this long later
    }, window.NBL_BOTS_CONFIG || {});

    // ── Safe access to the site's globals (declared with let/const in index.html) ──
    function g(name) {
        try {
            switch (name) {
                case 'config': return (typeof FIREBASE_CONFIG !== 'undefined') ? FIREBASE_CONFIG : null;
                case 'user': return (typeof currentUser !== 'undefined') ? currentUser : null;
                case 'runs': return (typeof liveRuns !== 'undefined' && Array.isArray(liveRuns)) ? liveRuns : [];
                case 'players': return (typeof players !== 'undefined' && Array.isArray(players)) ? players : [];
                case 'courts': return (typeof ALL_COURTS !== 'undefined' && Array.isArray(ALL_COURTS)) ? ALL_COURTS : [];
                case 'signedIn': return !!(typeof auth !== 'undefined' && auth && auth.currentUser);
            }
        } catch (e) {}
        return null;
    }
    function callSite(fnName) {
        var args = Array.prototype.slice.call(arguments, 1);
        try {
            var fn = window[fnName];
            if (typeof fn === 'function') { fn.apply(window, args); return true; }
        } catch (e) { console.warn('[NBL bots] could not call', fnName, e); }
        return false;
    }

    // ── Site content (read from the page so the bots stay in sync with it) ──
    var FALLBACK_RULES = {
        pickup: [
            'Games are 5v5 full court (or 3v3 half court by agreement)',
            'Win by 2 or first to 21 (your call at tip-off)',
            'Check ball at the top of the key. No cherry picking.',
            '3-second violation strictly enforced on offense',
            'Call your own fouls. Respect the game.'
        ],
        matching: [
            'Teams are auto-balanced by skill level (avg difference < 0.8)',
            'Position diversity prioritized (no more than 2 of same position per team when possible)',
            'Proximity + availability taken into account for court suggestion',
            'Skill range capped: highest and lowest on same team differ by max 3 points',
            'Re-roll anytime. AI learns from accepted matches over time.'
        ],
        conduct: [
            'Respect every baller on and off the court',
            'No trash talk that crosses into disrespect',
            'Show up or cancel early — your rep matters',
            'Winners buy the next round of Gatorade',
            'Celebrate buckets, not egos',
            'New players get grace. We all started somewhere.'
        ]
    };
    var _rulesCache = null;
    function siteRules() {
        if (_rulesCache) return _rulesCache;
        var out = { pickup: [], matching: [], conduct: [] };
        try {
            var sec = document.getElementById('section-rules');
            if (sec) {
                var lists = sec.querySelectorAll('ul');
                var grab = function (ul) {
                    return Array.prototype.map.call(ul.querySelectorAll('li'), function (li) {
                        var spans = li.querySelectorAll('span');
                        var el = spans.length > 1 ? spans[spans.length - 1] : li;
                        return (el.textContent || '').replace(/\s+/g, ' ').trim();
                    }).filter(Boolean);
                };
                if (lists[0]) out.pickup = grab(lists[0]);
                if (lists[1]) out.matching = grab(lists[1]);
                var conduct = sec.querySelectorAll('.grid.grid-cols-1 > div');
                out.conduct = Array.prototype.map.call(conduct, function (d) {
                    return (d.textContent || '').replace(/^[\s•]+/, '').replace(/\s+/g, ' ').trim();
                }).filter(Boolean);
            }
        } catch (e) {}
        if (!out.pickup.length) out.pickup = FALLBACK_RULES.pickup;
        if (!out.matching.length) out.matching = FALLBACK_RULES.matching;
        if (!out.conduct.length) out.conduct = FALLBACK_RULES.conduct;
        _rulesCache = out;
        return out;
    }
    function rulesAsText() {
        var r = siteRules();
        var num = function (arr) { return arr.map(function (t, i) { return (i + 1 < 10 ? '0' : '') + (i + 1) + '. ' + t; }).join('\n'); };
        return 'STANDARD PICKUP RULES\n' + num(r.pickup) +
            '\n\nAUTOMATED MATCHING PROTOCOL\n' + num(r.matching) +
            '\n\nCODE OF CONDUCT\n' + r.conduct.map(function (t) { return '• ' + t; }).join('\n');
    }

    var POS_NAMES = { PG: 'point guard', SG: 'shooting guard', SF: 'small forward', PF: 'power forward', C: 'center' };
    function profile() {
        var u = g('user');
        if (!u) return null;
        var pos = String(u.position || '').toUpperCase();
        var skill = parseInt(u.skill, 10);
        return {
            name: (u.name && u.name !== 'Baller') ? String(u.name).split(' ')[0] : '',
            position: POS_NAMES[pos] ? pos : '',
            skill: isNaN(skill) ? null : skill,
            hometown: u.hometown || ''
        };
    }
    function profileText() {
        var p = profile();
        if (!p) return 'The user is not signed in (no NBL profile).';
        return 'Signed-in user: ' + (p.name || 'a baller') +
            (p.position ? ', position ' + p.position + ' (' + POS_NAMES[p.position] + ')' : '') +
            (p.skill != null ? ', self-rated skill ' + p.skill + '/10' : '') +
            (p.hometown ? ', from ' + p.hometown : '') + '.';
    }
    function openRuns() {
        return g('runs').filter(function (r) { return r && r.status === 'open'; });
    }
    function runsText() {
        var open = openRuns();
        if (!open.length) return 'There are currently no open runs on the Live Matching board.';
        return 'Open runs right now:\n' + open.slice(0, 8).map(function (r) {
            var need = r.need || parseInt(r.format, 10) || 10;
            var have = (r.playerUids || []).length;
            return '- ' + (r.courtName || 'Park') + ' (' + [r.area, r.state].filter(Boolean).join(', ') + '), ' +
                (r.when || 'Now') + ', ' + (need === 6 ? '3v3' : '5v5') + ', ' + have + '/' + need + ' players';
        }).join('\n');
    }

    // ── Actions bots can offer as buttons ──
    var ACTIONS = {
        compete: { label: 'Open Live Matching', run: function () { goSection('compete'); } },
        nearme: { label: 'Parks near me', run: function () { goSection('compete'); callSite('fillNearestCourts'); } },
        rules: { label: 'Read the rules', run: function () { goSection('rules'); } },
        profiles: { label: 'Browse players', run: function () { goSection('profiles'); } },
        login: { label: 'Log in', run: function () { callSite('showAuthModal', 'login'); } },
        signup: { label: 'Join NBL', run: function () { callSite('showAuthModal', 'signup'); } },
        map: { label: 'Court map', run: function () { goSection('map'); } }
    };
    function goSection(tab) {
        callSite('switchTab', tab);
        setTimeout(function () {
            var el = document.getElementById('section-' + tab);
            if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            if (tab === 'compete') {
                var sel = document.getElementById('match-court-select');
                if (sel) { sel.style.transition = 'box-shadow .3s'; sel.style.boxShadow = '0 0 0 2px #FF10F0'; setTimeout(function () { sel.style.boxShadow = ''; }, 1600); }
            }
        }, 60);
        if (window.innerWidth < 768) closePanel();
    }

    // ── Bots ──
    var BOTS = {
        coach: {
            id: 'coach', name: 'Coach Flex', short: 'Coach', emoji: '🏀',
            tagline: 'Drills, skill tips & workout plans',
            greeting: function () {
                var p = profile();
                if (p && p.position) return 'What\'s good' + (p.name ? ', ' + p.name : '') + '! I see you run **' + p.position + '**' + (p.skill != null ? ' at a ' + p.skill + '/10' : '') + '. Want a workout built for that, or a specific skill to sharpen?';
                return 'What\'s good! I\'m Coach Flex. Tell me your position and what you want to sharpen — shooting, handles, defense, conditioning — and I\'ll set you up.';
            },
            chips: ['Build my workout plan', 'Shooting drills', 'Tighten my handles', 'Lock-down defense']
        },
        matchmaker: {
            id: 'matchmaker', name: 'Matchmaker', short: 'Match', emoji: '🤝',
            tagline: 'Find or start a pickup run',
            greeting: function () {
                var n = openRuns().length;
                return 'I\'m the Matchmaker. ' + (n ? 'There ' + (n === 1 ? 'is **1 open run**' : 'are **' + n + ' open runs**') + ' on the board right now. ' : '') + 'I can find you a run, help you start one, or explain how teams get balanced.';
            },
            chips: ['Find a run near me', 'How do I start a run?', 'How are teams balanced?', '3v3 or 5v5?']
        },
        ref: {
            id: 'ref', name: 'The Ref', short: 'Ref', emoji: '🦓',
            tagline: 'NBL Pickup Standards, called straight',
            greeting: function () {
                return 'Ref here. Ask me anything about the **NBL Pickup Standards** — scoring, checking ball, fouls, the 3-second rule, or how matching works.';
            },
            chips: ['What wins a game?', 'Who calls fouls?', '3-second rule?', 'Code of conduct']
        }
    };

    // ── Scripted playbooks (used when AI is off or fails) ──
    function has(text, re) { return re.test(text); }
    function skillTier(p) {
        var s = p && p.skill != null ? p.skill : 6;
        return s <= 5 ? 'starter' : (s <= 7 ? 'hooper' : 'elite');
    }
    var POS_DRILLS = {
        PG: ['Two-ball pound series: 3 × 45s (low, high, crossover)', 'Pick-and-roll reads: snake dribble into pocket pass or pull-up, 20 reps each side', 'Full-court 2-dribble layups to work pace control, 10 trips'],
        SG: ['Catch-and-shoot from 5 spots, 10 makes each before moving', 'Relocation threes: shoot, sprint to the next spot, repeat — 3 × 1 min', 'One-dribble pull-ups going both ways, 15 each'],
        SF: ['Triple-threat jab series: jab-shot, jab-drive, jab-cross, 10 each wing', 'Closeout attack: one hard dribble to the rim or a step-back, 20 reps', 'Corner three + transition wing runs, 3 × 1 min'],
        PF: ['Short-roll decisions: catch at the free-throw line, then floater, dump-off or kick, 20 reps', 'Face-up jumpers from the elbows, 10 makes each side', 'Rebound-and-outlet chain, 15 reps'],
        C: ['Mikan drill: 3 × 30s both hands', 'Drop step and up-and-under from both blocks, 10 each', 'Rim-run finishing off lob tosses + box-out reps, 15 each']
    };
    function coachReply(text) {
        var p = profile();
        var tier = skillTier(p);
        var pos = (p && p.position) || (text.match(/\b(pg|sg|sf|pf|c|point guard|shooting guard|small forward|power forward|center|big)\b/i) || [])[0];
        if (pos) {
            pos = String(pos).toLowerCase();
            pos = { 'point guard': 'PG', 'shooting guard': 'SG', 'small forward': 'SF', 'power forward': 'PF', center: 'C', big: 'C' }[pos] || pos.toUpperCase();
            if (!POS_DRILLS[pos]) pos = null;
        }
        var reps = { starter: '3 days a week, 45 min', hooper: '4 days a week, 60 min', elite: '5 days a week, 75 min' }[tier];

        if (has(text, /\b(plan|workout|program|routine|schedule|week)/)) {
            var d = POS_DRILLS[pos || 'SF'];
            return { text: '**Your ' + (pos ? pos + ' ' : '') + 'plan — ' + reps + '**\n' +
                '1. Warm-up (10 min): jog, dynamic stretches, form shooting close to the rim\n' +
                '2. Skill block (' + (tier === 'starter' ? '15' : '25') + ' min):\n   - ' + d.join('\n   - ') + '\n' +
                '3. Shooting (15 min): 50 makes mid-range + 25 free throws, tired legs\n' +
                '4. Conditioning (10 min): 5 × suicides or 17s, rest 45s\n' +
                '5. Finish: 5 min stretch, hydrate.' +
                (p ? '' : '\n\nLog in and set your position + skill on your profile and I\'ll tailor this tighter.'),
                actions: p ? [] : ['signup'] };
        }
        if (has(text, /\b(shoot|shot|jumper|three|3pt|3s|free throw|ft|form|arc)/)) {
            return { text: '**Shooting reset**\n- Form shots 1 ft from the rim, one hand, 25 makes — elbow under the ball, hold the follow-through\n- Step back to the block, then the elbow, only after 8/10\n- "Around the world" 5 spots, ' + (tier === 'elite' ? 'deep three range, must make 2 in a row' : 'mid-range, 7 makes per spot') + '\n- End with 20 free throws while breathing hard\nTip: same release point every rep. Legs give you range, not arms.' };
        }
        if (has(text, /\b(handle|handles|dribbl|crossover|ball ?handling|turnover)/)) {
            return { text: '**Handles block (15 min)**\n- Stationary pounds: right, left, crossover, between legs, behind back — 30s each, eyes up\n- Two-ball dribbling: same time, alternating, 3 × 45s\n- Cone zig-zag with a change of pace at each cone, 6 trips\n- Tennis-ball toss/catch while dribbling for vision\nTip: low and hard beats fancy. Protect it with your off-arm in traffic.' };
        }
        if (has(text, /\b(defen[cs]e|defend|lock|guard|steal|block|closeout|slide)/)) {
            return { text: '**Lock-down defense**\n- Defensive slides lane-line to lane-line, 4 × 30s, hips low, no crossing feet\n- Closeout drill: sprint, chop feet, high hand, 15 reps\n- Mirror drill with a partner, 3 × 30s\n- Box out every shot — in pickup, the boards win the game\nTip: watch the hips, not the ball. Talk on every screen.' };
        }
        if (has(text, /\b(condition|cardio|stamina|wind|tired|run longer|endurance|gassed)/)) {
            return { text: '**Game-shape conditioning (20 min)**\n- 4 × full-court suicides, 45s rest\n- 6 × 17s (sideline to sideline 17 times), 60s rest\n- 3 × 1 min defensive slide + sprint combo\nDo it 2–3 times a week after skill work. Pickup to 21 needs repeat sprints more than long jogs.' };
        }
        if (has(text, /\b(jump|vertical|dunk|bounce|explosive)/)) {
            return { text: '**Bounce program (2–3×/week)**\n- Box jumps 4 × 5 (step down, don\'t jump down)\n- Split squats 3 × 8 each leg\n- Depth drops into a stick landing 3 × 5\n- Calf raises 3 × 15\nRest 48 hours between sessions. Land soft — knees over toes.' };
        }
        if (has(text, /\b(warm ?up|stretch|injur|sore|ankle|knee)/)) {
            return { text: '**Warm-up before every run (8–10 min)**\n- Light jog + high knees, butt kicks, carioca\n- Leg swings, hip openers, walking lunges\n- Form shooting close in, then a few sprints\nIf something actually hurts (sharp pain, swelling), sit that run out and get it checked — no drill is worth an injury.' };
        }
        if (pos && POS_DRILLS[pos]) {
            return { text: '**Top drills for a ' + pos + '**\n- ' + POS_DRILLS[pos].join('\n- ') + '\nWant a full weekly plan? Just say "build my plan".' };
        }
        return { text: 'I can help with **shooting, handles, defense, conditioning, vertical** or a full **workout plan**' + (p && p.position ? ' for a ' + p.position : '') + '. What do you want to work on?' };
    }

    function matchmakerReply(text) {
        var open = openRuns();
        var signedIn = g('signedIn');
        if (has(text, /\b(balanc|fair|team|how.*match|matching|algorithm|protocol|pick)/)) {
            var m = siteRules().matching;
            return { text: '**How NBL matching works**\n- ' + m.join('\n- ') + '\nOn Live Matching, when a run fills up (or the host taps Lock teams), players are split by skill into NEON and PINK.', actions: ['compete'] };
        }
        if (has(text, /\b(start|create|host|post|make|set up|organi[sz]e)/)) {
            return { text: '**Start a run in 3 steps**\n1. Open Live Matching\n2. Pick a park, when (Now / Tonight / Weekend) and format (5v5 or 3v3)\n3. Tap **Create run** — other signed-in players can jump in, and teams lock when it fills.' +
                (signedIn ? '' : '\nYou\'ll need to be logged in first.'), actions: signedIn ? ['compete', 'nearme'] : ['login', 'signup', 'compete'] };
        }
        if (has(text, /\b(3v3|5v5|three on three|five on five|half court|full court|format)/)) {
            return { text: 'Per the NBL rules, games are **5v5 full court** by default, or **3v3 half court** by agreement. On Live Matching, 5v5 runs need 10 players and 3v3 runs need 6. Short on bodies? Start a 3v3.', actions: ['compete'] };
        }
        if (has(text, /\b(find|join|near|close|around|nearby|run|game|play|tonight|now|weekend|open)/)) {
            if (open.length) {
                return { text: runsText() + '\n\nOpen Live Matching and tap **Join this run** on the one you want.' + (signedIn ? '' : ' Log in first so you can join.'),
                    actions: signedIn ? ['compete', 'nearme'] : ['login', 'compete'] };
            }
            return { text: 'No open runs on the board right now. Be the first — start one at a park near you and other ballers can join.' + (signedIn ? '' : ' You\'ll need to log in to post it.'),
                actions: signedIn ? ['nearme', 'compete'] : ['login', 'signup', 'nearme'] };
        }
        if (has(text, /\b(park|court|where|location)/)) {
            var c = g('courts');
            return { text: 'NBL has ' + (c.length ? '**' + c.length + ' parks**' : 'parks') + ' pinned across Florida and Texas. Use "Parks near me" to sort them by distance, or check the court map to see which ones are hot.', actions: ['nearme', 'map'] };
        }
        if (has(text, /\b(sign ?up|log ?in|account|profile|join nbl|register)/)) {
            return { text: signedIn ? 'You\'re already logged in — you can create or join runs right away.' : 'Create a free NBL account to join runs, post your own, and get matched by skill.', actions: signedIn ? ['compete'] : ['signup', 'login'] };
        }
        return { text: 'I can **find a run**, help you **start one**, or explain **how teams are balanced**. What do you need?', actions: ['compete'] };
    }

    function refReply(text) {
        var r = siteRules();
        var cite = function (arr, i, label) { return '**' + label + ' ' + (i + 1 < 10 ? '0' : '') + (i + 1) + ':** ' + (arr[i] || ''); };
        var num = text.match(/\b(?:rule\s*#?\s*)0?([1-5])\b/);
        if (num && /rule/.test(text)) {
            var i = parseInt(num[1], 10) - 1;
            return { text: cite(r.pickup, i, 'Pickup rule') };
        }
        if (has(text, /\b(win|score|points|21|by 2|game point|how long|end|first to)/)) return { text: cite(r.pickup, 1, 'Pickup rule') + '\nAgree on which one before tip-off so nobody argues at 20.' };
        if (has(text, /\b(check|top of the key|inbound|cherry|pick ?off|cherry ?pick)/)) return { text: cite(r.pickup, 2, 'Pickup rule') + '\nCherry picking (camping on offense while your team defends) is not allowed.' };
        if (has(text, /\b(3|three)[ -]?(sec|second)|\bpaint\b|\blane\b|\bcamp/)) return { text: cite(r.pickup, 3, 'Pickup rule') + '\nOffensive players can\'t sit in the lane for more than 3 seconds.' };
        if (has(text, /\b(foul|call|hack|reach|travel|carry|double|violation|dispute|argu)/)) return { text: cite(r.pickup, 4, 'Pickup rule') + '\nIn NBL pickup, players call their own fouls and violations. Make the call honestly, respect the other player\'s call, and if it\'s a dispute, check it up.' };
        if (has(text, /\b(5v5|3v3|full court|half court|how many|players|format)/)) return { text: cite(r.pickup, 0, 'Pickup rule') };
        if (has(text, /\b(balanc|match|skill|position|re-?roll|team)/)) return { text: '**Automated Matching Protocol**\n- ' + r.matching.join('\n- ') };
        if (has(text, /\b(conduct|respect|trash|talk|cancel|no.?show|late|gatorade|new player|beginner|ego|behav)/)) return { text: '**Code of Conduct**\n- ' + r.conduct.join('\n- ') };
        if (has(text, /\b(all|rules|list|standard)/)) return { text: '**Standard Pickup Rules**\n' + r.pickup.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n'), actions: ['rules'] };
        return { text: 'That one isn\'t covered in the NBL Pickup Standards. Here\'s what is:\n' + r.pickup.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n') + '\nFor anything else, agree on it before tip-off.', actions: ['rules'] };
    }

    function scriptedReply(botId, raw) {
        var text = String(raw || '').toLowerCase();
        if (/^\s*(hi|hey|yo|hello|sup|what'?s up)\b/.test(text) && text.length < 20) {
            return { text: 'Yo! ' + BOTS[botId].greeting() };
        }
        if (botId === 'coach') return coachReply(text);
        if (botId === 'matchmaker') return matchmakerReply(text);
        return refReply(text);
    }

    // ── AI brain (Firebase AI Logic, Gemini Developer API) ──
    var ai = { state: 'idle', models: {}, failedAt: 0, loading: null, lastError: null };

    function systemPrompt(botId) {
        var base = 'You are a helper bot on the NBL (National Basketball League) website, an automated pickup-basketball app. ' +
            'Users find parks on a map, create or join live pickup runs (5v5 or 3v3), and get auto-balanced teams. ' +
            'Site sections: Court map, Player Profiles, NBL Pickup Standards (rules), Live Matching. ' +
            'Style: friendly hooper energy, plain words, short answers (under 120 words), use short bullet lists when helpful, ' +
            'markdown bold with **double asterisks** is allowed but no headings or tables. Never invent site features that are not listed here. ' +
            profileText() + '\n\n';
        var actions = 'You may add at most two action buttons at the very end of your reply using these exact tokens: ' +
            '[[action:compete]] (open Live Matching), [[action:nearme]] (sort parks by distance), [[action:rules]] (open the rules), ' +
            '[[action:profiles]] (browse players), [[action:login]], [[action:signup]], [[action:map]]. Only use them when genuinely useful.\n\n';
        if (botId === 'coach') {
            return base + actions + 'You are "Coach Flex", a basketball skills coach. Give drills, skill tips and workout plans. ' +
                'Tailor everything to the user\'s position and skill level when known (skill is a 3–10 self rating: 3–5 beginner, 6–7 intermediate, 8–10 advanced). ' +
                'Give concrete sets, reps and times. If asked about pain or injuries, give general safety advice and suggest seeing a professional; do not diagnose. ' +
                'Stay on basketball and fitness topics.';
        }
        if (botId === 'matchmaker') {
            return base + actions + 'You are "Matchmaker", who helps users find or start a pickup run. ' +
                'How it works on the site: on Live Matching, pick a park, when (Now/Tonight/This weekend) and format (5v5 needs 10, 3v3 needs 6), then tap Create run. ' +
                'Others tap Join this run. When the run fills or the host taps Lock teams, players are split by skill into NEON and PINK teams. ' +
                'Users must be logged in to create or join runs. ' + (g('signedIn') ? 'The user IS logged in.' : 'The user is NOT logged in.') + '\n' +
                runsText() + '\n\nAutomated Matching Protocol:\n- ' + siteRules().matching.join('\n- ') +
                '\nOnly mention runs listed above; never make up runs, players or parks.';
        }
        return base + actions + 'You are "The Ref". Answer rules questions using ONLY the official NBL Pickup Standards below, quoting or citing the rule number. ' +
            'If something is not covered, say it is not in the NBL standards and suggest players agree on it before tip-off (you may mention common streetball custom, clearly labeled as custom, not NBL rule).\n\n' +
            rulesAsText();
    }

    function loadAI() {
        if (!CFG.ai) return Promise.reject(new Error('AI disabled in config'));
        if (ai.state === 'ready') return Promise.resolve(ai);
        if (ai.state === 'failed' && Date.now() - ai.failedAt < CFG.retryAfterMs) return Promise.reject(ai.lastError || new Error('AI unavailable'));
        if (ai.loading) return ai.loading;
        var cfg = g('config');
        if (!cfg || !cfg.apiKey || String(cfg.apiKey).indexOf('PASTE_') === 0) return Promise.reject(new Error('Firebase config missing'));
        var base = 'https://www.gstatic.com/firebasejs/' + CFG.sdkVersion + '/';
        ai.state = 'loading';
        ai.loading = Promise.all([
            import(base + 'firebase-app.js'),
            import(base + 'firebase-ai.js'),
            CFG.appCheckSiteKey ? import(base + 'firebase-app-check.js') : Promise.resolve(null)
        ]).then(function (mods) {
            var appMod = mods[0], aiMod = mods[1], acMod = mods[2];
            var APP_NAME = 'nbl-bots';
            var app = (appMod.getApps().filter(function (a) { return a.name === APP_NAME; })[0]) || appMod.initializeApp(cfg, APP_NAME);
            if (acMod && CFG.appCheckSiteKey) {
                try {
                    if (CFG.appCheckDebug) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
                    var Provider = CFG.appCheckProvider === 'enterprise' ? acMod.ReCaptchaEnterpriseProvider : acMod.ReCaptchaV3Provider;
                    acMod.initializeAppCheck(app, { provider: new Provider(CFG.appCheckSiteKey), isTokenAutoRefreshEnabled: true });
                } catch (e) { console.warn('[NBL bots] App Check init skipped:', e && e.message); }
            }
            ai.mod = aiMod;
            ai.service = aiMod.getAI(app, { backend: new aiMod.GoogleAIBackend() });
            ai.state = 'ready';
            ai.loading = null;
            return ai;
        }).catch(function (err) {
            markAIFailed(err);
            throw err;
        });
        return ai.loading;
    }
    function markAIFailed(err) {
        ai.state = 'failed';
        ai.failedAt = Date.now();
        ai.loading = null;
        ai.lastError = err;
        console.info('[NBL bots] AI Logic unavailable, using playbook mode:', (err && (err.code || err.message)) || err);
    }

    function aiReply(botId, history) {
        return loadAI().then(function (svc) {
            var model = svc.mod.getGenerativeModel(svc.service, {
                model: CFG.model,
                systemInstruction: systemPrompt(botId),
                generationConfig: { maxOutputTokens: 500, temperature: 0.7 }
            });
            var contents = history.slice(-12).map(function (m) {
                return { role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] };
            });
            while (contents.length && contents[0].role !== 'user') contents.shift();
            var timer;
            var timeout = new Promise(function (_, reject) {
                timer = setTimeout(function () { reject(new Error('AI request timed out')); }, CFG.requestTimeoutMs);
            });
            return Promise.race([model.generateContent({ contents: contents }), timeout]).then(function (res) {
                clearTimeout(timer);
                var txt = res && res.response && typeof res.response.text === 'function' ? res.response.text() : '';
                if (!txt || !txt.trim()) throw new Error('Empty AI response');
                return parseActions(txt.trim());
            }, function (err) { clearTimeout(timer); throw err; });
        }).catch(function (err) {
            if (ai.state !== 'failed') markAIFailed(err);
            throw err;
        });
    }
    function parseActions(txt) {
        var acts = [];
        var clean = txt.replace(/\[\[\s*action\s*:\s*([a-z]+)\s*\]\]/gi, function (_, a) {
            a = a.toLowerCase();
            if (ACTIONS[a] && acts.indexOf(a) === -1 && acts.length < 2) acts.push(a);
            return '';
        }).trim();
        return { text: clean, actions: acts };
    }

    // ── UI ──
    var state = { open: false, bot: 'coach', busy: false, threads: { coach: [], matchmaker: [], ref: [] }, greeted: {} };
    var el = {};

    function h(tag, attrs, kids) {
        var n = document.createElement(tag);
        if (attrs) Object.keys(attrs).forEach(function (k) {
            if (k === 'text') n.textContent = attrs[k];
            else if (k === 'class') n.className = attrs[k];
            else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
            else n.setAttribute(k, attrs[k]);
        });
        (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
        return n;
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }
    function richText(s) {
        // escape first, then allow **bold** only
        return escapeHtml(s).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/^\s*[\*\-]\s+/gm, '• ');
    }

    function build() {
        el.launcher = h('button', { class: 'nblb-launcher', type: 'button', 'aria-label': 'Open NBL helper bots', title: 'Ask Coach, Matchmaker or Ref', onclick: togglePanel }, [
            h('span', { text: '💬', 'aria-hidden': 'true' }),
            h('span', { class: 'nblb-ping', 'aria-hidden': 'true' })
        ]);

        el.avatar = h('div', { class: 'nblb-avatar', 'aria-hidden': 'true' });
        el.name = h('div', { class: 'nblb-name' });
        el.sub = h('div', { class: 'nblb-sub' });
        var tabs = Object.keys(BOTS).map(function (id) {
            var b = BOTS[id];
            return h('button', { class: 'nblb-tab', type: 'button', 'data-bot': id, role: 'tab', 'aria-label': b.name, onclick: function () { selectBot(id); } }, [
                h('span', { text: b.emoji, 'aria-hidden': 'true' }), h('span', { text: b.short })
            ]);
        });
        el.tabs = tabs;
        el.log = h('div', { class: 'nblb-log', role: 'log', 'aria-live': 'polite' });
        el.chips = h('div', { class: 'nblb-chips' });
        el.input = h('input', { class: 'nblb-input', type: 'text', maxlength: '500', placeholder: 'Ask something…', 'aria-label': 'Message', autocomplete: 'off' });
        el.send = h('button', { class: 'nblb-send', type: 'submit', 'aria-label': 'Send' }, [h('span', { text: '➤' })]);
        el.form = h('form', { class: 'nblb-form', onsubmit: function (e) { e.preventDefault(); send(el.input.value); } }, [el.input, el.send]);
        el.mode = h('div', { class: 'nblb-mode' });

        el.panel = h('div', { class: 'nblb-panel', role: 'dialog', 'aria-label': 'NBL helper bots' }, [
            h('div', { class: 'nblb-head' }, [
                h('div', { class: 'nblb-head-row' }, [
                    el.avatar,
                    h('div', { class: 'nblb-title' }, [h('div', { class: 'nblb-kicker', text: 'NBL HELPERS' }), el.name, el.sub]),
                    h('button', { class: 'nblb-close', type: 'button', 'aria-label': 'Close', onclick: closePanel, text: '×' })
                ]),
                h('div', { class: 'nblb-tabs', role: 'tablist' }, tabs)
            ]),
            el.log, el.chips, el.form, el.mode
        ]);

        document.body.appendChild(el.panel);
        document.body.appendChild(el.launcher);
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open) closePanel(); });
        updateMode();
    }

    function updateMode() {
        if (!el.mode) return;
        if (ai.state === 'ready') el.mode.innerHTML = '<b>AI on</b> · answers can be wrong — the rules page is the final word';
        else if (ai.state === 'failed' || !CFG.ai) el.mode.innerHTML = '<b>Playbook mode</b> · AI isn\'t switched on yet, so answers come from NBL\'s built-in playbook';
        else el.mode.textContent = 'Powered by NBL playbook + Gemini';
    }

    function togglePanel() { state.open ? closePanel() : openPanel(); }
    function openPanel() {
        state.open = true;
        el.panel.classList.add('nblb-show');
        el.launcher.classList.add('nblb-open');
        el.launcher.setAttribute('aria-expanded', 'true');
        selectBot(state.bot);
        setTimeout(function () { try { if (window.innerWidth >= 768) el.input.focus(); } catch (e) {} }, 50);
    }
    function closePanel() {
        state.open = false;
        if (!el.panel) return;
        el.panel.classList.remove('nblb-show');
        el.launcher.classList.remove('nblb-open');
        el.launcher.setAttribute('aria-expanded', 'false');
    }

    function selectBot(id) {
        if (!BOTS[id]) return;
        state.bot = id;
        var b = BOTS[id];
        el.avatar.textContent = b.emoji;
        el.avatar.setAttribute('data-bot', id);
        el.name.textContent = b.name;
        el.sub.textContent = b.tagline;
        el.input.placeholder = 'Ask ' + b.name + '…';
        el.tabs.forEach(function (t) {
            var on = t.getAttribute('data-bot') === id;
            t.classList.toggle('nblb-active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        if (!state.greeted[id]) {
            state.greeted[id] = true;
            state.threads[id].push({ role: 'model', text: b.greeting() });
        }
        renderThread();
        renderChips();
    }

    function renderChips() {
        el.chips.innerHTML = '';
        BOTS[state.bot].chips.forEach(function (c) {
            el.chips.appendChild(h('button', { class: 'nblb-chip', type: 'button', text: c, onclick: function () { send(c); } }));
        });
    }

    function renderThread() {
        el.log.innerHTML = '';
        state.threads[state.bot].forEach(function (m) { el.log.appendChild(messageNode(m)); });
        el.log.scrollTop = el.log.scrollHeight;
    }

    function messageNode(m) {
        var isUser = m.role === 'user';
        var bubble = h('div', { class: 'nblb-bubble' });
        bubble.innerHTML = richText(m.text);
        if (m.actions && m.actions.length) {
            var row = h('div', { class: 'nblb-actions' });
            m.actions.forEach(function (a) {
                if (!ACTIONS[a]) return;
                row.appendChild(h('button', { class: 'nblb-action', type: 'button', text: ACTIONS[a].label, onclick: function () { ACTIONS[a].run(); } }));
            });
            bubble.appendChild(row);
        }
        var wrap = h('div', {}, [
            h('div', { class: 'nblb-row ' + (isUser ? 'nblb-user' : 'nblb-bot') }, [
                isUser ? null : h('div', { class: 'nblb-avatar nblb-sm', 'data-bot': m.bot || state.bot, text: BOTS[m.bot || state.bot].emoji, 'aria-hidden': 'true' }),
                bubble
            ])
        ]);
        if (m.note) wrap.appendChild(h('div', { class: 'nblb-note', text: m.note }));
        return wrap;
    }

    function showTyping() {
        var t = h('div', { class: 'nblb-row nblb-bot nblb-typing-row' }, [
            h('div', { class: 'nblb-avatar nblb-sm', 'data-bot': state.bot, text: BOTS[state.bot].emoji }),
            h('div', { class: 'nblb-bubble' }, [h('span', { class: 'nblb-typing' }, [h('span'), h('span'), h('span')])])
        ]);
        el.log.appendChild(t);
        el.log.scrollTop = el.log.scrollHeight;
        return t;
    }

    function send(raw) {
        var text = String(raw || '').trim();
        if (!text || state.busy) return;
        var botId = state.bot;
        var thread = state.threads[botId];
        el.input.value = '';
        thread.push({ role: 'user', text: text.slice(0, 500) });
        renderThread();
        state.busy = true;
        el.send.disabled = true;
        var typing = showTyping();

        var finish = function (msg) {
            msg.bot = botId;
            thread.push(msg);
            if (thread.length > 40) thread.splice(1, thread.length - 40);
            state.busy = false;
            el.send.disabled = false;
            try { typing.remove(); } catch (e) {}
            updateMode();
            if (state.bot === botId) renderThread();
        };

        var useAI = CFG.ai && !(ai.state === 'failed' && Date.now() - ai.failedAt < CFG.retryAfterMs);
        if (!useAI) {
            setTimeout(function () {
                var r = scriptedReply(botId, text);
                finish({ role: 'model', text: r.text, actions: r.actions || [], note: 'Playbook answer' });
            }, 350);
            return;
        }
        aiReply(botId, thread).then(function (r) {
            finish({ role: 'model', text: r.text, actions: r.actions });
        }).catch(function () {
            var r = scriptedReply(botId, text);
            finish({ role: 'model', text: r.text, actions: r.actions || [], note: 'Playbook answer — AI isn\'t switched on yet' });
        });
    }

    function init() {
        try { build(); } catch (e) { console.warn('[NBL bots] UI failed to start:', e); }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // small debug/inspection hook
    window.NBLBots = {
        open: function (bot) { if (bot) state.bot = bot; openPanel(); },
        close: closePanel,
        status: function () { return { ai: ai.state, model: CFG.model, error: ai.lastError ? String(ai.lastError.message || ai.lastError) : null }; }
    };
})();
