const express = require('express');
const app = express();

app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

// GET route - handles both browser visits and Meta verification
app.get('/', (req, res) => {
    const { 
        'hub.mode': mode, 
        'hub.challenge': challenge, 
        'hub.verify_token': token 
    } = req.query;

    // Meta webhook verification
    if (mode === 'subscribe' && token === verifyToken) {
        console.log('WEBHOOK VERIFIED ✅');
        res.status(200).send(challenge);
    } 
    // Normal browser/health check visit
    else if (!mode && !token) {
        res.status(200).send('Webhook server is running! ✅');
    }
    // Wrong token
    else {
        console.log('Verification failed ❌ - Token mismatch');
        res.status(403).end();
    }
});

// POST route - receives incoming WhatsApp messages
app.post('/', (req, res) => {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`\nWebhook received at ${timestamp}\n`);
    console.log(JSON.stringify(req.body, null, 2));
    res.status(200).end();
});

app.listen(port, () => {
    console.log(`\nListening on port ${port}\n`);
});
