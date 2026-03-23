require('dotenv').config();
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const axios    = require('axios');
const multer   = require('multer');
const FormData = require('form-data');
const { isAllowed, addContact, removeContact, listContacts } = require('./contacts');
const { logBlocked, logAllowed, logCallBlocked, getStats }   = require('./logger');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const { VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, PORT = 3000 } = process.env;

// ─────────────────────────────────────────
//  BASE DE DATOS (JSON simple)
// ─────────────────────────────────────────
const DB_FILE = path.join(__dirname, '../data/messages.json');

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
        fs.writeFileSync(DB_FILE, JSON.stringify({ conversations: {} }));
    }
    return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function saveMessage(phone, name, msgData) {
    const db = loadDB();
    if (!db.conversations[phone]) {
        db.conversations[phone] = { name, phone, messages: [] };
    }
    // Mensajes salientes inician con status "sent"
    const defaults = msgData.direction === 'outgoing' ? { status: 'sent' } : {};
    db.conversations[phone].messages.push({
        id:   Date.now(),
        time: new Date().toISOString(),
        ...defaults,
        ...msgData
    });
    db.conversations[phone].lastMessage = msgData.text || `[${msgData.type || 'media'}]`;
    db.conversations[phone].lastTime    = new Date().toISOString();
    saveDB(db);
}

// ─────────────────────────────────────────
//  OBTENER URL DE MEDIA DESDE META
// ─────────────────────────────────────────
async function getMediaUrl(mediaId) {
    try {
        const { data } = await axios.get(
            `https://graph.facebook.com/v18.0/${mediaId}`,
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );
        return data.url || null;
    } catch (e) {
        console.error('Error obteniendo media URL:', e.message);
        return null;
    }
}

// ─────────────────────────────────────────
//  WEBHOOK — VERIFICACIÓN
// ─────────────────────────────────────────
app.get('/webhook', (req, res) => {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ Webhook verificado');
        return res.status(200).send(challenge);
    }
    res.sendStatus(403);
});

// ─────────────────────────────────────────
//  WEBHOOK — RECEPCIÓN DE MENSAJES
// ─────────────────────────────────────────
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // responder a Meta inmediatamente
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    try {
        const value = body.entry?.[0]?.changes?.[0]?.value;
        if (!value) return;

        // ── Actualizaciones de estado (ticks) ──
        if (value.statuses && value.statuses.length > 0) {
            for (const status of value.statuses) {
                const waId      = status.id;       // ID del mensaje en Meta
                const newStatus = status.status;   // sent, delivered, read, failed
                const db = loadDB();
                // Buscar el mensaje en todas las conversaciones por waMessageId
                for (const conv of Object.values(db.conversations)) {
                    const msg = conv.messages.find(m => m.waMessageId === waId);
                    if (msg) {
                        msg.status = newStatus;
                        saveDB(db);
                        break;
                    }
                }
            }
            return;
        }

        // ── Mensajes entrantes ──
        if (value.messages && value.messages.length > 0) {
            const message     = value.messages[0];
            const senderPhone = message.from;
            const senderName  = value.contacts?.[0]?.profile?.name || senderPhone;

            if (!isAllowed(senderPhone)) {
                logBlocked(senderPhone, message.type);
                return; // bloqueado — no se guarda, no llega al panel
            }

            logAllowed(senderPhone);

            // Construir objeto del mensaje según tipo
            const msgData = {
                direction: 'incoming',
                type:      message.type,
            };

            // Contexto de reply (si es una respuesta a otro mensaje)
            if (message.context) {
                msgData.replyTo = { id: message.context.id };
            }

            switch (message.type) {
                case 'text':
                    msgData.text = message.text?.body || '';
                    break;

                case 'image':
                case 'sticker': {
                    const mediaId  = message[message.type]?.id;
                    const mediaUrl = mediaId ? await getMediaUrl(mediaId) : null;
                    msgData.mediaUrl = mediaUrl;
                    msgData.caption  = message[message.type]?.caption || '';
                    msgData.text     = msgData.caption || `[${message.type}]`;
                    break;
                }

                case 'audio':
                case 'voice': {
                    const mediaId  = message[message.type]?.id;
                    const mediaUrl = mediaId ? await getMediaUrl(mediaId) : null;
                    msgData.type     = 'audio';
                    msgData.mediaUrl = mediaUrl;
                    msgData.text     = '[Audio]';
                    break;
                }

                case 'document': {
                    const doc      = message.document;
                    const mediaId  = doc?.id;
                    const mediaUrl = mediaId ? await getMediaUrl(mediaId) : null;
                    msgData.mediaUrl = mediaUrl;
                    msgData.fileName = doc?.filename || 'documento';
                    msgData.text     = `[Documento: ${doc?.filename || ''}]`;
                    break;
                }

                case 'reaction':
                    // Guardar reacción en el mensaje original
                    if (message.reaction?.message_id) {
                        const db   = loadDB();
                        const conv = db.conversations[senderPhone];
                        if (conv) {
                            const target = conv.messages.find(m => String(m.waMessageId) === String(message.reaction.message_id));
                            if (target) {
                                if (!target.reactions) target.reactions = [];
                                target.reactions.push({ emoji: message.reaction.emoji, from: senderPhone });
                                saveDB(db);
                            }
                        }
                    }
                    return;

                default:
                    msgData.text = `[${message.type}]`;
            }

            saveMessage(senderPhone, senderName, msgData);
        }

    } catch (error) {
        console.error('Error en webhook:', error.message);
    }
});

// ─────────────────────────────────────────
//  API — CONVERSACIONES
// ─────────────────────────────────────────
app.get('/api/conversations', (req, res) => {
    const db   = loadDB();
    const list = Object.values(db.conversations)
        .sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
    res.json(list);
});

app.get('/api/conversations/:phone', (req, res) => {
    const db   = loadDB();
    const conv = db.conversations[req.params.phone];
    if (!conv) return res.status(404).json({ error: 'No encontrado' });
    res.json(conv);
});

// ─────────────────────────────────────────
//  API — ENVIAR TEXTO
// ─────────────────────────────────────────
app.post('/api/send', async (req, res) => {
    const { phone, message, replyToId } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Faltan datos' });

    try {
        const payload = {
            messaging_product: 'whatsapp',
            to:   phone,
            type: 'text',
            text: { body: message }
        };

        if (replyToId) payload.context = { message_id: replyToId };

        const { data } = await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            payload,
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );

        // Guardar en DB con waMessageId para poder enlazar reacciones/replies
        const waMessageId = data?.messages?.[0]?.id;
        saveMessage(phone, phone, {
            direction:   'outgoing',
            type:        'text',
            text:        message,
            waMessageId: waMessageId || null,
            ...(replyToId ? { replyTo: { id: replyToId } } : {})
        });

        res.json({ ok: true });
    } catch (error) {
        console.error('Error enviando:', error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data || 'Error al enviar' });
    }
});

// ─────────────────────────────────────────
//  API — ENVIAR MEDIA (imagen, audio, doc, sticker)
// ─────────────────────────────────────────
app.post('/api/send-media', upload.single('file'), async (req, res) => {
    const { phone, type, replyToId } = req.body;
    const file = req.file;
    if (!phone || !file || !type) return res.status(400).json({ error: 'Faltan datos' });

    try {
        // 1. Subir archivo a Meta
        const fd = new FormData();
        fd.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });
        fd.append('messaging_product', 'whatsapp');

        const uploadRes = await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/media`,
            fd,
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...fd.getHeaders() } }
        );
        const mediaId = uploadRes.data?.id;
        if (!mediaId) throw new Error('No se obtuvo media ID');

        // 2. Enviar mensaje con el media ID
        const payload = {
            messaging_product: 'whatsapp',
            to:   phone,
            type: type === 'sticker' ? 'sticker' : type
        };
        payload[type] = { id: mediaId };
        if (replyToId) payload.context = { message_id: replyToId };

        const { data } = await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            payload,
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
        );

        const waMessageId = data?.messages?.[0]?.id;

        // 3. Guardar en DB
        saveMessage(phone, phone, {
            direction:   'outgoing',
            type,
            mediaUrl:    null, // se cargó pero Meta no devuelve URL pública del propio archivo
            fileName:    file.originalname,
            text:        `[${type}: ${file.originalname}]`,
            waMessageId: waMessageId || null,
            ...(replyToId ? { replyTo: { id: replyToId } } : {})
        });

        res.json({ ok: true });
    } catch (error) {
        console.error('Error enviando media:', error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data || 'Error al enviar media' });
    }
});

// ─────────────────────────────────────────
//  API — ENVIAR REACCIÓN
// ─────────────────────────────────────────
app.post('/api/react', async (req, res) => {
    const { phone, msgId, emoji } = req.body;
    if (!phone || !msgId || !emoji) return res.status(400).json({ error: 'Faltan datos' });

    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to:   phone,
                type: 'reaction',
                reaction: { message_id: msgId, emoji }
            },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );

        // Guardar reacción en DB localmente
        const db   = loadDB();
        const conv = db.conversations[phone];
        if (conv) {
            const target = conv.messages.find(m => String(m.id) === String(msgId) || String(m.waMessageId) === String(msgId));
            if (target) {
                if (!target.reactions) target.reactions = [];
                // Reemplazar si ya existe reacción propia
                target.reactions = target.reactions.filter(r => r.from !== 'me');
                target.reactions.push({ emoji, from: 'me' });
                saveDB(db);
            }
        }

        res.json({ ok: true });
    } catch (error) {
        console.error('Error enviando reacción:', error.response?.data || error.message);
        res.status(500).json({ error: 'Error al reaccionar' });
    }
});

// ─────────────────────────────────────────
//  API — STATS Y CONTACTOS
// ─────────────────────────────────────────
app.get('/stats', (req, res) => {
    res.json({ status: '🟢 Activo', ...getStats(), contactosPermitidos: listContacts().length });
});

app.get('/contacts', (req, res) => {
    res.json({ contactos: listContacts() });
});

app.post('/contacts/add', (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Falta el número' });
    addContact(phone);
    res.json({ ok: true });
});

app.post('/contacts/remove', (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Falta el número' });
    removeContact(phone);
    res.json({ ok: true });
});

// ─────────────────────────────────────────
//  ARRANQUE
// ─────────────────────────────────────────
app.listen(PORT, () => {
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  🛡️  WhatsApp Guard — ACTIVO');
    console.log(`  Puerto: ${PORT}`);
    console.log(`  Panel: http://localhost:${PORT}/panel.html`);
    console.log(`  Contactos permitidos: ${listContacts().length}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
});