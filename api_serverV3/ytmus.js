const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const net = require("net");
const { exec, execSync, spawn } = require("child_process");
const YTMusic = require("ytmusic-api").default || require("ytmusic-api");
let InnertubeClass = null;
async function getInnertube() {
    if (!InnertubeClass) {
        const mod = await import("youtubei.js");
        InnertubeClass = mod.Innertube || mod.default?.Innertube || mod.default;
    }
    return InnertubeClass;
}

let PROXY_PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
let ALIAS_BASE_URL = `http://localhost:${PROXY_PORT}`;
const SERVER_START_TIME = Date.now();

// =============================================================================
// TEMPAT PASTE COOKIE YOUTUBE LANGSUNG (JIKA INGIN LANGSUNG DI DALAM FILE YTMUS.JS)
// =============================================================================
const EMBEDDED_YOUTUBE_COOKIE = `# Netscape HTTP Cookie File
# https://curl.haxx.se/rfc/cookie_spec.html
# This is a generated file! Do not edit.

.youtube.com	TRUE	/	TRUE	1787266688	GPS	1
.youtube.com	TRUE	/	TRUE	1821825045	PREF	f4=4000000&f6=40000000&tz=Asia.Jakarta
.youtube.com	TRUE	/	TRUE	0	YSC	gkY0LhIMjBY
.youtube.com	TRUE	/	TRUE	1802817043	VISITOR_INFO1_LIVE	2uOfYTN5Wvo
.youtube.com	TRUE	/	TRUE	1802817043	VISITOR_PRIVACY_METADATA	CgJJRBIEGgAgEA%3D%3D
.youtube.com	TRUE	/	TRUE	1802816888	__Secure-YNID	21.YT=d2z5Rymh93Q2MeuPJU03QkAXu24oHMgews1y_69yvNisv39jveDCFOJ9IRwZGba33Y2dMSq22oHW_ajredD1jcSaLRdDAuothS3mRAA_mVdQgYARjmKzeUdqYTavMGhha9hJ-OXyFQeLwfxiPWjgOYuQ0kaEYvaZli4ZXHJ0bwg2PuHRr3JrEovyux0gBr0Tg2CT5tnv5jsNiiacL5b_jx2kVuQJpfESEYr8xmxlOGRPwsFseitx3RNCFcCKxLnjHRZCw9WzWPw_lQJ7Bt6p5KG7oLxe9uN4MB14gAryKVmTolY0GfnTe52OneFelTyAJ_aUgSIeo9VoVn_gE30e4w
.youtube.com	TRUE	/	TRUE	1802816892	__Secure-ROLLOUT_TOKEN	CKy5guKEtJnVFRDoxLrGoLCWAxjIiKHIoLCWAw%3D%3D
`;

/**
 * Helper untuk membersihkan dan memformat isi cookies YouTube
 */
function sanitizeCookieContent(content) {
    if (!content) return "";
    let clean = content.trim();
    if (clean.includes("\\n")) clean = clean.replace(/\\n/g, "\n");
    if (clean.includes("\\t")) clean = clean.replace(/\\t/g, "\t");

    // Strip session and security tokens that Google automatically invalidates across different IPs/locations
    const invalidTokens = [
        "__Secure-1PSIDTS", "__Secure-3PSIDTS", "__Secure-3PSIDCC", "__Secure-1PSIDCC",
        "__Secure-3PAPISID", "__Secure-1PAPISID", "SAPISID", "APISID", "SSID", "HSID", "SIDCC"
    ];

    return clean
        .split("\n")
        .filter(line => {
            const hasInvalid = invalidTokens.some(tok => line.includes(tok));
            return !hasInvalid;
        })
        .join("\n");
}

function getCookieFilePath() {
    const localCookiePath = path.join(__dirname, "cookies.txt");
    if (fs.existsSync(localCookiePath)) {
        try {
            const stat = fs.statSync(localCookiePath);
            if (stat.size > 10) return localCookiePath;
        } catch (e) { }
    }

    const tempCookiePath = path.join(os.tmpdir(), "yt_cookies.txt");

    // 1. Cek Cookie Langsung di Variabel EMBEDDED_YOUTUBE_COOKIE
    if (EMBEDDED_YOUTUBE_COOKIE && EMBEDDED_YOUTUBE_COOKIE.trim().length > 10) {
        try {
            const content = sanitizeCookieContent(EMBEDDED_YOUTUBE_COOKIE);
            fs.writeFileSync(tempCookiePath, content, "utf-8");
            return tempCookiePath;
        } catch (e) { }
    }

    // 2. Defensively search process.env keys (YOUTUBE_COOKIES, COOKIES, COOKIE)
    let envCookies = process.env.YOUTUBE_COOKIES || process.env.COOKIES || process.env.COOKIE;
    let envCookiesBase64 = process.env.YOUTUBE_COOKIES_BASE64;

    for (const key of Object.keys(process.env)) {
        const cleanKey = key.trim().toUpperCase();
        if ((cleanKey === "YOUTUBE_COOKIES" || cleanKey === "COOKIES" || cleanKey === "COOKIE" || cleanKey.includes("COOKIE")) && !envCookies) {
            envCookies = process.env[key];
        }
        if (cleanKey === "YOUTUBE_COOKIES_BASE64" && !envCookiesBase64) {
            envCookiesBase64 = process.env[key];
        }
    }

    if (envCookies && envCookies.trim().length > 10) {
        try {
            const content = sanitizeCookieContent(envCookies);
            fs.writeFileSync(tempCookiePath, content, "utf-8");
            return tempCookiePath;
        } catch (e) { }
    }

    if (envCookiesBase64) {
        try {
            const decoded = Buffer.from(envCookiesBase64, "base64").toString("utf-8");
            const content = sanitizeCookieContent(decoded);
            fs.writeFileSync(tempCookiePath, content, "utf-8");
            return tempCookiePath;
        } catch (e) { }
    }

    return null;
}

/**
 * Helper untuk mendapatkan URL proxy jika disediakan via environment variable
 */
function getProxyArg() {
    let proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.PROXY_URL || process.env.YOUTUBE_PROXY;
    if (proxy && proxy.trim()) {
        proxy = proxy.trim();
        if (!proxy.startsWith("http://") && !proxy.startsWith("https://") && !proxy.startsWith("socks5://") && !proxy.startsWith("socks4://")) {
            proxy = `http://${proxy}`;
        }
        return proxy;
    }
    return null;
}

/**
 * Helper untuk mendapatkan path biner yt-dlp secara otomatis
 */
function getYtdlpBinaryPath() {
    if (process.platform === "win32" && fs.existsSync(path.join(__dirname, "yt-dlp.exe"))) {
        return path.join(__dirname, "yt-dlp.exe");
    }
    if (process.platform !== "win32") {
        if (fs.existsSync(path.join(__dirname, "yt-dlp"))) return path.join(__dirname, "yt-dlp");
        if (fs.existsSync("/usr/local/bin/yt-dlp")) return "/usr/local/bin/yt-dlp";
        if (fs.existsSync("/usr/bin/yt-dlp")) return "/usr/bin/yt-dlp";
    }
    try {
        const ytdlpExec = require("yt-dlp-exec");
        if (ytdlpExec && ytdlpExec.constants && ytdlpExec.constants.YTDLP_PATH && fs.existsSync(ytdlpExec.constants.YTDLP_PATH)) {
            return ytdlpExec.constants.YTDLP_PATH;
        }
    } catch (e) { }
    return "yt-dlp";
}

/**
 * Helper Uptime Server
 */
function getFormattedUptime() {
    const totalSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
}

/**
 * Cek apakah Port Proxy/Server sedang aktif
 */
function isPortActive(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(150);
        socket.on("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.on("timeout", () => {
            socket.destroy();
            resolve(false);
        });
        socket.on("error", () => {
            socket.destroy();
            resolve(false);
        });
        socket.connect(port, "127.0.0.1");
    });
}

/**
 * Otomatis spawn background process untuk Server API jika belum berjalan
 */
function ensureProxyServerRunning(port) {
    isPortActive(port).then((active) => {
        if (!active) {
            try {
                if (process.platform === "win32") {
                    exec(`start /b "" "${process.execPath}" "${__filename}" server ${port}`);
                } else {
                    const child = spawn(process.execPath, [__filename, "server", port.toString()], {
                        detached: true,
                        stdio: "ignore"
                    });
                    child.unref();
                }
            } catch (e) { }
        }
    }).catch(() => { });
}

/**
 * In-memory cache for direct audio URLs
 */
const directUrlCache = new Map();

/**
 * Helper untuk mengekstrak Raw Deciphered Stream URL (.googlevideo.com) secara ASYNC tanpa blocking event loop
 */
async function getRawDecipheredUrl(videoId) {
    if (!videoId) return null;

    // Check cache
    const cached = directUrlCache.get(videoId);
    if (cached && Date.now() - cached.time < 3600000) { // 1 hour TTL
        return cached.url;
    }

    let rawUrl = null;

    // Method 1: yt-dlp with Android/TV extractor args (Bypasses bot check)
    const binPath = getYtdlpBinaryPath();
    const cookiePath = getCookieFilePath();
    const cookieArg = cookiePath ? `--cookies "${cookiePath}"` : "";
    const proxyUrl = getProxyArg();
    const proxyArg = proxyUrl ? `--proxy "${proxyUrl}"` : "";
    const potProvider = process.env.POT_PROVIDER_URL || "http://bgutil-ytdlp-pot-provider.railway.internal:4416";
    const extractorArgs = potProvider
        ? `youtube:player_client=android,web;pot_provider_url=${potProvider}`
        : "youtube:player_client=android,web";

    const cmd = `"${binPath}" --no-update --cache-dir /tmp/cache --extractor-args "${extractorArgs}" ${cookieArg} ${proxyArg} -g -f "bestaudio/best" "https://www.youtube.com/watch?v=${videoId}"`;

    try {
        rawUrl = await new Promise((resolve) => {
            exec(cmd, { timeout: 8000 }, (err, stdout) => {
                if (err || !stdout) return resolve(null);
                const lines = stdout.toString().trim().split(/\r?\n/).filter(l => l.startsWith("http"));
                resolve(lines.length > 0 ? lines[lines.length - 1] : null);
            });
        });
    } catch (e) { }

    // Method 2: Public High-Speed Piped / Invidious stream API fallback
    if (!rawUrl) {
        const fallbacks = [
            `https://pipedapi.kavin.rocks/streams/${videoId}`,
            `https://api.piped.privacy.com.de/streams/${videoId}`,
            `https://inv.nadeko.net/api/v1/videos/${videoId}`
        ];
        for (const fb of fallbacks) {
            try {
                const res = await fetch(fb, { signal: AbortSignal.timeout(3000) });
                if (res.ok) {
                    const data = await res.json();
                    const audioStreams = data.audioStreams || (data.adaptiveFormats && data.adaptiveFormats.filter(f => f.type && f.type.startsWith('audio')));
                    if (audioStreams && audioStreams.length > 0) {
                        rawUrl = audioStreams[0].url;
                        break;
                    }
                }
            } catch (e) { }
        }
    }

    if (rawUrl) {
        directUrlCache.set(videoId, { url: rawUrl, time: Date.now() });
    }

    return rawUrl;
}

/**
 * Pembersih judul dan nama artis pintar
 */
function cleanTitleAndArtist(rawTitle, rawArtist) {
    let cleanTitle = rawTitle || "";
    let cleanArtist = rawArtist || "";

    cleanTitle = cleanTitle
        .replace(/\(lyrics\)/i, "")
        .replace(/\[lyrics\]/i, "")
        .replace(/\(official audio\)/i, "")
        .replace(/\(official music video\)/i, "")
        .replace(/\(official video\)/i, "")
        .replace(/\(audio\)/i, "")
        .trim();

    if (cleanTitle.includes("-")) {
        const parts = cleanTitle.split("-");
        cleanArtist = parts[0].trim();
        cleanTitle = parts.slice(1).join("-").trim();
    }

    return { title: cleanTitle, artist: cleanArtist };
}

/**
 * Helper Lirik Resmi YouTube Music (LyricFind/Musixmatch)
 */
async function getOfficialYTMusicLyrics(videoId, ytmusic, yt) {
    let lines = null;
    let provider = "YouTube Music (LyricFind / Musixmatch)";

    try {
        const lyricsObj = await yt.music.getLyrics(videoId);
        if (lyricsObj && lyricsObj.description && lyricsObj.description.text) {
            lines = lyricsObj.description.text.split("\n");
        }
        if (lyricsObj && lyricsObj.footer && lyricsObj.footer.text) {
            provider = lyricsObj.footer.text;
        }
    } catch (e) {
        try {
            lines = await ytmusic.getLyrics(videoId);
        } catch (err) { }
    }

    if (!lines) return null;

    return {
        source: provider,
        lines: lines
    };
}

/**
 * Helper Lirik Tersinkronisasi Timestamp (LRCLIB)
 */
async function getSyncedLyrics(rawTitle, rawArtist) {
    const { title, artist } = cleanTitleAndArtist(rawTitle, rawArtist);
    if (!title) return null;

    const queryCandidates = [
        { t: title, a: artist },
        { t: title.replace(/\.+$/, "").trim(), a: artist },
        { t: title.replace(/[^\w\s]/gi, "").trim(), a: artist }
    ];

    for (const q of queryCandidates) {
        try {
            const searchUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(q.t)}&artist_name=${encodeURIComponent(q.a || "")}`;
            const res = await fetch(searchUrl);
            if (res.ok) {
                const data = await res.json();
                if (data.syncedLyrics) {
                    const rawLines = data.syncedLyrics.split(/\r?\n/).filter(l => l.trim());
                    return rawLines.map(line => {
                        const match = line.match(/^\[(\d{2}):(\d{2}\.\d{2})\]\s*(.*)$/);
                        if (match) {
                            const mins = parseInt(match[1]);
                            const secs = parseFloat(match[2]);
                            const totalSeconds = Math.round((mins * 60 + secs) * 100) / 100;
                            return {
                                time: totalSeconds,
                                seconds: totalSeconds,
                                timeStr: `${match[1]}:${match[2]}`,
                                text: match[3]
                            };
                        }
                        return { text: line };
                    });
                }
            }
        } catch (e) { }
    }

    return null;
}

/**
 * Helper Cover Art
 */
function getBestCover(thumbnails) {
    if (!thumbnails || !Array.isArray(thumbnails) || thumbnails.length === 0) return null;
    const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
    return sorted[0].url;
}

/**
 * Format Item Rapi & Logis dengan Dynamic Base URL (support Chrome Android localhost)
 */
function formatItem(item, baseUrl = ALIAS_BASE_URL) {
    const type = item.videoId ? "song" : (item.artistId ? "artist" : (item.albumId ? "album" : (item.playlistId ? "playlist" : "item")));
    const title = item.title || item.name || null;
    const id = item.videoId || item.artistId || item.albumId || item.playlistId || null;

    let artistName = null;
    if (item.artists && Array.isArray(item.artists) && item.artists.length > 0) {
        const validArtists = item.artists.map(a => typeof a === "object" ? a.name : a).filter(a => a && typeof a === "string" && !/^\d+:\d{2}$/.test(a));
        if (validArtists.length > 0) artistName = validArtists.join(", ");
    }

    if (!artistName && item.artist) {
        let str = typeof item.artist === "object" ? (item.artist.name || item.artist.title) : item.artist;
        if (str && typeof str === "string" && !/^\d+:\d{2}$/.test(str)) {
            artistName = str;
        }
    }

    if (!artistName && item.author) {
        let str = typeof item.author === "object" ? item.author.name : item.author;
        if (str && typeof str === "string" && !/^\d+:\d{2}$/.test(str)) {
            artistName = str;
        }
    }

    let durationStr = null;
    if (item.duration) {
        if (typeof item.duration === "number") {
            const mins = Math.floor(item.duration / 60);
            const secs = item.duration % 60;
            durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;
        } else if (typeof item.duration === "string") {
            durationStr = item.duration;
        }
    }

    const obj = {
        type: type,
        id: id,
        title: title
    };

    if (type === "song") obj.videoId = id;
    if (type === "playlist") obj.playlistId = id;
    if (type === "album") obj.albumId = id;
    if (type === "artist") obj.artistId = id;

    if (artistName) obj.artist = artistName;
    if (item.album) obj.album = typeof item.album === "object" ? item.album.name : item.album;
    if (durationStr) obj.duration = durationStr;

    const cover = getBestCover(item.thumbnails);
    if (cover) {
        obj.coverArt = cover;
        obj.cover = cover;
        obj.thumbnail = cover;
        obj.thumbnails = [{ url: cover }];
    }

    if (item.videoId) {
        obj.webUrl = `https://music.youtube.com/watch?v=${item.videoId}`;
        obj.streamUrl = `${baseUrl}/stream/${item.videoId}`;
    } else if (item.artistId) {
        obj.webUrl = `https://music.youtube.com/channel/${item.artistId}`;
    } else if (item.albumId) {
        obj.webUrl = `https://music.youtube.com/browse/${item.albumId}`;
    } else if (item.playlistId) {
        obj.webUrl = `https://music.youtube.com/playlist?list=${item.playlistId}`;
    }

    return obj;
}

/**
 * Deteksi Jenis ID secara Otomatis
 */
function detectIdType(id) {
    if (!id) return "song";
    if (id.startsWith("UC") || id.startsWith("channel/")) return "artist";
    if (id.startsWith("MPREb") || id.startsWith("browse/")) return "album";
    if (id.startsWith("VL") || id.startsWith("PL") || id.startsWith("RD") || id.includes("playlist")) return "playlist";
    return "song";
}

// -----------------------------------------------------------------------------
// CORE BUSINESS LOGIC SERVICE
// -----------------------------------------------------------------------------
async function fetchSongDetails(videoId, ytmusic, baseUrl = ALIAS_BASE_URL) {
    const cleanId = videoId.replace(/^.*v=/, "");
    let yt = null;
    // DISABLE YOUTUBEI.JS COMPLETELY to fix event loop blocking and 10 second delay
    /*
    try {
        const Innertube = await getInnertube();
        yt = await Innertube.create({ eval: true });
    } catch (e) {
        await new Promise(r => setTimeout(r, 300));
        try {
            const Innertube = await getInnertube();
            yt = await Innertube.create({ eval: true });
        } catch (err) { }
    }
    */

    let title = null;
    let artist = null;
    let durationSeconds = null;
    let formattedDuration = null;
    let views = null;
    let coverArt = null;
    let selectedFormat = {};
    let recommendations = [];

    // Layer 1: Innertube / YouTube.js
    if (yt) {
        try {
            const musicInfo = await yt.music.getInfo(cleanId).catch(() => null) || await yt.getBasicInfo(cleanId).catch(() => null);
            if (musicInfo && musicInfo.basic_info) {
                const b = musicInfo.basic_info;
                if (b.title) title = b.title;
                if (b.author) artist = b.author;
                if (b.duration) durationSeconds = b.duration;
                if (b.view_count) views = b.view_count;
                if (b.thumbnail && Array.isArray(b.thumbnail) && b.thumbnail.length > 0) {
                    coverArt = getBestCover(b.thumbnail);
                }
                if (musicInfo.chooseFormat) {
                    const format = musicInfo.chooseFormat({ type: "audio", quality: "best" });
                    if (format) {
                        selectedFormat = {
                            container: format.mime_type ? format.mime_type.split(";")[0] : "audio/webm",
                            codec: format.mime_type ? (format.mime_type.match(/codecs="([^"]+)"/) || [])[1] || "opus" : "opus",
                            bitrate: format.bitrate ? `${Math.round(format.bitrate / 1000)} kbps` : "160 kbps",
                            sampleRate: format.audio_sample_rate ? `${format.audio_sample_rate} Hz` : "48000 Hz"
                        };
                    }
                }
            }
        } catch (e) { }
    }

    // Layer 2: YouTube OEmbed API (Instant & 100% Reliable for Title, Artist, & Cover)
    if (!title || !artist || !coverArt) {
        try {
            const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${cleanId}&format=json`);
            if (oembedRes.status === 200) {
                const oembed = await oembedRes.json();
                if (!title) title = oembed.title || null;
                if (!artist && oembed.author_name) {
                    artist = oembed.author_name.replace(/ - Topic$/, "").trim();
                }
                if (!coverArt) {
                    coverArt = `https://i.ytimg.com/vi/${cleanId}/maxresdefault.jpg`;
                }
            }
        } catch (e) { }
    }

    // Layer 3: YouTube Watch Page HTML Scraper for View Count & Duration
    if (!durationSeconds || !views) {
        try {
            const pageRes = await fetch(`https://www.youtube.com/watch?v=${cleanId}`, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept-Language": "en-US,en;q=0.9"
                }
            });
            if (pageRes.status === 200) {
                const html = await pageRes.text();
                const durMatch = html.match(/"approxDurationMs":"(\d+)"/) || html.match(/"lengthSeconds":"(\d+)"/);
                if (durMatch && !durationSeconds) {
                    const rawMs = parseInt(durMatch[1]);
                    durationSeconds = Math.round(rawMs / (durMatch[1].length > 6 ? 1000 : 1));
                }
                if (!durationSeconds) {
                    const lenTextMatch = html.match(/"lengthText":\{.*?"simpleText":"([\d:]+)"\}/);
                    if (lenTextMatch && lenTextMatch[1]) {
                        formattedDuration = lenTextMatch[1];
                        const parts = formattedDuration.split(":").map(Number);
                        durationSeconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
                    }
                }
                const viewsMatch = html.match(/"viewCount":"(\d+)"/) || html.match(/([\d,]+)\s+views/);
                if (viewsMatch && !views) {
                    views = parseInt(viewsMatch[1].replace(/,/g, "")) || viewsMatch[1];
                }
            }
        } catch (e) { }
    }

    // Layer 4: YTMusic Search Fallback for Duration & Recommendations
    if (title) {
        try {
            const searchRes = await ytmusic.search(`${artist || ''} ${title}`.trim());
            if (searchRes && searchRes.length > 0) {
                const match = searchRes.find(s => s.videoId === cleanId) || searchRes[0];
                if (!artist && match.artist) artist = typeof match.artist === 'object' ? match.artist.name : match.artist;
                if (!durationSeconds && match.duration) {
                    if (typeof match.duration === 'number') durationSeconds = match.duration;
                    else formattedDuration = match.duration;
                }
                recommendations = searchRes.filter(i => i.videoId && i.videoId !== cleanId).slice(0, 5).map(i => formatItem(i, baseUrl));
            }
        } catch (e) { }
    }

    if (durationSeconds && !formattedDuration) {
        const mins = Math.floor(durationSeconds / 60);
        const secs = durationSeconds % 60;
        formattedDuration = `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    if (!coverArt) {
        coverArt = `https://i.ytimg.com/vi/${cleanId}/hqdefault.jpg`;
    }

    const streamUrl = `${baseUrl}/stream/${cleanId}`;
    const officialYtmLyrics = await getOfficialYTMusicLyrics(cleanId, ytmusic, yt);
    const syncedLyrics = await getSyncedLyrics(title, artist);

    return {
        status: "success",
        command: "song",
        type: "song",
        data: {
            id: cleanId,
            title: title || "Unknown Title",
            artist: artist || "Unknown Artist",
            duration: formattedDuration,
            durationSeconds: durationSeconds ? Number(durationSeconds) : null,
            views: views ? Number(String(views).replace(/,/g, '')) : null,
            coverArt: coverArt,
            webUrl: `https://music.youtube.com/watch?v=${cleanId}`,
            streamUrl: streamUrl,
            audioQuality: Object.keys(selectedFormat).length > 0 ? selectedFormat : {
                container: "audio/webm",
                codec: "opus",
                bitrate: "160 kbps",
                sampleRate: "48000 Hz"
            },
            lyrics: {
                hasOfficial: !!officialYtmLyrics,
                hasSynced: !!syncedLyrics,
                official: officialYtmLyrics,
                synced: syncedLyrics
            },
            relatedSongs: recommendations
        }
    };
}

async function fetchArtistDetails(artistId, ytmusic, baseUrl = ALIAS_BASE_URL) {
    const cleanId = artistId.replace(/^.*channel\//, "");
    let artist = { name: "", topSongs: [], albums: [], thumbnails: [] };
    try {
        const res = await ytmusic.getArtist(cleanId);
        if (res) artist = res;
    } catch (e) { }

    // Fallback if ytmusic-api getArtist is broken
    if (!artist.name || !artist.topSongs || artist.topSongs.length === 0) {
        try {
            const html = await (await fetch(`https://music.youtube.com/channel/${cleanId}`)).text();
            const nameMatch = html.match(/<title>(.*?)\s-\sYouTube Music<\/title>/);
            artist.name = nameMatch ? nameMatch[1] : "Artist";

            const thumbMatch = html.match(/<meta property="og:image" content="(.*?)"/);
            if (thumbMatch) artist.thumbnails = [{ url: thumbMatch[1] }];

            const searchRes = await ytmusic.search(artist.name);
            artist.topSongs = searchRes.filter(x => x.type === "SONG" || x.type === "VIDEO").slice(0, 10);
            artist.albums = searchRes.filter(x => x.type === "ALBUM").slice(0, 5);
        } catch (e) {
            console.error("Artist Fallback Error:", e);
        }
    }

    return {
        status: "success",
        command: "artist",
        type: "artist",
        data: {
            id: cleanId,
            name: artist.name || null,
            webUrl: `https://music.youtube.com/channel/${cleanId}`,
            coverArt: getBestCover(artist.thumbnails),
            topSongs: (artist.songs || artist.topSongs || []).slice(0, 10).map(s => ({
                id: s.videoId || null,
                title: s.title || s.name,
                artist: artist.name || null,
                album: s.album ? (typeof s.album === "object" ? s.album.name : s.album) : null,
                duration: s.duration || null,
                coverArt: getBestCover(s.thumbnails),
                webUrl: s.videoId ? `https://music.youtube.com/watch?v=${s.videoId}` : null,
                streamUrl: s.videoId ? `${baseUrl}/stream/${s.videoId}` : null
            })),
            albums: (artist.albums || []).slice(0, 5).map(a => ({
                id: a.albumId || null,
                title: a.title || a.name,
                year: a.year || null,
                coverArt: getBestCover(a.thumbnails),
                webUrl: a.albumId ? `https://music.youtube.com/browse/${a.albumId}` : null
            }))
        }
    };
}

async function fetchAlbumDetails(albumId, ytmusic, baseUrl = ALIAS_BASE_URL) {
    const cleanId = albumId.replace(/^.*browse\//, "");

    // RDCLAK / VLRD / PL are playlists in YouTube Music
    if (cleanId.startsWith("RD") || cleanId.startsWith("VLRD") || cleanId.startsWith("PL") || cleanId.startsWith("VLPL")) {
        return await fetchPlaylistDetails(cleanId, ytmusic, baseUrl);
    }

    let album = null;
    try {
        album = await ytmusic.getAlbum(cleanId);
    } catch (e) { }

    if (!album || (!album.songs && !album.tracks) || (album.songs && album.songs.length === 0)) {
        try {
            album = await ytmusic.getPlaylist(cleanId);
        } catch (e) { }
    }

    let rawSongs = (album && (album.songs || album.tracks)) ? (album.songs || album.tracks) : [];
    if (rawSongs.length === 0) {
        try {
            const vids = await ytmusic.getPlaylistVideos(cleanId);
            if (vids && vids.length > 0) rawSongs = vids;
        } catch (e) { }
    }

    let albumTitle = album ? (album.name || album.title || "Album") : "Album";
    let albumAuthor = album && album.artist ? (typeof album.artist === 'object' ? album.artist.name : album.artist) : null;
    let albumCover = album ? getBestCover(album.thumbnails) : null;

    const tracks = rawSongs.map((t, idx) => {
        const vid = t.videoId || t.id || null;
        const trackCover = vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : (getBestCover(t.thumbnails) || albumCover);

        let trackTitle = t.title || t.name || "Song";
        let trackArtist = t.artist ? (typeof t.artist === "object" ? (t.artist.name || t.artist.title) : t.artist) : (albumAuthor || null);

        if (trackTitle && trackTitle.includes(" - ")) {
            const cleaned = cleanTitleAndArtist(trackTitle, trackArtist);
            trackTitle = cleaned.title;
            trackArtist = cleaned.artist;
        }

        return {
            trackNumber: idx + 1,
            id: vid,
            videoId: vid,
            title: trackTitle,
            artist: trackArtist,
            duration: t.duration ? (typeof t.duration === 'number' ? `${Math.floor(t.duration / 60)}:${(t.duration % 60).toString().padStart(2, '0')}` : t.duration) : null,
            coverArt: trackCover,
            cover: trackCover,
            thumbnail: trackCover,
            thumbnails: [{ url: trackCover }],
            webUrl: vid ? `https://music.youtube.com/watch?v=${vid}` : null,
            streamUrl: vid ? `${baseUrl}/stream/${vid}` : null
        };
    });

    if (!albumCover && tracks.length > 0 && tracks[0].coverArt) {
        albumCover = tracks[0].coverArt;
    }

    return {
        status: true,
        command: "album",
        type: "album",
        result: {
            id: cleanId,
            title: albumTitle,
            artist: albumAuthor,
            year: album ? album.year : null,
            totalTracks: tracks.length,
            coverArt: albumCover,
            cover: albumCover,
            thumbnail: albumCover,
            thumbnails: (album && album.thumbnails && album.thumbnails.length > 0) ? album.thumbnails : (albumCover ? [{ url: albumCover }] : []),
            webUrl: `https://music.youtube.com/browse/${cleanId}`,
            songs: tracks
        }
    };
}

async function fetchPlaylistDetails(playlistId, ytmusic, baseUrl = ALIAS_BASE_URL) {
    let cleanId = playlistId.replace(/^.*list=/, "");
    // YouTube Music requires VL prefix for RDCLAK radio playlists
    const lookupId = cleanId.startsWith("RD") ? ("VL" + cleanId) : cleanId;

    let rawVideos = [];
    let title = null;
    let author = null;
    let cover = null;
    let playlist = null;

    try {
        playlist = await ytmusic.getPlaylist(lookupId);
        if (playlist) {
            title = playlist.name || playlist.title || null;
            author = playlist.artist ? (playlist.artist.name || playlist.artist) : (playlist.author ? (playlist.author.name || playlist.author) : null);
            cover = getBestCover(playlist.thumbnails);
        }
    } catch (e) { }

    try {
        const videos = await ytmusic.getPlaylistVideos(lookupId);
        if (videos && videos.length > 0) {
            rawVideos = videos;
        }
    } catch (e) { }

    if (rawVideos.length === 0 && lookupId !== cleanId) {
        try {
            const videos = await ytmusic.getPlaylistVideos(cleanId);
            if (videos && videos.length > 0) rawVideos = videos;
        } catch (e) { }
    }

    if (rawVideos.length === 0) {
        try {
            const alb = await ytmusic.getAlbum(cleanId);
            if (alb && (alb.songs || alb.tracks)) {
                rawVideos = alb.songs || alb.tracks;
                if (!title) title = alb.name || alb.title;
                if (!author) author = alb.artist;
                if (!cover) cover = getBestCover(alb.thumbnails);
            }
        } catch (e) { }
    }

    // Fallback if YouTube returns 0 songs (e.g. RDCLAK radios)
    if (rawVideos.length === 0) {
        try {
            const q = (title && title !== "Playlist") ? title : cleanId.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
            if (q) {
                const sRes = await ytmusic.search(q);
                const songMatches = sRes.filter(x => x.type === "SONG" || x.type === "VIDEO" || x.videoId);
                if (songMatches.length > 0) rawVideos = songMatches.slice(0, 25);
            }
        } catch (e) { }
    }

    const tracks = rawVideos.map((t, idx) => {
        const vid = t.videoId || t.id || null;
        const trackCover = vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : (getBestCover(t.thumbnails) || cover);
        let trackTitle = t.name || t.title || "Song";
        let trackArtist = t.artist ? (typeof t.artist === "object" ? (t.artist.name || t.artist.title) : t.artist) : (t.author ? (typeof t.author === 'object' ? t.author.name : t.author) : author);

        if (trackTitle && trackTitle.includes(" - ")) {
            const cleaned = cleanTitleAndArtist(trackTitle, trackArtist);
            trackTitle = cleaned.title;
            trackArtist = cleaned.artist;
        }

        return {
            trackNumber: idx + 1,
            id: vid,
            videoId: vid,
            title: trackTitle,
            artist: trackArtist,
            duration: t.duration ? (typeof t.duration === 'number' ? `${Math.floor(t.duration / 60)}:${(t.duration % 60).toString().padStart(2, '0')}` : t.duration) : null,
            coverArt: trackCover,
            cover: trackCover,
            thumbnail: trackCover,
            thumbnails: [{ url: trackCover }],
            webUrl: vid ? `https://music.youtube.com/watch?v=${vid}` : null,
            streamUrl: vid ? `${baseUrl}/stream/${vid}` : null
        };
    });

    if (!cover && tracks.length > 0 && tracks[0].coverArt) {
        cover = tracks[0].coverArt;
    }

    return {
        status: true,
        command: "playlist",
        type: "playlist",
        result: {
            id: cleanId,
            title: title || "Playlist",
            author: author,
            totalTracks: tracks.length,
            coverArt: cover,
            cover: cover,
            thumbnail: cover,
            thumbnails: (playlist && playlist.thumbnails && playlist.thumbnails.length > 0) ? playlist.thumbnails : (cover ? [{ url: cover }] : []),
            webUrl: `https://music.youtube.com/playlist?list=${cleanId}`,
            songs: tracks
        }
    };
}

let globalHomeCache = null;
let globalHomeCacheTime = 0;
let globalHomeCacheTTL = 0;

async function fetchSearchResults(query, page = 1, limit = 20, ytmusic, baseUrl = ALIAS_BASE_URL) {
    if (query.toLowerCase() === "home") {
        const now = Date.now();

        // Cek jika cache masih kosong ATAU sudah lewat batas waktu acaknya
        if (!globalHomeCache || (now - globalHomeCacheTime > globalHomeCacheTTL)) {
            const customSections = [
                { title: "Top Hits Indonesia 2026", playlistId: "PLkbaG37V-vG8Fib_qvgOKf3qzqA0SUk59" },
                { title: "Hits Barat Terpopuler", playlistId: "PLFcGX84jKOu59GrHP13_mfxGRCZkWyGbS" },
                { title: "Spotify Top Hits Indo", playlistId: "PLVCtLXKko6G0kUE_gOAtpKv09MKHZzL2J" },
                { title: "Nostalgia Pop 2000an", playlistId: "PLvjknnL_zXazoyoGJPdOq-8uktQ9EXY-q" },
                { title: "TikTok Hits Viral", playlistId: "PLx0sYbCqOb8RBIUi2Y6GRtgNtD1nJM43X" },
                { title: "Barat Santai & Akustik", playlistId: "PL-uXb8FFnPtoKQomQNyP5_VaenuaHjm3c" }
            ];

            let newCache = [];

            for (const sec of customSections) {
                try {
                    const rawVideos = await ytmusic.getPlaylistVideos(sec.playlistId);
                    if (rawVideos && rawVideos.length > 0) {
                        const onlySongs = rawVideos.filter(item => item.videoId);
                        if (onlySongs.length > 0) {
                            // Acak urutan (Fisher-Yates Shuffle) biar fresh setiap kali refresh cache
                            let shuffled = [...onlySongs];
                            for (let i = shuffled.length - 1; i > 0; i--) {
                                const j = Math.floor(Math.random() * (i + 1));
                                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                            }

                            newCache.push({
                                sectionTitle: sec.title,
                                items: shuffled.slice(0, 20)
                            });
                        }
                    }
                } catch (e) { }
            }

            if (newCache.length > 0) {
                globalHomeCache = newCache;
                globalHomeCacheTime = now;
                // TTL Acak: Minimal 10 menit (600,000 ms), Maksimal 60 menit (3,600,000 ms)
                const minMs = 10 * 60 * 1000;
                const maxMs = 60 * 60 * 1000;
                globalHomeCacheTTL = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
                console.log(`[Cache Update] API Home refreshed. Next update in ${Math.round(globalHomeCacheTTL / 60000)} minutes.`);
            }
        }

        // Kalau gagal fetch atau array kosong, pakai cache lama jika ada
        const targetData = globalHomeCache || [];

        const totalSections = targetData.length;
        const totalPages = Math.ceil(totalSections / 3) || 1;
        const startIndex = (page - 1) * 3;
        const pageSections = targetData.slice(startIndex, startIndex + 3);

        // Map formatItem dengan baseUrl saat request ditarik agar baseUrl selalu akurat sesuai permintaan saat ini
        const formattedSections = pageSections.map(sec => ({
            sectionTitle: sec.sectionTitle,
            items: sec.items.map(item => formatItem(item, baseUrl))
        }));

        return {
            status: "success",
            command: "search",
            mode: "home",
            page: page,
            totalPages: totalPages,
            totalSections: totalSections,
            data: formattedSections
        };

    } else if (query.toLowerCase() === "trending" || query.toLowerCase() === "charts") {
        // Tembak ID Playlist Resmi (PL) dan Mix/Campur secara selang-seling (Interleave)
        let rawResults = [];
        try {
            const indoHits = await ytmusic.getPlaylistVideos("PLkbaG37V-vG8Fib_qvgOKf3qzqA0SUk59").catch(() => []);
            const baratHits = await ytmusic.getPlaylistVideos("PLFcGX84jKOu59GrHP13_mfxGRCZkWyGbS").catch(() => []);

            const maxLen = Math.max(indoHits.length, baratHits.length);
            for (let i = 0; i < maxLen; i++) {
                if (indoHits[i] && indoHits[i].videoId) rawResults.push(indoHits[i]);
                if (baratHits[i] && baratHits[i].videoId) rawResults.push(baratHits[i]);
            }
        } catch (e) { }

        const formattedResults = rawResults.map(item => formatItem(item, baseUrl));

        const totalItems = formattedResults.length;
        const totalPages = Math.ceil(totalItems / limit) || 1;
        const startIndex = (page - 1) * limit;
        const pageItems = formattedResults.slice(startIndex, startIndex + limit);

        return {
            status: "success",
            command: "trending",
            page: page,
            totalPages: totalPages,
            totalResults: totalItems,
            data: pageItems
        };
    } else {
        const rawResults = await ytmusic.search(query);
        const formattedResults = rawResults.map(item => formatItem(item, baseUrl));

        const totalItems = formattedResults.length;
        const totalPages = Math.ceil(totalItems / limit) || 1;
        const startIndex = (page - 1) * limit;
        const pageItems = formattedResults.slice(startIndex, startIndex + limit);

        return {
            status: "success",
            command: "search",
            query: query,
            page: page,
            totalPages: totalPages,
            totalResults: totalItems,
            data: pageItems
        };
    }
}

// -----------------------------------------------------------------------------
// FULL HYBRID REST API SERVER & STREAM PROXY (ELEGANT ENTERPRISE API INDEX)
// -----------------------------------------------------------------------------
function startRestApiServer(port) {
    const serverPort = port || PROXY_PORT;
    const ytmusic = new YTMusic();

    let isInit = false;
    async function getYTInstance() {
        if (!isInit) {
            try {
                await ytmusic.initialize();
                isInit = true;
            } catch (e) {
                await new Promise(r => setTimeout(r, 300));
                await ytmusic.initialize();
                isInit = true;
            }
        }
        return ytmusic;
    }

    const requestHandler = async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        const host = req.headers.host || `localhost:${serverPort}`;
        const proto = req.headers["x-forwarded-proto"] || (req.connection && req.connection.encrypted ? "https" : "http");
        const currentBaseUrl = `${proto}://${host}`;

        const parsedUrl = new URL(req.url, currentBaseUrl);
        const pathname = parsedUrl.pathname;
        let query = Object.fromEntries(parsedUrl.searchParams);

        if (req.method === "POST") {
            try {
                let body = "";
                for await (const chunk of req) {
                    body += chunk.toString();
                }
                if (body) {
                    const jsonBody = JSON.parse(body);
                    query = { ...query, ...jsonBody };
                }
            } catch (e) {
                console.error("Failed to parse POST body:", e.message);
            }
        }

        // 1. ENDPOINT STREAM AUDIO ULTRA STABLE: /stream/:videoId & /play/:videoId
        const streamMatch = pathname.match(/\/(stream|play)\/([a-zA-Z0-9_-]+)/);
        if (streamMatch) {
            const videoId = streamMatch[2];

            // FAST-PATH: Instant Direct Audio Decipher (~100-300ms) with direct GoogleVideo CDN streaming
            try {
                const rawUrl = await getRawDecipheredUrl(videoId);
                if (rawUrl) {
                    res.writeHead(302, {
                        "Location": rawUrl,
                        "Access-Control-Allow-Origin": "*",
                        "Cache-Control": "public, max-age=3600"
                    });
                    return res.end();
                }
            } catch (e) { }

            let isPiped = false;
            let fallbackCalled = false;
            let lastError = "";

            function triggerFallback(reason = "") {
                if (!isPiped && !fallbackCalled) {
                    fallbackCalled = true;
                    if (reason) lastError += ` [${reason}]`;
                    fallbackFetchStream();
                }
            }

            const binPath = getYtdlpBinaryPath();
            const binExists = fs.existsSync(binPath);
            const cookiePath = getCookieFilePath();
            const potProvider = process.env.POT_PROVIDER_URL || "http://bgutil-ytdlp-pot-provider.railway.internal:4416";
            const extractorArgs = potProvider
                ? `youtube:player_client=android,web;pot_provider_url=${potProvider}`
                : "youtube:player_client=android,web";

            const commonArgs = [
                "--no-update",
                "--cache-dir", "/tmp/cache",
                "--extractor-args", extractorArgs
            ];

            if (cookiePath) {
                commonArgs.push("--cookies", cookiePath);
            }

            const proxyUrl = getProxyArg();
            if (proxyUrl) {
                commonArgs.push("--proxy", proxyUrl);
            }

            commonArgs.push(
                "-o", "-",
                "-f", "bestaudio/best",
                `https://www.youtube.com/watch?v=${videoId}`
            );

            let ytdlpProc = null;
            try {
                ytdlpProc = spawn(binPath, commonArgs);
            } catch (e) {
                lastError += ` spawn_err: ${e.message}`;
            }

            if (!ytdlpProc) {
                triggerFallback("Proc null");
            } else {
                // Auto cleanup child process if client closes request/disconnects
                res.on("close", () => {
                    if (ytdlpProc) {
                        try { ytdlpProc.kill(); } catch (e) { }
                    }
                });

                ytdlpProc.stderr.on("data", (chunk) => {
                    lastError += chunk.toString();
                });

                ytdlpProc.on("error", (err) => {
                    lastError += ` proc_error: ${err.message}`;
                    triggerFallback("Proc error event");
                });

                ytdlpProc.stdout.once("data", (firstChunk) => {
                    if (!isPiped && !res.headersSent) {
                        isPiped = true;
                        res.writeHead(200, {
                            "Content-Type": "audio/webm",
                            "Accept-Ranges": "bytes",
                            "Cache-Control": "no-cache, no-store, must-revalidate",
                            "Connection": "keep-alive"
                        });
                        res.write(firstChunk);
                        ytdlpProc.stdout.pipe(res, { end: true });
                    }
                });

                ytdlpProc.stdout.on("end", () => {
                    if (!isPiped) {
                        triggerFallback("Stdout ended without data");
                    }
                });

                setTimeout(() => {
                    if (!isPiped) {
                        try { if (ytdlpProc) ytdlpProc.kill(); } catch (e) { }
                        triggerFallback("Timeout 25s reached");
                    }
                }, 25000);
            }

            async function fallbackFetchStream() {
                if (res.headersSent) return;
                try {
                    const rawUrl = await getRawDecipheredUrl(videoId);
                    if (rawUrl) {
                        const response = await fetch(rawUrl, {
                            headers: {
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                                "Referer": "https://music.youtube.com/"
                            }
                        });

                        const status = response.status === 403 ? 200 : response.status;
                        res.writeHead(status, {
                            "Content-Type": response.headers.get("content-type") || "audio/webm",
                            "Accept-Ranges": "bytes"
                        });

                        if (response.body) {
                            const reader = response.body.getReader();
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                res.write(value);
                            }
                        }
                        res.end();
                        return;
                    }
                } catch (err) {
                    lastError += ` fallback_err: ${err.message}`;
                }

                if (!res.headersSent) {
                    const hasBotBlock = lastError.includes("Sign in to confirm you’re not a bot") || lastError.includes("Too Many Requests");
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        status: "error",
                        message: "Gagal memutar audio stream.",
                        hint: hasBotBlock ? "IP Railway sedang terkena verifikasi bot oleh YouTube. Tambahkan variabel 'YOUTUBE_COOKIES' atau 'YOUTUBE_COOKIES_BASE64' di Railway Variables / buat file cookies.txt untuk melewati bot block 100%." : undefined,
                        debug: {
                            videoId: videoId,
                            binPath: binPath,
                            binExists: binExists,
                            hasCookies: !!cookiePath,
                            hasProxy: !!proxyUrl,
                            details: lastError.trim() || "No detailed stderr logged"
                        }
                    }, null, 2));
                }
            }

            return;
        }

        // Helper JSON Responder
        function sendJson(statusCode, data) {
            res.writeHead(statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data, null, 2));
        }

        // 1. ROOT DOCUMENTATION & STATUS (ELEGANT ENTERPRISE API INDEX - INSTANT RESPONSE)
        if (pathname === "/" || pathname === "/api") {
            return sendJson(200, {
                status: "success",
                message: "Success! REST API is Operational",
                creator: "zett",
                server: {
                    name: "welcome rest api YT MUSIK by zet",
                    version: "1.0.0",
                    environment: process.env.NODE_ENV || "production",
                    status: "online",
                    port: serverPort,
                    uptime: getFormattedUptime(),
                    timestamp: new Date().toISOString(),
                    documentation: "https://github.com/lannreal/turuajakaliyak"
                },
                features: [
                    "Zero-Redirect Audio Stream Proxy",
                    "Dual Lyrics Engine (Official YTM + Synced Timestamp LRCLIB)",
                    "Comprehensive Search & Full Exploration (Home/Trending)",
                    "Universal CORS Enabled for Cross-Platform Integration"
                ],
                endpoints: [
                    {
                        category: "Core Music API",
                        name: "Song Detail & Lyrics",
                        method: "GET",
                        path: "/api/song/:videoId",
                        exampleUrl: `${currentBaseUrl}/api/song/k1BfsO0mxWQ`,
                        description: "Mengambil detail lagu lengkap, audio specs, lirik ganda (Resmi & Sync Karaoke), dan rekomendasi lagu terkait."
                    },
                    {
                        category: "Core Music API",
                        name: "Artist Profile",
                        method: "GET",
                        path: "/api/artist/:artistId",
                        exampleUrl: `${currentBaseUrl}/api/artist/UCoy8sTKrImqfSq6TYOSW81A`,
                        description: "Mengambil profil artis, foto sampul HD, 10 lagu terpopuler, dan daftar album."
                    },
                    {
                        category: "Core Music API",
                        name: "Album Tracklist",
                        method: "GET",
                        path: "/api/album/:albumId",
                        exampleUrl: `${currentBaseUrl}/api/album/MPREb_N8YZSqmQiv4`,
                        description: "Mengambil daftar trek album lengkap beserta urutan lagu dan direct stream URL."
                    },
                    {
                        category: "Core Music API",
                        name: "Playlist Tracklist",
                        method: "GET",
                        path: "/api/playlist/:playlistId",
                        exampleUrl: `${currentBaseUrl}/api/playlist/PL3LUUT1_qZN5G6hOlPm64aCe6A3yIwZKh`,
                        description: "Mengambil detail playlist publik dan seluruh trek lagu di dalamnya."
                    },
                    {
                        category: "Discovery API",
                        name: "Search Music",
                        method: "GET",
                        path: "/api/search?q=<query>&page=1",
                        exampleUrl: `${currentBaseUrl}/api/search?q=Sheila+on+7&page=1`,
                        description: "Pencarian cerdas lagu, artis, atau album dengan dukungan paginasi."
                    },
                    {
                        category: "Discovery API",
                        name: "Home Recommendations",
                        method: "GET",
                        path: "/api/home?page=1",
                        exampleUrl: `${currentBaseUrl}/api/home?page=1`,
                        description: "Mengambil beranda rekomendasi musik terkini dari YouTube Music."
                    },
                    {
                        category: "Discovery API",
                        name: "Trending Charts",
                        method: "GET",
                        path: "/api/trending?page=1",
                        exampleUrl: `${currentBaseUrl}/api/trending?page=1`,
                        description: "Mengambil daftar lagu tangga teratas (Top Charts) yang sedang hangat."
                    },
                    {
                        category: "Streaming Proxy API",
                        name: "Direct Audio Stream Proxy",
                        method: "GET",
                        path: "/stream/:videoId",
                        exampleUrl: `${currentBaseUrl}/stream/k1BfsO0mxWQ`,
                        description: "Zero-redirect audio streaming proxy. Menyalurkan data suara mentah secara privat tanpa menyamarkan IP pengguna."
                    }
                ]
            });
        }

        try {
            const ytInst = await getYTInstance();

            // 2. ENDPOINT SEARCH
            if (pathname === "/api/search") {
                const q = query.q || query.query || "Sheila on 7";
                const page = parseInt(query.page || 1);
                const result = await fetchSearchResults(q, page, 20, ytInst, currentBaseUrl);

                // Compatibility Layer untuk star-cloud.web.id
                const dataArr = result.data || [];
                const formattedData = {
                    songs: dataArr.filter(i => i.type === 'song'),
                    albums: dataArr.filter(i => i.type === 'album'),
                    playlists: dataArr.filter(i => i.type === 'playlist'),
                    artists: dataArr.filter(i => i.type === 'artist')
                };
                return sendJson(200, { status: true, result: formattedData });
            }

            // 3. ENDPOINT SONG
            const songMatch = pathname.match(/\/api\/song\/([a-zA-Z0-9_-]+)/);
            if (songMatch || pathname === "/api/song") {
                const songId = songMatch ? songMatch[1] : (query.id || "k1BfsO0mxWQ");
                const result = await fetchSongDetails(songId, ytInst, currentBaseUrl);
                return sendJson(200, { status: true, result: result.data || result });
            }

            // 4. ENDPOINT ARTIST
            const artistMatch = pathname.match(/\/api\/artist\/([a-zA-Z0-9_-]+)/);
            if (artistMatch || pathname === "/api/artist") {
                const artistId = artistMatch ? artistMatch[1] : (query.id || "UCoy8sTKrImqfSq6TYOSW81A");
                const result = await fetchArtistDetails(artistId, ytInst, currentBaseUrl);
                return sendJson(200, { status: true, result: result.data || result });
            }

            // 5. ENDPOINT ALBUM
            const albumMatch = pathname.match(/\/api\/album\/([a-zA-Z0-9_-]+)/);
            if (albumMatch || pathname === "/api/album") {
                const albumId = albumMatch ? albumMatch[1] : (query.id || "MPREb_N8YZSqmQiv4");
                const result = await fetchAlbumDetails(albumId, ytInst, currentBaseUrl);
                const finalData = (result && result.result) ? result.result : (result.data || result);
                return sendJson(200, { status: true, result: finalData });
            }

            // 6. ENDPOINT PLAYLIST
            const playlistMatch = pathname.match(/\/api\/playlist\/([a-zA-Z0-9_-]+)/);
            if (playlistMatch || pathname === "/api/playlist") {
                const playlistId = playlistMatch ? playlistMatch[1] : (query.id || "PL3LUUT1_qZN5G6hOlPm64aCe6A3yIwZKh");
                const result = await fetchPlaylistDetails(playlistId, ytInst, currentBaseUrl);
                const finalData = (result && result.result) ? result.result : (result.data || result);
                return sendJson(200, { status: true, result: finalData });
            }

            // 7. ENDPOINT HOME
            if (pathname === "/api/home") {
                const page = parseInt(query.page || 1);
                const result = await fetchSearchResults("home", page, 20, ytInst, currentBaseUrl);
                return sendJson(200, { status: true, result: result.data || result });
            }

            // 8. ENDPOINT TRENDING
            if (pathname === "/api/trending") {
                const page = parseInt(query.page || 1);
                const result = await fetchSearchResults("trending", page, 20, ytInst, currentBaseUrl);
                return sendJson(200, { status: true, result: result.data || result });
            }

            // 9. ENDPOINT SUGGEST (Autocomplete)
            if (pathname === "/api/suggest") {
                const q = query.q || query.query || "";
                let suggestions = [q];
                try {
                    const rawSuggestions = await ytInst.getSearchSuggestions(q);
                    if (rawSuggestions && rawSuggestions.length > 0) {
                        suggestions = rawSuggestions;
                    } else {
                        suggestions = [q, q + " song", q + " official"];
                    }
                } catch (e) {
                    suggestions = [q, q + " lirik", q + " mp3"];
                }
                return sendJson(200, { status: true, result: suggestions });
            }

            // 10. ENDPOINT YTPLAY (Optimized)
            if (pathname === "/api/ytplay") {
                const url = query.url || query.query || "";
                let videoId = url.replace(/^.*v=/, "").split("&")[0];
                if (!videoId) videoId = "k1BfsO0mxWQ";

                let audioUrl = currentBaseUrl + "/stream/" + videoId;
                const data = {
                    audioUrl: audioUrl,
                    downloadUrl: audioUrl,
                    download: { audio: audioUrl }
                };
                return sendJson(200, { status: true, result: data });
            }

            // 11. ENDPOINT LYRICS
            if (pathname === "/api/lyrics") {
                const id = query.id || query.v;
                if (!id) return sendJson(400, { status: false, message: "Missing id" });
                const result = await fetchSongDetails(id, ytInst, currentBaseUrl);
                const data = result.data || result;

                let lines = [];
                let type = "TEXT";

                if (data.lyrics) {
                    if (data.lyrics.hasSynced && data.lyrics.synced) {
                        lines = data.lyrics.synced;
                        type = "SYNCED";
                    } else if (data.lyrics.hasOfficial && data.lyrics.official && data.lyrics.official.lines) {
                        lines = data.lyrics.official.lines.map(text => ({ text: text }));
                        type = "TEXT";
                    }
                }

                return sendJson(200, { status: true, result: { lyrics: { lines: lines, type: type } } });
            }

            return sendJson(404, { status: "error", message: `Endpoint '${pathname}' tidak ditemukan.` });

        } catch (err) {
            return sendJson(500, { status: "error", message: err.message });
        }
    }

    const server = http.createServer(requestHandler);
    server.on("error", (err) => {
        console.error("Server Error:", err.message);
        process.exit(1);
    });
    server.listen(serverPort, "0.0.0.0", () => {
        console.log(JSON.stringify({
            status: "running",
            message: `Server REST API YouTube Music aktif pada http://localhost:${serverPort}`,
            port: serverPort
        }, null, 2));
    });
}

// -----------------------------------------------------------------------------
// MAIN ENTRY POINT
// -----------------------------------------------------------------------------
async function main() {
    const rawArgs = process.argv.slice(2);

    let customPort = null;
    let customOutputFile = null;
    let args = [];

    for (let i = 0; i < rawArgs.length; i++) {
        if ((rawArgs[i] === "--port" || rawArgs[i] === "-p") && rawArgs[i + 1]) {
            customPort = parseInt(rawArgs[i + 1]);
            i++;
        } else if ((rawArgs[i] === "--out" || rawArgs[i] === "-o") && rawArgs[i + 1]) {
            customOutputFile = rawArgs[i + 1];
            i++;
        } else {
            args.push(rawArgs[i]);
        }
    }

    if (customPort) {
        PROXY_PORT = customPort;
        ALIAS_BASE_URL = `http://localhost:${PROXY_PORT}`;
    }

    if (args[0] === "server" || args[0] === "api" || args[0] === "start") {
        const portToUse = args[1] && !isNaN(args[1]) ? parseInt(args[1]) : PROXY_PORT;
        startRestApiServer(portToUse);
        return;
    }

    ensureProxyServerRunning(PROXY_PORT);

    if (args.length === 0 && process.env.PORT) {
        startRestApiServer(PROXY_PORT);
        return;
    }

    if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
        const helpJson = {
            status: "info",
            message: "YouTube Music Scraper & REST API 2-in-1 Hybrid",
            usage: "node index.js <command> [args]",
            commands: [
                {
                    command: "node index.js server [port]",
                    description: "Jalankan Server REST API Interaktif",
                    example: "node index.js server 3000"
                },
                {
                    command: "node index.js search <judul/artis>",
                    description: "Cari lagu, artis, atau album di CLI",
                    example: "node index.js search \"Sheila on 7\""
                },
                {
                    command: "node index.js song <videoId>",
                    description: "Ambil detail lagu, link audio stream, & lirik di CLI",
                    example: "node index.js song k1BfsO0mxWQ"
                },
                {
                    command: "node index.js home",
                    description: "Lihat beranda rekomendasi di CLI",
                    example: "node index.js home"
                },
                {
                    command: "node index.js artist <artistId>",
                    description: "Lihat profil artis di CLI",
                    example: "node index.js artist UCoy8sTKrImqfSq6TYOSW81A"
                },
                {
                    command: "node index.js album <albumId>",
                    description: "Lihat daftar lagu album di CLI",
                    example: "node index.js album MPREb_N8YZSqmQiv4"
                },
                {
                    command: "node index.js playlist <playlistId>",
                    description: "Lihat daftar lagu playlist di CLI",
                    example: "node index.js playlist PL3LUUT1_qZN5G6hOlPm64aCe6A3yIwZKh"
                }
            ]
        };
        console.log(JSON.stringify(helpJson, null, 2));
        return;
    }

    const command = args[0].toLowerCase();
    const limit = 20;

    let page = 1;
    const pageIdx = args.findIndex(a => a.toLowerCase() === "page");
    if (pageIdx !== -1 && args[pageIdx + 1] && !isNaN(args[pageIdx + 1])) {
        page = parseInt(args[pageIdx + 1]);
    } else if (args[2] && !isNaN(args[2])) {
        page = parseInt(args[2]);
    } else if (args[1] && !isNaN(args[1])) {
        page = parseInt(args[1]);
    }

    const ytmusic = new YTMusic();
    try {
        await ytmusic.initialize();
    } catch (e) {
        await new Promise(r => setTimeout(r, 300));
        await ytmusic.initialize();
    }

    let outputJson = {};

    if (command === "song" || (command === "get" && detectIdType(args[1]) === "song")) {
        const cleanId = args[1] || "k1BfsO0mxWQ";
        outputJson = await fetchSongDetails(cleanId, ytmusic);
    } else if (command === "artist" || (command === "info" && detectIdType(args[1]) === "artist")) {
        const cleanId = args[1] || "UCoy8sTKrImqfSq6TYOSW81A";
        outputJson = await fetchArtistDetails(cleanId, ytmusic);
    } else if (command === "album" || (command === "info" && detectIdType(args[1]) === "album")) {
        const cleanId = args[1] || "MPREb_N8YZSqmQiv4";
        outputJson = await fetchAlbumDetails(cleanId, ytmusic);
    } else if (command === "playlist" || (command === "info" && detectIdType(args[1]) === "playlist")) {
        const cleanId = args[1] || "PL3LUUT1_qZN5G6hOlPm64aCe6A3yIwZKh";
        outputJson = await fetchPlaylistDetails(cleanId, ytmusic);
    } else if (command === "home") {
        outputJson = await fetchSearchResults("home", page, 20, ytmusic);
    } else if (command === "trending") {
        outputJson = await fetchSearchResults("trending", page, 20, ytmusic);
    } else if (command === "search") {
        const query = args[1] || "Sheila on 7";
        outputJson = await fetchSearchResults(query, page, limit, ytmusic);
    } else {
        outputJson = {
            status: "error",
            message: `Command '${command}' tidak dikenal. Ketik 'node index.js' untuk me-load help.`
        };
    }

    const targetFile = customOutputFile ? path.resolve(customOutputFile) : path.join(__dirname, "output.json");
    fs.writeFileSync(targetFile, JSON.stringify(outputJson, null, 2), "utf-8");

    console.log(JSON.stringify(outputJson, null, 2));
}

main().catch(err => {
    console.error(JSON.stringify({ status: "error", message: err.message }, null, 2));
});
