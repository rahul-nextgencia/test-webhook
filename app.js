require('dotenv').config();
const express = require('express');
const Redis = require('ioredis');
const sharp = require('sharp');
const app = express();

app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN || 'YOUR_WHATSAPP_TOKEN';
const LLM_API_URL = process.env.LLM_API_URL || 'https://tours-ai-serach-api-ghbucpa8hqdea2d3.centralus-01.azurewebsites.net/api/v1/search';
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID || '';
const WA_API_URL = `https://graph.facebook.com/v25.0/${WA_PHONE_NUMBER_ID}/messages`;
const VERIFY_API_URL = process.env.VERIFY_API_URL || 'https://tours-ai-serach-api-ghbucpa8hqdea2d3.centralus-01.azurewebsites.net/api/v1/auth/verify-number';
const TRANSCRIBE_API_URL = process.env.TRANSCRIBE_API_URL || 'https://tours-ai-serach-api-ghbucpa8hqdea2d3.centralus-01.azurewebsites.net/api/v1/transcribe';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';
const TOURS_API_BASE = process.env.TOURS_API_BASE || 'https://ngtoursapi-e9gxafbsdpdebnc4.westus2-01.azurewebsites.net/api';
const AZURE_CACHE_URL = process.env.AZURE_CACHE_URL;
const AZURE_CACHE_KEY = process.env.AZURE_CACHE_KEY;

// ---------------------------------------------------------------------------
// Startup guard — crash loudly rather than silently sending malformed requests
// ---------------------------------------------------------------------------
if (!WA_PHONE_NUMBER_ID) {
    console.error('[FATAL] WA_PHONE_NUMBER_ID env var is missing or empty.');
    console.error('[FATAL] WA_API_URL would be: https://graph.facebook.com/v25.0//messages (INVALID)');
    console.error('[FATAL] This causes Graph API error 100/33: Object with ID "messages" does not exist.');
    console.error('[FATAL] Set WA_PHONE_NUMBER_ID in your .env or Azure App Service Application Settings.');
    process.exit(1);
}
if (!WA_TOKEN || WA_TOKEN === 'YOUR_WHATSAPP_TOKEN') {
    console.error('[FATAL] WA_TOKEN env var is missing or still set to the placeholder value.');
    process.exit(1);
}

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
    console.log(`📤 [sendWhatsApp] URL: ${WA_API_URL} | to: ${toPhone} | length: ${messageText?.length}`);
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
        console.error(`❌ [sendWhatsApp] WA_API_URL used: ${WA_API_URL}`);
        console.error(`❌ [sendWhatsApp] Phone ID from env: "${WA_PHONE_NUMBER_ID}"`);
        console.error(`❌ [sendWhatsApp] Token present: ${!!WA_TOKEN && WA_TOKEN !== 'YOUR_WHATSAPP_TOKEN'}`);
        console.error(`❌ [sendWhatsApp] Response ${response.status}: ${errText}`);
        throw new Error(`WhatsApp API error ${response.status}: ${errText}`);
    }

    console.log(`✅ WhatsApp message sent to ${toPhone}`);
}

// Sends a native WhatsApp IMAGE message (JPEG/PNG/GIF only — renders inline as a photo).
// Returns true on success, false on failure.
async function sendWhatsAppImage(toPhone, imageUrl, caption = '') {
    console.log(`🖼️ Attempting to send IMAGE to ${toPhone}: ${imageUrl}`);

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

    const responseText = await response.text();

    if (!response.ok) {
        console.error(`❌ WhatsApp image API rejected (HTTP ${response.status}) for URL: ${imageUrl}`);
        console.error(`❌ Error details: ${responseText}`);
        return false;
    }

    console.log(`✅ WhatsApp image sent to ${toPhone}`);
    return true;
}

// Converts a .webp URL to JPEG and sends it as a native WhatsApp image.
// Flow: download webp → convert to JPEG via sharp → upload to WA media API → send as image.
// Returns true on success, false on failure.
async function convertAndSendWebpAsImage(toPhone, webpUrl) {
    console.log(`🔄 Converting + uploading webp for ${toPhone}: ${webpUrl}`);

    // Step A: Download the .webp from Azure Blob
    const downloadRes = await fetch(webpUrl);
    if (!downloadRes.ok) {
        console.error(`❌ Failed to download webp (HTTP ${downloadRes.status}): ${webpUrl}`);
        return false;
    }
    const webpBuffer = Buffer.from(await downloadRes.arrayBuffer());

    // Step B: Convert to JPEG using sharp
    let jpegBuffer;
    try {
        jpegBuffer = await sharp(webpBuffer).jpeg({ quality: 85 }).toBuffer();
        console.log(`🖼️ Converted to JPEG: ${jpegBuffer.length} bytes`);
    } catch (err) {
        console.error(`❌ sharp conversion failed: ${err.message}`);
        return false;
    }

    // Step C: Upload JPEG to WhatsApp media endpoint to get a media_id
    const WA_PHONE_ID = WA_API_URL.match(/\/v\d+\.\d+\/([^/]+)\/messages/)?.[1];
    if (!WA_PHONE_ID) {
        console.error('❌ Could not extract phone number ID from WA_API_URL');
        return false;
    }
    const uploadUrl = `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/media`;

    const formData = new FormData();
    const blob = new Blob([jpegBuffer], { type: 'image/jpeg' });
    formData.append('file', blob, 'photo.jpg');
    formData.append('messaging_product', 'whatsapp');

    const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
        body: formData
    });

    const uploadText = await uploadRes.text();
    if (!uploadRes.ok) {
        console.error(`❌ Media upload failed (HTTP ${uploadRes.status}): ${uploadText}`);
        return false;
    }

    let mediaId;
    try {
        mediaId = JSON.parse(uploadText).id;
    } catch {
        console.error(`❌ Could not parse media upload response: ${uploadText}`);
        return false;
    }
    console.log(`✅ Media uploaded, media_id: ${mediaId}`);

    // Step D: Send as a native WhatsApp image using the media_id
    const msgPayload = {
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'image',
        image: { id: mediaId }
    };

    const msgRes = await fetch(WA_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${WA_TOKEN}`
        },
        body: JSON.stringify(msgPayload)
    });

    const msgText = await msgRes.text();
    if (!msgRes.ok) {
        console.error(`❌ Image message send failed (HTTP ${msgRes.status}): ${msgText}`);
        return false;
    }

    console.log(`✅ Image message sent to ${toPhone} via media_id`);
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
    const webpRegex    = /\.webp(\?[^\s]*)?$/i;   // .webp  → send as sticker
    const imageRegex   = /\.(jpg|jpeg|png|gif)(\?[^\s]*)?$/i; // others → send as image

    const webpUrls  = [];
    const imageUrls = [];

    // Step 1: Log all URLs found in the reply
    const allUrls = replyText.match(urlRegex) || [];
    console.log(`🔍 sendRichReply: found ${allUrls.length} URL(s) in LLM reply:`, allUrls);

    // Step 2: Categorise and extract media URLs from the text
    let cleanedText = replyText.replace(urlRegex, (url) => {
        if (webpRegex.test(url)) {
            webpUrls.push(url);
            console.log(`🎭 Detected as WEBP/sticker URL: ${url}`);
            return ''; // Remove from text
        }
        if (imageRegex.test(url)) {
            imageUrls.push(url);
            console.log(`🖼️  Detected as IMAGE URL: ${url}`);
            return ''; // Remove from text
        }
        console.log(`📄  Detected as DOCUMENT/OTHER URL (kept in text): ${url}`);
        return url;
    });

    console.log(`🔍 sendRichReply: ${webpUrls.length} sticker(s), ${imageUrls.length} image(s) to send natively`);

    // Step 3: Tidy up the text after media URL removal
    cleanedText = cleanedText
        .replace(/^[•\-\*]\s*$/gm, '')   // Remove now-empty bullet points
        .replace(/\n{3,}/g, '\n\n')        // Collapse excess blank lines
        .trim();

    // Step 4: Send the cleaned text (if anything remains)
    if (cleanedText) {
        await sendWhatsApp(toPhone, cleanedText);
    }

    // Step 5: Convert .webp files to JPEG and send as images
    for (const url of webpUrls) {
        const sent = await convertAndSendWebpAsImage(toPhone, url);
        if (!sent) {
            console.warn(`⚠️ webp conversion/send failed, falling back to plain-text URL for: ${url}`);
            await sendWhatsApp(toPhone, `🖼️ ${url}`);
        }
    }

    // Step 6: Send .jpg/.png/.gif files as images
    for (const url of imageUrls) {
        const sent = await sendWhatsAppImage(toPhone, url);
        if (!sent) {
            console.warn(`⚠️ Image send failed, falling back to plain-text URL for: ${url}`);
            await sendWhatsApp(toPhone, `🖼️ ${url}`);
        }
    }

    console.log(`📤 Rich reply done for ${toPhone}: ${webpUrls.length} sticker(s), ${imageUrls.length} image(s), text=${!!cleanedText}`);
}

// Formats a 'yyyy-mm-dd' date string to '01 July 2026' format
function formatDate(dateStr) {
    if (!dateStr) return '';
    const [year, month, day] = dateStr.split('-');
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Sends a WhatsApp Interactive List Message for tour selection
async function sendTourSelectionList(toPhone, tours) {
    const rows = tours.map(tour => ({
        id: tour.tour_id,
        title: tour.tour_name.substring(0, 24),
        description: `${formatDate(tour.tour_start_date)} to ${formatDate(tour.tour_end_date)}`.substring(0, 72)
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
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Secret': INTERNAL_SECRET
            },
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
 * Calls the PATCH endpoint to mark a participant as having joined on WhatsApp.
 * This is a one-time, fire-and-forget operation — errors are logged but not thrown.
 */
async function markWhatsappInitiated(itineraryId, userId) {
    const url = `${TOURS_API_BASE}/itineraries/${itineraryId}/participants/${userId}/whatsapp-initiated`;
    console.log(`📲 Marking WhatsApp initiated for user ${userId} on tour ${itineraryId}`);
    try {
        const res = await fetch(url, { method: 'PATCH' });
        if (res.ok) {
            console.log(`✅ WhatsApp initiated flag set — user ${userId}, tour ${itineraryId}`);
        } else {
            const errText = await res.text();
            console.warn(`⚠️ whatsapp-initiated PATCH failed (HTTP ${res.status}): ${errText}`);
        }
    } catch (err) {
        console.warn(`⚠️ whatsapp-initiated PATCH error:`, err.message);
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
        headers: { 'X-Internal-Secret': INTERNAL_SECRET },
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
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Secret': INTERNAL_SECRET
        },
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
                        itineraryId: tour.itinerary_id,
                        userId: tour.user_id
                    }), 'EX', 86400); // 24h

                    // One-time PATCH: mark this user as WhatsApp-initiated for the selected tour
                    if (tour.user_id) {
                        const initiatedKey = `wa:initiated:${fromPhone}:${tour.itinerary_id}`;
                        const alreadyInitiated = await redis.get(initiatedKey);
                        if (!alreadyInitiated) {
                            markWhatsappInitiated(tour.itinerary_id, tour.user_id).then(() => {
                                redis.set(initiatedKey, '1'); // no expiry — truly one-time
                            }).catch(err => console.error('❌ markWhatsappInitiated error:', err.message));
                        }
                    }

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
                // user_id is a top-level field in the verify-number response
                const verifiedUserId = data.user_id || null;

                // Map the new API response pattern to the expected internal format
                let tours = (data.tours || []).map(t => ({
                    tour_id: t.tour_id,
                    itinerary_id: t.tour_id, // Use tour_id as itinerary_id for the search endpoint
                    tour_name: t.title,
                    tour_start_date: t.start_date,
                    tour_end_date: t.end_date,
                    tour_status: t.status,
                    user_id: verifiedUserId  // propagate participant GUID to each tour entry
                }));
                
                // Fallback for legacy single-tour response format
                if (tours.length === 0 && data.itinerary_id) {
                    tours = [{
                        tour_id: data.tour_id,
                        itinerary_id: data.itinerary_id,
                        tour_name: data.tour_name,
                        tour_status: data.tour_status || 'active',
                        user_id: verifiedUserId
                    }];
                }

                const activeTours = tours.filter(t => t.tour_status !== 'expired' && t.tour_status !== 'cancelled');

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
                            itineraryId: tour.itinerary_id,
                            userId: tour.user_id
                        }), 'EX', 86400);
                    }

                    // One-time PATCH: mark this user as WhatsApp-initiated for this tour
                    if (!isSwitchCommand && tour.user_id) {
                        const initiatedKey = `wa:initiated:${fromPhone}:${tour.itinerary_id}`;
                        const alreadyInitiated = redis ? await redis.get(initiatedKey) : null;
                        if (!alreadyInitiated) {
                            markWhatsappInitiated(tour.itinerary_id, tour.user_id).then(() => {
                                if (redis) redis.set(initiatedKey, '1'); // no expiry — truly one-time
                            }).catch(err => console.error('❌ markWhatsappInitiated error:', err.message));
                        }
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
    console.log(`\nListening on port ${port}`);
    console.log(`[CONFIG] WA_API_URL       : ${WA_API_URL}`);
    console.log(`[CONFIG] WA_PHONE_NUMBER_ID: ${WA_PHONE_NUMBER_ID || '⚠️  EMPTY'}`);
    console.log(`[CONFIG] WA_TOKEN present : ${!!WA_TOKEN && WA_TOKEN !== 'YOUR_WHATSAPP_TOKEN'}`);
    console.log(`[CONFIG] VERIFY_API_URL   : ${VERIFY_API_URL}`);
    console.log(`[CONFIG] LLM_API_URL      : ${LLM_API_URL}`);
    console.log(`[CONFIG] TRANSCRIBE_URL   : ${TRANSCRIBE_API_URL}`);
    console.log(`[CONFIG] INTERNAL_SECRET  : ${INTERNAL_SECRET ? '✅ set' : '⚠️  NOT SET'}`);
    console.log(`[CONFIG] Redis            : ${AZURE_CACHE_URL ? AZURE_CACHE_URL : '⚠️  NOT SET'}\n`);
});