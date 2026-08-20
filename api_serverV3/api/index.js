const ytmus = require('../ytmus.js');
// Since ytmus.js was patched to export the request handler in Vercel env, we just re-export it here
module.exports = (req, res) => {
    // Vercel serverless request handler
    if (typeof ytmus === 'function') {
        return ytmus(req, res);
    }
    res.status(500).json({ error: "Failed to load request handler" });
};
