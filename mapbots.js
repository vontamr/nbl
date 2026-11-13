/* ═══════════════════════════════════════════════════════════
   NBL Map Bots — official helpers that live on the court map
   ───────────────────────────────────────────────────────────
   Self-contained add-on. Loaded after the main site script.
   Places a few clearly branded "NBL Bot" markers near real
   parks. They nudge people to start or join a run and to
   talk to other real players. They are never presented as
   human players and are never added to a run roster.
   All actions call existing site functions (switchTab,
   fillNearestCourts, showAuthModal, openParkCard, …).
   No Firestore writes. Player/run counts are shown only
   when the page already has that data; otherwise the copy
   stays generic.
   ═══════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (window.__nblMapBotsLoaded) return;
    window.__nblMapBotsLoaded = true;

    var BOTS = [
        {
            id: 'spark',
            name: 'Spark',
            intro: "Official NBL bot. I hype runs — I don't play in them."
        },
        {
            id: 'connector',
            name: 'Connector',
            intro: "Official NBL bot. I help you land a match with real players."
        },
        {
            id: 'scout',
            name: 'Scout',
            intro: "Official NBL bot. I read the court and the sky so you can pick a time to hoop."
        },
        {
            id: 'host',
            name: 'Host',
            intro: "Official NBL bot. I break the ice so you can invite real players nearby."
        }
    ];

    // Named defaults when we don't have the visitor's location yet.
    // Spread across the two states the site actually maps.
    var DEFAULT_PARKS = {
        spark: 'Lake Eola Park Courts',
        connector: 'Cypress Grove Park',
        scout: 'Hermann Park',
        host: 'Reverchon Park'
    };

    // Sit just off the court pin so the two don't stack.
    var OFFSETS = [
        { dlat:  0.0015, dlng:  0.0016 },
        { dlat:  0.0016, dlng: -0.0013 },
        { dlat: -0.0014, dlng:  0.0015 },
        { dlat: -0.0015, dlng: -0.0014 }
    ];

    var state = {
        markers: [],
        legend: null,
        placedKey: '',
        lastHere: null,
        wx: {}
    };

    // ── Safe access to the site's let/const globals (same pattern as bots.js) ──
    function g(name) {
        try {
            switch (name) {
                case 'map': return (typeof map !== 'undefined' && map && map.addLayer) ? map : null;
                case 'courts': return (typeof ALL_COURTS !== 'undefined' && Array.isArray(ALL_COURTS)) ? ALL_COURTS : [];
                case 'runs': return (typeof liveRuns !== 'undefined' && Array.isArray(liveRuns)) ? liveRuns : [];
                case 'players': return (typeof players !== 'undefined' && Array.isArray(players)) ? players : [];
                case 'user': return (typeof currentUser !== 'undefined') ? currentUser : null;
                case 'signedIn': return !!(typeof auth !== 'undefined' && auth && auth.currentUser);
            }
        } catch (e) {}
        return name === 'courts' || name === 'runs' || name === 'players' ? [] : null;
    }
    function callSite(fnName) {
        var args = Array.prototype.slice.call(arguments, 1);
        try {
            var fn = window[fnName];
            if (typeof fn === 'function') { fn.apply(window, args); return true; }
        } catch (e) { console.warn('[NBL map bots] could not call', fnName, e); }
        return false;
    }
    function userCoords() {
        try {
            if (typeof lastKnownLat !== 'undefined' && lastKnownLat != null &&
                typeof lastKnownLng !== 'undefined' && lastKnownLng != null) {
                return { lat: Number(lastKnownLat), lng: Number(lastKnownLng) };
            }
        } catch (e) {}
        try {
            var u = g('user');
            if (u && u.lat != null && u.lng != null) return { lat: Number(u.lat), lng: Number(u.lng) };
        } catch (e) {}
        // Guests: the site flies the map to them but only persists coords when signed in.
        // If the map is zoomed into a city, treat that as "here".
        try {
            var m = g('map');
            if (m && typeof m.getZoom === 'function' && m.getZoom() >= 10) {
                var c = m.getCenter();
                if (c) return { lat: c.lat, lng: c.lng };
            }
        } catch (e) {}
        return null;
    }
    function kmBetween(a, b) {
        if (typeof window.kmBetween === 'function') {
            try { return window.kmBetween(a.lat, a.lng, b.lat, b.lng); } catch (e) {}
        }
        var R = 6371;
        var dLat = (b.lat - a.lat) * Math.PI / 180;
        var dLng = (b.lng - a.lng) * Math.PI / 180;
        var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.sqrt(x));
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function courtByName(name) {
        if (typeof window.courtByName === 'function') {
            try {
                var c = window.courtByName(name);
                if (c) return c;
            } catch (e) {}
        }
        var list = g('courts');
        for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
        return null;
    }

    function nearbyCount(court) {
        if (!court) return 0;
        try {
            if (typeof nearbyActiveAtCourt === 'function') {
                var n = nearbyActiveAtCourt(court, 3.2);
                return (typeof n === 'number' && n > 0) ? n : 0;
            }
        } catch (e) {}
        return 0;
    }
    function openRunsAt(court) {
        if (!court) return [];
        return g('runs').filter(function (r) {
            return r && r.status === 'open' && r.courtName === court.name;
        });
    }

    function pickParks() {
        var courts = g('courts');
        var here = userCoords();
        var picked = [];
        if (here && courts.length) {
            var scored = courts.slice().filter(function (c) {
                return c && c.lat != null && c.lng != null;
            }).sort(function (a, b) {
                return kmBetween(here, a) - kmBetween(here, b);
            });
            for (var i = 0; i < scored.length && picked.length < BOTS.length; i++) {
                var c = scored[i];
                var farEnough = picked.every(function (p) { return kmBetween(p, c) >= 1.2; });
                if (farEnough || !picked.length) picked.push(c);
            }
            // Fill from leftover nearest parks if we couldn't spread them.
            for (var j = 0; j < scored.length && picked.length < BOTS.length; j++) {
                if (picked.indexOf(scored[j]) === -1) picked.push(scored[j]);
            }
            return picked;
        }
        BOTS.forEach(function (bot) {
            var c = courtByName(DEFAULT_PARKS[bot.id]);
            if (c && picked.indexOf(c) === -1) picked.push(c);
        });
        // Fallback if a named park was removed from the list.
        for (var k = 0; k < courts.length && picked.length < BOTS.length; k++) {
            if (picked.indexOf(courts[k]) === -1) picked.push(courts[k]);
        }
        return picked;
    }

    function timeLine() {
        var h = new Date().getHours();
        if (h < 11) return 'Morning window — post a run and give nearby players something to jump into.';
        if (h < 16) return 'Afternoon is a good time to get a run on the board before the after-work rush.';
        if (h < 21) return 'Prime evening hoop hours. Land a match tonight.';
        return 'Late session energy. If you want a run, post it — someone scrolling the board may be looking too.';
    }

    function buildCopy(bot, court) {
        var lines = [bot.intro];
        var runs = openRunsAt(court);
        var nearby = nearbyCount(court);
        var user = g('user');
        var signedIn = g('signedIn');

        if (runs.length) {
            var r = runs[0];
            var need = r.need || parseInt(r.format, 10) || 0;
            var have = Array.isArray(r.playerUids) ? r.playerUids.length : 0;
            var extra = (have && need) ? ' (' + have + '/' + need + ' real players in)' : '';
            lines.push('There is an open run at ' + court.name + ' right now' + extra + '. Jump in on Live Matching.');
        } else if (nearby > 0) {
            lines.push(nearby === 1
                ? 'No run listed here yet, but 1 player is listed near this court. Start a run and invite them.'
                : 'No run listed here yet, but ' + nearby + ' players are listed near this court. Start a run and get a match going.');
        } else {
            lines.push('No run listed at ' + court.name + ' yet. Be first to post one — that\'s how a match gets started.');
        }

        if (bot.id === 'host') {
            lines.push('Open the park card and drop a line on the local board so real players nearby can see you.');
        } else {
            lines.push(timeLine());
        }

        if (signedIn && user && typeof user.gamesPlayed === 'number' && user.gamesPlayed > 0) {
            lines.push('You\'ve logged ' + user.gamesPlayed + ' game' + (user.gamesPlayed === 1 ? '' : 's') +
                ' — keep it going by landing a match.');
        }
        return lines;
    }

    function weatherText(info) {
        if (!info) return '';
        var bits = [];
        if (info.temp != null) bits.push(info.temp + '°F');
        if (info.label) bits.push(info.label);
        if (info.wind != null) bits.push(info.wind + ' mph');
        if (info.tip) bits.push(info.tip);
        return bits.join(' · ');
    }
    function weatherFor(court, cb) {
        if (!court || court.lat == null) { cb(null); return; }
        var key = Number(court.lat).toFixed(2) + ',' + Number(court.lng).toFixed(2);
        var hit = state.wx[key];
        if (hit && Date.now() - hit.at < 10 * 60 * 1000) { cb(hit); return; }
        var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + court.lat +
            '&longitude=' + court.lng +
            '&current=temperature_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph';
        fetch(url).then(function (r) { return r.json(); }).then(function (data) {
            var cur = data && data.current;
            if (!cur) { cb(null); return; }
            var code = cur.weather_code;
            var temp = Math.round(cur.temperature_2m);
            var label = 'Outside';
            var tip = '';
            try { if (typeof weatherLabel === 'function') label = weatherLabel(code); } catch (e) {}
            try { if (typeof hoopTip === 'function') tip = hoopTip(temp, code); } catch (e) {}
            var info = { at: Date.now(), temp: temp, code: code, wind: Math.round(cur.wind_speed_10m || 0), label: label, tip: tip };
            state.wx[key] = info;
            cb(info);
        }).catch(function () { cb(null); });
    }

    function cardHtml(bot, court, wx) {
        var lines = buildCopy(bot, court);
        var signedIn = g('signedIn');
        var body = lines.map(function (txt) { return '<p>' + escapeHtml(txt) + '</p>'; }).join('');
        var wxText = weatherText(wx);
        var wxCls = wxText ? ' nblmb-show' : '';
        var authBtns = signedIn ? '' : (
            '<div class="nblmb-row">' +
            '<button type="button" class="nblmb-btn nblmb-ghost nblmb-act" data-act="login">Log in</button>' +
            '<button type="button" class="nblmb-btn nblmb-ghost nblmb-act" data-act="signup">Join NBL</button>' +
            '</div>'
        );
        return (
            '<button type="button" class="nblmb-close" data-act="close" aria-label="Close">×</button>' +
            '<div class="nblmb-card" data-bot="' + bot.id + '" data-court="' + escapeHtml(court.name) + '">' +
            '<div class="nblmb-head">' +
            '<div class="nblmb-avatar" data-bot="' + bot.id + '" aria-hidden="true">NBL</div>' +
            '<div>' +
            '<div class="nblmb-name">' + escapeHtml(bot.name) + '</div>' +
            '<div class="nblmb-badge">NBL Bot · not a player</div>' +
            '</div></div>' +
            '<div class="nblmb-place">' + escapeHtml(court.name) + ' · ' + escapeHtml(court.area || '') +
            (court.state ? ', ' + escapeHtml(court.state) : '') + '</div>' +
            '<div class="nblmb-body">' + body + '</div>' +
            '<div class="nblmb-wx' + wxCls + '" data-role="wx">' + escapeHtml(wxText) + '</div>' +
            '<div class="nblmb-actions">' +
            '<button type="button" class="nblmb-btn nblmb-act" data-act="run" data-court="' + escapeHtml(court.name) + '">Start a run here</button>' +
            '<button type="button" class="nblmb-btn nblmb-pink nblmb-act" data-act="match" data-court="' + escapeHtml(court.name) + '">Open Live Matching</button>' +
            '<div class="nblmb-row">' +
            '<button type="button" class="nblmb-btn nblmb-ghost nblmb-act" data-act="park" data-court="' + escapeHtml(court.name) + '">Park card / board</button>' +
            '<button type="button" class="nblmb-btn nblmb-ghost nblmb-act" data-act="chat">Ask Matchmaker</button>' +
            '</div>' +
            '<button type="button" class="nblmb-btn nblmb-ghost nblmb-act" data-act="nearme">Parks near me</button>' +
            authBtns +
            '</div>' +
            '<div class="nblmb-foot">Official NBL helper. I never count as a roster spot — only real, signed-in players do.</div>' +
            '</div>'
        );
    }

    function botIcon(bot) {
        return L.divIcon({
            className: 'custom-marker',
            html: '<div class="nblmb-pin nblmb-pulse" data-bot="' + bot.id + '" title="NBL Bot — ' + escapeHtml(bot.name) + '">' +
                '<div class="nblmb-shield">NBL</div>' +
                '<div class="nblmb-tag">BOT</div>' +
                '</div>',
            iconSize: [46, 52],
            iconAnchor: [23, 46],
            popupAnchor: [0, -44]
        });
    }

    function cardHost() {
        var host = document.getElementById('nblmb-overlay');
        if (host) return host;
        var shell = document.querySelector('.nbl-map-shell');
        if (!shell) {
            var mapEl = document.getElementById('map');
            shell = mapEl && mapEl.parentElement;
        }
        host = document.createElement('div');
        host.id = 'nblmb-overlay';
        host.className = 'nblmb-overlay';
        host.innerHTML = '<div class="nblmb-sheet" role="dialog" aria-modal="true" aria-label="NBL Bot"></div>';
        host.addEventListener('click', function (e) {
            if (e.target === host) closeCard();
        });
        (shell || document.body).appendChild(host);
        return host;
    }

    function isCardOpen() {
        var host = document.getElementById('nblmb-overlay');
        return !!(host && host.classList.contains('nblmb-open'));
    }

    function closeCard() {
        var host = document.getElementById('nblmb-overlay');
        if (!host) return;
        host.classList.remove('nblmb-open');
        var sheet = host.querySelector('.nblmb-sheet');
        if (sheet) sheet.innerHTML = '';
        state.openBot = null;
        try { if (g('map')) g('map').closePopup(); } catch (e) {}
    }

    function openCard(bot, court, marker) {
        if (!bot || !court) return;
        var host = cardHost();
        var sheet = host.querySelector('.nblmb-sheet');
        sheet.innerHTML = cardHtml(bot, court, null);
        host.classList.add('nblmb-open');
        state.openBot = bot.id;
        try { if (window.NBLBots && window.NBLBots.close) window.NBLBots.close(); } catch (e) {}
        try { sheet.focus(); } catch (e) {}
        weatherFor(court, function (info) {
            if (!isCardOpen() || state.openBot !== bot.id || !info) return;
            sheet.innerHTML = cardHtml(bot, court, info);
        });
        if (marker && g('map')) {
            try {
                var m = g('map');
                var ll = marker.getLatLng();
                // Keep the pin in the upper/center area so the sheet does not cover it.
                var z = Math.max(m.getZoom() || 13, 13);
                m.flyTo(ll, z, { duration: 0.45 });
            } catch (e) {}
        }
    }

    function goCompete(courtName) {
        callSite('switchTab', 'compete');
        setTimeout(function () {
            if (courtName) {
                var sel = document.getElementById('match-court-select');
                if (sel) {
                    sel.value = courtName;
                    sel.style.transition = 'box-shadow .3s';
                    sel.style.boxShadow = '0 0 0 2px #39FF14';
                    setTimeout(function () { sel.style.boxShadow = ''; }, 1800);
                }
            }
            var section = document.getElementById('section-compete');
            if (section && section.scrollIntoView) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 80);
    }

    function handleAction(act, courtName) {
        if (act === 'close') { closeCard(); return; }
        closeCard();
        if (act === 'run') {
            goCompete(courtName);
            callSite('showToast', 'Pick your format and tap Create run. Only real players go on the roster.');
            return;
        }
        if (act === 'match') {
            goCompete(courtName);
            return;
        }
        if (act === 'park') {
            if (courtName) callSite('openParkCard', courtName);
            return;
        }
        if (act === 'nearme') {
            goCompete();
            callSite('fillNearestCourts');
            return;
        }
        if (act === 'chat') {
            try {
                if (window.NBLBots && typeof window.NBLBots.open === 'function') window.NBLBots.open('matchmaker');
            } catch (e) {}
            return;
        }
        if (act === 'login') { callSite('showAuthModal', 'login'); return; }
        if (act === 'signup') { callSite('showAuthModal', 'signup'); return; }
    }

    function bindDelegation() {
        if (window.__nblMapBotsClicks) return;
        window.__nblMapBotsClicks = true;
        document.addEventListener('click', function (e) {
            var btn = e.target && e.target.closest && e.target.closest('.nblmb-act, .nblmb-close');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            handleAction(btn.getAttribute('data-act'), btn.getAttribute('data-court'));
        }, true);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && isCardOpen()) closeCard();
        });
    }

    function addLegend(m) {
        if (state.legend || !m || typeof L === 'undefined' || !L.control) return;
        var ctl = L.control({ position: 'bottomleft' });
        ctl.onAdd = function () {
            var d = L.DomUtil.create('div', 'nblmb-legend');
            d.setAttribute('role', 'note');
            d.innerHTML = '<div class="nblmb-legend-ico">NBL</div>' +
                '<div><b>NBL Bot</b><span>Official helper · not a player</span></div>';
            return d;
        };
        ctl.addTo(m);
        state.legend = ctl;
    }

    function clearMarkers() {
        var m = g('map');
        state.markers.forEach(function (mk) {
            try { if (m) m.removeLayer(mk); } catch (e) {}
        });
        state.markers = [];
    }

    function placeBots(force) {
        var m = g('map');
        if (!m || typeof L === 'undefined') return;
        var parks = pickParks();
        if (!parks.length) return;
        var key = parks.map(function (c) { return c.name; }).join('|') + '|' + (userCoords() ? 'here' : 'default');
        if (!force && key === state.placedKey && state.markers.length) return;
        if (isCardOpen() && !force) return;

        clearMarkers();
        state.placedKey = key;
        addLegend(m);
        cardHost();

        BOTS.forEach(function (bot, i) {
            var court = parks[i] || parks[0];
            if (!court) return;
            var off = OFFSETS[i % OFFSETS.length];
            var lat = court.lat + off.dlat;
            var lng = court.lng + off.dlng;
            var marker = L.marker([lat, lng], {
                icon: botIcon(bot),
                zIndexOffset: 800,
                keyboard: true,
                title: 'NBL Bot — ' + bot.name + ' (not a player)',
                alt: 'NBL Bot ' + bot.name + ', official helper, not a player, at ' + court.name
            }).addTo(m);

            marker.nblBotId = bot.id;
            marker.nblCourtName = court.name;
            marker.on('click', function () {
                var c = courtByName(marker.nblCourtName) || court;
                openCard(bot, c, marker);
            });
            state.markers.push(marker);
        });
        console.log('%c[NBL map bots] ' + state.markers.length + ' official NBL bots on the map (not players)', 'color:#39FF14');
    }

    function watchLocation() {
        setInterval(function () {
            var here = userCoords();
            var sig = here ? (here.lat.toFixed(3) + ',' + here.lng.toFixed(3)) : '';
            if (sig !== state.lastHere) {
                state.lastHere = sig;
                placeBots(false);
            }
        }, 2000);
    }

    function tryPlace() {
        if (!(g('map') && g('courts').length)) return false;
        placeBots(!state.markers.length);
        if (!state.watchingLoc) {
            state.watchingLoc = true;
            watchLocation();
        }
        return true;
    }

    function boot() {
        bindDelegation();
        // The site boots the map inside initializeHoopCruise (window.onload).
        // Wrap it so we place bots as soon as that finishes, even if onload is late.
        try {
            if (typeof window.initializeHoopCruise === 'function' && !window.initializeHoopCruise.__nblmbWrapped) {
                var orig = window.initializeHoopCruise;
                var wrapped = function () {
                    var r;
                    try { r = orig.apply(this, arguments); } catch (e) { throw e; }
                    setTimeout(tryPlace, 0);
                    setTimeout(tryPlace, 400);
                    setTimeout(tryPlace, 1200);
                    return r;
                };
                wrapped.__nblmbWrapped = true;
                window.initializeHoopCruise = wrapped;
            }
        } catch (e) {}
        if (tryPlace()) return;
        var tries = 0;
        var t = setInterval(function () {
            tries++;
            if (tryPlace()) clearInterval(t);
            else if (tries > 240) {
                clearInterval(t);
                console.warn('[NBL map bots] map was not ready; bots will stay hidden');
            }
        }, 250);
        window.addEventListener('load', function () {
            setTimeout(tryPlace, 50);
            setTimeout(tryPlace, 600);
        });
        var el = document.getElementById('map');
        if (el && typeof MutationObserver !== 'undefined') {
            var mo = new MutationObserver(function () {
                if (tryPlace()) mo.disconnect();
            });
            mo.observe(el, { attributes: true, childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
    // The court map is created on window.onload — boot also listens and observes #map.

    window.NBLMapBots = {
        refresh: function () { placeBots(true); },
        map: function () { return g('map'); },
        focus: function (id) {
            var mk = null;
            state.markers.forEach(function (m) { if (m.nblBotId === id) mk = m; });
            if (!mk && state.markers[0]) mk = state.markers[0];
            if (!mk) return;
            var bot = null;
            BOTS.forEach(function (b) { if (b.id === mk.nblBotId) bot = b; });
            var court = courtByName(mk.nblCourtName);
            if (bot && court) openCard(bot, court, mk);
        },
        close: closeCard,
        list: function () {
            return state.markers.map(function (m) { return { id: m.nblBotId, court: m.nblCourtName }; });
        }
    };
})();
