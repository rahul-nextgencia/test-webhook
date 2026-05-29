require('dotenv').config();
const express = require('express');
const Redis = require('ioredis');
const app = express();

app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN || 'YOUR_WHATSAPP_TOKEN';
const LLM_API_URL = process.env.LLM_API_URL || 'https://tours-ai-serach-api-ghbucpa8hqdea2d3.centralus-01.azurewebsites.net/api/v1/search';
const WA_API_URL = 'https://graph.facebook.com/v25.0/1080983858426889/messages';
const VERIFY_API_URL = 'https://tours-ai-serach-api-ghbucpa8hqdea2d3.centralus-01.azurewebsites.net/api/v1/auth/verify-number';
const TRANSCRIBE_API_URL = process.env.TRANSCRIBE_API_URL || 'https://tours-ai-serach-api-ghbucpa8hqdea2d3.centralus-01.azurewebsites.net/api/v1/transcribe';
const AZURE_CACHE_URL = process.env.AZURE_CACHE_URL;
const AZURE_CACHE_KEY = process.env.AZURE_CACHE_KEY;

if (AZURE_CACHE_URL && AZURE_CACHE_KEY) {
    const [host, portStr] = AZURE_CACHE_URL.split(':');
    const port = parseInt(portStr) || 6380;
    
    redis = new Redis({
        host: host,
        port: port,
        username: 'default',
        password: AZURE_CACHE_KEY,
        tls: { rejectUnauthorized: false },
        maxRetriesPerRequest: null
    });

    redis.on('connect', () => console.log('Redis TCP connected 🔌'));
    redis.on('ready', () => console.log('Redis is ready and authenticated 🚀'));
    redis.on('error', (err) => console.error('Redis error ❌', err));
} else {
    console.error('Redis initialization failed ❌ - AZURE_CACHE_URL or AZURE_CACHE_KEY is missing');
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

// Constructs the greeting part of the welcome message.
function buildGreeting(userName) {
    return userName ? `👋 Welcome ${userName}!` : `👋 Welcome!`;
}

// Constructs the instructions/info part of the welcome message.
function buildInstructions(tourName) {
    if (tourName) {
        return `I'm your tour assistant for *${tourName}*.\n\nAsk me anything about your trip — itinerary, activities, packing tips, and more.\n\n💡 Type *switch tour* or *change tour* at any time to switch between your enrolled tours.`;
    } else {
        return `I can see you're enrolled in multiple tours.\n\nPlease select the tour you'd like to chat about from the list below 👇\n\n💡 Type *switch tour* or *change tour* at any time to come back to this selection.`;
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

// Sends a native WhatsApp image message (renders inline as a photo)
async function sendWhatsAppImage(toPhone, imageUrl, caption = '') {
    const payload = {
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'image',
        image: {
            link: imageUrl,
            ...(caption && { caption })
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
        console.warn(`⚠️ WhatsApp image send failed (${response.status}): ${errText}`);
        return false;
    }

    console.log(`🖼️ WhatsApp image sent to ${toPhone}`);
    return true;
}

/**
 * Parses the LLM reply text and sends a rich WhatsApp reply:
 *  - Image URLs (.webp, .jpg, .jpeg, .png, .gif) are sent as native inline image messages.
 *  - Document URLs (.pdf, .doc, etc.) are kept in the text with their LLM-provided label.
 *  - The remaining cleaned text is sent as a standard text message.
 */
async function sendRichReply(toPhone, replyText) {
    const urlRegex = /https?:\/\/[^\s)>"]+/g;
    const imageExtRegex = /\.(webp|jpg|jpeg|png|gif)(\?[^\s]*)?$/i;

    const imageUrls = [];

    // Step 1: Extract image URLs from the text; leave document URLs in place
    let cleanedText = replyText.replace(urlRegex, (url) => {
        if (imageExtRegex.test(url)) {
            imageUrls.push(url);
            return ''; // Remove image URL from text — will be sent as native image
        }
        return url; // Keep document/other URLs in the text
    });

    // Step 2: Tidy up the text after image URL removal
    cleanedText = cleanedText
        .replace(/^[•\-\*]\s*$/gm, '')   // Remove now-empty bullet points
        .replace(/\n{3,}/g, '\n\n')        // Collapse excess blank lines
        .trim();

    // Step 3: Send the cleaned text (if anything remains)
    if (cleanedText) {
        await sendWhatsApp(toPhone, cleanedText);
    }

    // Step 4: Send each gallery image as a native WhatsApp image message
    for (const imageUrl of imageUrls) {
        await sendWhatsAppImage(toPhone, imageUrl);
    }

    console.log(`📤 Rich reply sent to ${toPhone}: ${imageUrls.length} image(s), text=${!!cleanedText}`);
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
                text: 'I can see you\'re enrolled in multiple tours.\n\nWhich one would you like to chat about? 👇\n\n💡 Type *switch tour* or *change tour* at any time to come back to this selection.'
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

/**
 * Downloads a WhatsApp voice message and transcribes it via the /transcribe API.
 * Returns the transcribed text string.
 */
async function downloadAndTranscribeAudio(mediaId) {
    // Step 1: Resolve the media download URL from WhatsApp
    const metaRes = await fetch(`https://graph.facebook.com/v25.0/${mediaId}`, {
        headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });
    if (!metaRes.ok) throw new Error(`WA media-info error ${metaRes.status}`);
    const { url } = await metaRes.json();

    // Step 2: Download the audio binary
    const audioRes = await fetch(url, {
        headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });
    if (!audioRes.ok) throw new Error(`WA media-download error ${audioRes.status}`);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // Step 3: POST binary to POST /transcribe
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
    formData.append('file', blob, 'voice.ogg');

    const transcribeRes = await fetch(TRANSCRIBE_API_URL, {
        method: 'POST',
        body: formData
    });
    if (!transcribeRes.ok) throw new Error(`Transcription API error ${transcribeRes.status}: ${await transcribeRes.text()}`);

    const data = await transcribeRes.json();
    console.log('🎙️ Transcription API Raw Response:', JSON.stringify(data));
    if (typeof data === 'string') return data;
    return data.text || data.transcription || "";
}


// Calls the external LLM API, aggregates the stream, and replies via WhatsApp
async function handleMessage(userMessage, toPhone, messageId, itineraryId) {
    if (!userMessage || String(userMessage).trim() === "") {
        console.warn(`⚠️ Skipping LLM call: message is empty or undefined.`);
        await reactToMessage(toPhone, messageId, '❓');
        return;
    }

    console.log(`📩 Message from ${toPhone} (Itinerary: ${itineraryId}): "${userMessage}"`);

    // Mark message as read (blue ticks) and react with ⏳ to signal processing
    await sendReadReceipt(messageId);
    await reactToMessage(toPhone, messageId, '⏳');

    const payload = {
        message: userMessage,
        user_id: toPhone,
        session_id: toPhone,
        itinerary_id: itineraryId || ""
    };

    console.log('🤖 Calling LLM with payload:', JSON.stringify(payload));

    // Call the external LLM API
    const llmResponse = await fetch(LLM_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
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

    // Send the rich reply (images inline, docs labelled cleanly)
    await sendRichReply(toPhone, fullReply);

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

        const fromPhone = message.from.startsWith('+') ? message.from : `+${message.from}`;
        const messageId = message.id;
        const userName = change?.contacts?.[0]?.profile?.name || '';

        // 1. Handle Interactive List Reply (Tour Selection)
        if (message.type === 'interactive' && message.interactive?.type === 'list_reply') {
            const selectedTourId = message.interactive.list_reply.id;
            const selectedTourName = message.interactive.list_reply.title;
            
            console.log(`🔘 Tour Selected by ${fromPhone}: ${selectedTourName} (${selectedTourId})`);
            
            // Get pending tours to find the correct itinerary_id
            const pendingData = redis ? await redis.get(`wa:pending:${fromPhone}`) : null;
            if (pendingData) {
                const tours = JSON.parse(pendingData);
                const tour = tours.find(t => t.tour_id === selectedTourId);
                if (tour && redis) {
                    // Pin session to this tour
                    await redis.set(`wa:session:${fromPhone}`, JSON.stringify({
                        activeTourId: selectedTourId,
                        activeTourName: selectedTourName,
                        itineraryId: tour.itinerary_id
                    }), 'EX', 86400); // 24h
                    
                    await sendWhatsApp(fromPhone, buildInstructions(selectedTourName));
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

            const lowerMessage = userMessage.toLowerCase();
            const isSwitchCommand = lowerMessage === 'switch tour' || lowerMessage === 'change tour';

            if (isSwitchCommand && redis) {
                await redis.del(`wa:session:${fromPhone}`);
                await redis.del(`wa:history:${fromPhone}:${fromPhone}`);
                // Proceed to verification to show the list again
            }

            // Check for existing session
            const sessionData = redis ? await redis.get(`wa:session:${fromPhone}`) : null;
            if (sessionData && !isSwitchCommand) {
                const session = JSON.parse(sessionData);
                if (redis) await redis.expire(`wa:session:${fromPhone}`, 86400); // Rolling 24h
                handleMessage(userMessage, fromPhone, messageId, session.itineraryId).catch(err => {
                    console.error('❌ handleMessage error:', err.message);
                });
                return;
            }

            // Verify user and handle multi-tour logic
            const { status, data } = await verifyUser(fromPhone);
            console.log(`🔍 [Auth Result] Phone: ${fromPhone}, Status: ${status}, Data: ${JSON.stringify(data)}`);
            
            if (status === 200 && data.exists === true) {
                // Map the new API response pattern to the expected internal format
                let tours = (data.tours || []).map(t => ({
                    tour_id: t.tour_id,
                    itinerary_id: t.tour_id, // Use tour_id as itinerary_id for the search endpoint
                    tour_name: t.title,
                    tour_start_date: t.start_date,
                    tour_end_date: t.end_date,
                    tour_status: t.status
                }));
                
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
                    if (redis) {
                        await redis.set(`wa:session:${fromPhone}`, JSON.stringify({
                            activeTourId: tour.tour_id,
                            activeTourName: tour.tour_name,
                            itineraryId: tour.itinerary_id
                        }), 'EX', 86400);
                    }
                    
                    if (isSwitchCommand) {
                        await sendWhatsApp(fromPhone, `You are currently registered for only one active tour: *${tour.tour_name}*. I'm ready to answer any questions about it! 🏖️`);
                    } else {
                        // New session: send welcome messages. User's next message will go to the LLM.
                        await sendWhatsApp(fromPhone, buildGreeting(userName));
                        await sendWhatsApp(fromPhone, buildInstructions(tour.tour_name));
                    }
                } else {
                    // Multiple tours - send sequence: Greeting -> Interactive List (with instructions)
                    if (redis) {
                        await redis.set(`wa:pending:${fromPhone}`, JSON.stringify(activeTours), 'EX', 900); // 15 min
                        await sendWhatsApp(fromPhone, buildGreeting(userName));
                        await sendTourSelectionList(fromPhone, activeTours);
                    } else {
                        // If multiple tours found but Redis is down, we can't reliably show selection
                        // Fallback: pick the first one and warn
                        console.warn(`⚠️ Multiple tours for ${fromPhone} but Redis is down. Falling back to first tour.`);
                        const tour = activeTours[0];
                        handleMessage(userMessage, fromPhone, messageId, tour.itinerary_id).catch(err => {
                            console.error('❌ handleMessage error:', err.message);
                        });
                    }
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
        } else if (message.type === 'audio') {
            console.log(`🎙️ Voice message from ${fromPhone}, media ID: ${message.audio.id}`);
            await sendReadReceipt(messageId);
            await reactToMessage(fromPhone, messageId, '⏳');

            // Gate: only proceed if user has an active session
            const sessionData = redis ? await redis.get(`wa:session:${fromPhone}`) : null;
            if (!sessionData) {
                await reactToMessage(fromPhone, messageId, '❌');
                await sendWhatsApp(fromPhone, "Please send a text message first to get started, then try your voice message again. 🎙️");
                return;
            }

            const session = JSON.parse(sessionData);
            if (redis) await redis.expire(`wa:session:${fromPhone}`, 86400); // Rolling 24h

            try {
                const transcribedText = await downloadAndTranscribeAudio(message.audio.id);
                console.log(`📝 Transcribed: "${transcribedText}"`);
                // Route through the existing LLM flow, same as a text message
                handleMessage(transcribedText, fromPhone, messageId, session.itineraryId).catch(err => {
                    console.error('❌ handleMessage (audio) error:', err.message);
                });
            } catch (err) {
                console.error('❌ Audio transcription error:', err.message);
                await reactToMessage(fromPhone, messageId, '❌');
                await sendWhatsApp(fromPhone, "Sorry, I couldn't process your voice message. Please try again or type your question. 🙏");
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