const express = require('express');
const app = express();

app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN || 'YOUR_WHATSAPP_TOKEN';
const LLM_API_URL = process.env.LLM_API_URL || 'https://tours-ai-api-anffe0brajezcndk.centralus-01.azurewebsites.net/azure_ai_search';
const WA_API_URL = 'https://graph.facebook.com/v25.0/1080983858426889/messages';

// GET route - handles both browser visits and Meta verification
app.get('/', (req, res) => {
    const {
        'hub.mode': mode,
        'hub.challenge': challenge,
        'hub.verify_token': token
    } = req.query;

    if (mode === 'subscribe' && token === verifyToken) {
        console.log('WEBHOOK VERIFIED ✅');
        res.status(200).send(challenge);
    } else if (!mode && !token) {
        res.status(200).send('Webhook server is running! ✅');
    } else {
        console.log('Verification failed ❌ - Token mismatch');
        res.status(403).end();
    }
});

// Reads an SSE stream line by line and concatenates all tokens into one string
async function aggregateStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
                const jsonStr = trimmed.slice(6).trim();
                if (!jsonStr || jsonStr === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed.token) {
                        fullText += parsed.token;
                    }
                } catch (err) {
                    console.warn('Could not parse stream line:', jsonStr);
                }
            }
        }
    }

    // Handle any remaining buffer content
    if (buffer.trim().startsWith('data: ')) {
        const jsonStr = buffer.trim().slice(6).trim();
        if (jsonStr && jsonStr !== '[DONE]') {
            try {
                const parsed = JSON.parse(jsonStr);
                if (parsed.token) fullText += parsed.token;
            } catch (_) {}
        }
    }

    return fullText;
}

// Sends a WhatsApp message to the given phone number
async function sendWhatsApp(toPhone, messageText) {
    const payload = {
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'text',
        text: { body: messageText }
    };

    const response = await fetch(WA_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${WA_TOKEN}`
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`WhatsApp API error ${response.status}: ${errText}`);
    }

    console.log(`✅ WhatsApp message sent to ${toPhone}`);
}

// Calls the external LLM API, aggregates the stream, and replies via WhatsApp
async function handleMessage(userMessage, toPhone) {
    console.log(`📩 Message from ${toPhone}: "${userMessage}"`);

    // Call the external LLM API
    const llmResponse = await fetch(LLM_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: userMessage,
            user_id: 'user_ui_123',
            session_id: 'session_ui_123'
        })
    });

    if (!llmResponse.ok) {
        const errText = await llmResponse.text();
        throw new Error(`LLM API error ${llmResponse.status}: ${errText}`);
    }

    // Aggregate all streamed tokens into a single string
    const fullReply = await aggregateStream(llmResponse);
    console.log(`🤖 LLM reply: "${fullReply}"`);

    // Send the full reply back to the user on WhatsApp
    await sendWhatsApp(toPhone, fullReply);
}

// POST route - receives incoming WhatsApp messages
app.post('/', (req, res) => {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`\nWebhook received at ${timestamp}\n`);

    // Always respond 200 immediately so Meta doesn't retry
    res.status(200).end();

    try {
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0]?.value;
        const message = change?.messages?.[0];

        // Only handle incoming text messages
        if (!message || message.type !== 'text') {
            console.log('No text message found, skipping.');
            return;
        }

        const userMessage = message.text.body;
        const fromPhone = message.from;

        // Fire and forget — errors are caught inside
        handleMessage(userMessage, fromPhone).catch(err => {
            console.error('❌ handleMessage error:', err.message);
        });

    } catch (err) {
        console.error('❌ Error parsing webhook body:', err.message);
    }
});

app.listen(port, () => {
    console.log(`\nListening on port ${port}\n`);
});