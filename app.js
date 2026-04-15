require('dotenv').config();
const express = require('express');
const Redis = require('ioredis');
const app = express();

app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN || 'YOUR_WHATSAPP_TOKEN';
const LLM_API_URL = process.env.LLM_API_URL || 'https://tours-ai-api-anffe0brajezcndk.centralus-01.azurewebsites.net/azure_ai_search';
const WA_API_URL = 'https://graph.facebook.com/v25.0/1080983858426889/messages';
const VERIFY_API_URL = 'https://tours-ai-api-anffe0brajezcndk.centralus-01.azurewebsites.net/verifyNumber';
const REDIS_URL = process.env.REDIS_URL;

// Initialize Redis
const redis = REDIS_URL ? new Redis(REDIS_URL, { 
    tls: { rejectUnauthorized: false },
    maxRetriesPerRequest: null 
}) : null;
if (redis) {
    redis.on('connect', () => console.log('Connected to Redis ✅'));
    redis.on('error', (err) => console.error('Redis error ❌', err));
} else {
    console.error('Redis initialization failed ❌ - REDIS_URL is missing');
}

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

// Marks the incoming message as read (shows blue ticks to the sender)
async function sendReadReceipt(messageId) {
    const payload = {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
    };

    try {
        const response = await fetch(WA_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WA_TOKEN}`
            },
            body: JSON.stringify(payload)
        });
        if (response.ok) {
            console.log('✔✔ Read receipt sent');
        }
    } catch (err) {
        console.warn('⚠️ Could not send read receipt:', err.message);
    }
}

// Reacts to the user's message with an emoji
// emoji: '👀' = bot is processing, '✅' = reply sent, '❌' = error
async function reactToMessage(toPhone, messageId, emoji) {
    const payload = {
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'reaction',
        reaction: {
            message_id: messageId,
            emoji: emoji
        }
    };

    try {
        const response = await fetch(WA_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WA_TOKEN}`
            },
            body: JSON.stringify(payload)
        });
        if (response.ok) {
            console.log(`${emoji} Reaction sent to message ${messageId}`);
        } else {
            const errText = await response.text();
            console.warn(`⚠️ Could not send reaction (status ${response.status}):`, errText);
        }
    } catch (err) {
        console.warn('⚠️ Could not send reaction:', err.message);
    }
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

// Sends a WhatsApp Interactive List Message for tour selection
async function sendTourSelectionList(toPhone, tours) {
    const rows = tours.map(tour => ({
        id: tour.tour_id,
        title: tour.tour_name.substring(0, 24),
        description: `${tour.tour_start_date} to ${tour.tour_end_date}`.substring(0, 72)
    }));

    const payload = {
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'interactive',
        interactive: {
            type: 'list',
            header: {
                type: 'text',
                text: 'Tour Selection'
            },
            body: {
                text: 'We found multiple tours registered for your number. Which one would you like to chat about?'
            },
            footer: {
                text: 'Please select from the list below'
            },
            action: {
                button: 'Select a Tour',
                sections: [
                    {
                        title: 'Your Tours',
                        rows: rows
                    }
                ]
            }
        }
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
        throw new Error(`WhatsApp List Message error ${response.status}: ${errText}`);
    }

    console.log(`✅ Tour selection list sent to ${toPhone}`);
}

/**
 * Verifies a phone number against the tour database.
 * Returns an object with the verification status and user data.
 */
async function verifyUser(phone) {
    try {
        const response = await fetch(VERIFY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
        });

        const data = await response.json();
        return { status: response.status, data };
    } catch (err) {
        console.error('⚠️ Verification API error:', err.message);
        return { status: 500, error: err.message };
    }
}

// Calls the external LLM API, aggregates the stream, and replies via WhatsApp
async function handleMessage(userMessage, toPhone, messageId, itineraryId) {
    console.log(`📩 Message from ${toPhone} (Itinerary: ${itineraryId}): "${userMessage}"`);

    // Mark message as read (blue ticks) and react with ⏳ to signal processing
    await sendReadReceipt(messageId);
    await reactToMessage(toPhone, messageId, '⏳');

    // Call the external LLM API
    const llmResponse = await fetch(LLM_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: userMessage,
            user_id: toPhone,
            session_id: toPhone,
            itinerary_id: itineraryId
        })
    });

    if (!llmResponse.ok) {
        const errText = await llmResponse.text();
        // React with ❌ to signal failure
        await reactToMessage(toPhone, messageId, '❌');
        throw new Error(`LLM API error ${llmResponse.status}: ${errText}`);
    }

    // Aggregate all streamed tokens into a single string
    let fullReply = await aggregateStream(llmResponse);

    // Convert LLM Markdown to WhatsApp formatting
    fullReply = fullReply.replace(/\*\*([\s\S]*?)\*\*/g, '*$1*'); // Convert **bold** to *bold*
    fullReply = fullReply.replace(/^(#{1,6})\s+(.*)$/gm, '*$2*'); // Convert ## headers to *bold*

    console.log(`🤖 LLM reply: "${fullReply}"`);

    // Send the full reply back to the user on WhatsApp
    await sendWhatsApp(toPhone, fullReply);

    // React with ✅ to confirm the reply was sent successfully
    await reactToMessage(toPhone, messageId, '✅');
}

// POST route - receives incoming WhatsApp messages
app.post('/', async (req, res) => {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`\nWebhook received at ${timestamp}\n`);

    // Always respond 200 immediately
    res.status(200).end();

    try {
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0]?.value;
        const message = change?.messages?.[0];

        if (!message) return;

        const fromPhone = message.from;
        const messageId = message.id;

        // 1. Handle Interactive List Reply (Tour Selection)
        if (message.type === 'interactive' && message.interactive?.type === 'list_reply') {
            const selectedTourId = message.interactive.list_reply.id;
            const selectedTourName = message.interactive.list_reply.title;
            
            console.log(`🔘 Tour Selected by ${fromPhone}: ${selectedTourName} (${selectedTourId})`);
            
            // Get pending tours to find the correct itinerary_id
            const pendingData = await redis.get(`wa:pending:${fromPhone}`);
            if (pendingData) {
                const tours = JSON.parse(pendingData);
                const tour = tours.find(t => t.tour_id === selectedTourId);
                if (tour) {
                    // Pin session to this tour
                    await redis.set(`wa:session:${fromPhone}`, JSON.stringify({
                        activeTourId: selectedTourId,
                        activeTourName: selectedTourName,
                        itineraryId: tour.itinerary_id
                    }), 'EX', 86400); // 24h
                    
                    await sendWhatsApp(fromPhone, `Got it! I'm now set to answer questions about the *${selectedTourName}* 🏖️\n\nYou can type 'switch tour' anytime to pick a different one.`);
                    return;
                }
            }
            await sendWhatsApp(fromPhone, "Sorry, something went wrong with the selection. Please try sending a message again.");
            return;
        }

        // 2. Handle Text Messages
        if (message.type === 'text') {
            const userMessage = message.text.body;
            console.log(`🔍 [Auth Check] Phone: ${fromPhone}`);

            if (userMessage.toLowerCase() === 'switch tour') {
                await redis.del(`wa:session:${fromPhone}`);
                // Proceed to verification to show the list again
            }

            // Check for existing session
            const sessionData = await redis.get(`wa:session:${fromPhone}`);
            if (sessionData && userMessage.toLowerCase() !== 'switch tour') {
                const session = JSON.parse(sessionData);
                await redis.expire(`wa:session:${fromPhone}`, 86400); // Rolling 24h
                handleMessage(userMessage, fromPhone, messageId, session.itineraryId).catch(err => {
                    console.error('❌ handleMessage error:', err.message);
                });
                return;
            }

            // Verify user and handle multi-tour logic
            const { status, data } = await verifyUser(fromPhone);
            console.log(`🔍 [Auth Result] Phone: ${fromPhone}, Status: ${status}, Data: ${JSON.stringify(data)}`);
            
            if (status === 200 && data.exists === true) {
                let tours = data.tours || [];
                
                // Fallback for legacy single-tour response format
                if (tours.length === 0 && data.itinerary_id) {
                    tours = [{
                        tour_id: data.tour_id,
                        itinerary_id: data.itinerary_id,
                        tour_name: data.tour_name,
                        tour_status: data.tour_status || 'active'
                    }];
                }

                const activeTours = tours.filter(t => t.tour_status !== 'expired');

                if (activeTours.length === 0) {
                    console.log(`🚫 No active tours for: ${fromPhone}`);
                    await sendWhatsApp(fromPhone, "Sorry, your access to this tour chat has expired. We hope you had a wonderful trip! 🏝️");
                } else if (activeTours.length === 1) {
                    // Auto-select
                    const tour = activeTours[0];
                    await redis.set(`wa:session:${fromPhone}`, JSON.stringify({
                        activeTourId: tour.tour_id,
                        activeTourName: tour.tour_name,
                        itineraryId: tour.itinerary_id
                    }), 'EX', 86400);
                    
                    handleMessage(userMessage, fromPhone, messageId, tour.itinerary_id).catch(err => {
                        console.error('❌ handleMessage error:', err.message);
                    });
                } else {
                    // Multiple tours - send list
                    await redis.set(`wa:pending:${fromPhone}`, JSON.stringify(activeTours), 'EX', 900); // 15 min
                    await sendTourSelectionList(fromPhone, activeTours);
                }
            } else if (status === 404 || (status === 200 && data.exists === false)) {
                console.log(`🚫 Unregistered user: ${fromPhone}`);
                await sendWhatsApp(fromPhone, "Sorry, you don't appear to be registered for any tour. Please contact your tour organizer. 🏖️");
            } else if (status === 403) {
                console.log(`⏳ Expired access: ${fromPhone}`);
                await sendWhatsApp(fromPhone, "Your access to this tour chat has expired. We hope you had a wonderful trip! 🏝️");
            } else {
                console.error(`⚠️ Unexpected verification state for ${fromPhone} (Status ${status}):`, data);
            }
        } else {
            console.log(`Non-text message (${message.type}) found, skipping.`);
        }

    } catch (err) {
        console.error('❌ Webhook error:', err.message);
    }
});

app.listen(port, () => {
    console.log(`\nListening on port ${port}\n`);
});