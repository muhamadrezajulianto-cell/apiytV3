const https = require('https');
const fs = require('fs');
const path = require('path');

if (process.platform === 'linux') {
    const dest = path.join(__dirname, 'yt-dlp');
    console.log('[Postinstall] Downloading Linux yt-dlp binary to', dest);
    
    function download(url) {
        https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return download(res.headers.location);
            }
            if (res.statusCode === 200) {
                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    try {
                        fs.chmodSync(dest, 0o755);
                        console.log('[Postinstall] Successfully installed yt-dlp binary on Linux!');
                    } catch(e) {
                        console.error('[Postinstall] chmod error:', e.message);
                    }
                });
            } else {
                console.error('[Postinstall] Download failed, status:', res.statusCode);
            }
        }).on('error', (err) => {
            console.error('[Postinstall] Download request error:', err.message);
        });
    }

    download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp');
}
