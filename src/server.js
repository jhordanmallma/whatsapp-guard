require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { isAllowed, addContact, removeContact, listContacts } = require('./contacts');
const { logBlocked, logAllowed, logCallBlocked, getStats } = require('./logger');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const { VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, PORT = 3000 } = process.env;

// Base de datos simple en JSON
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

function saveMessage(phone, name, message, direction) {
    const db = loadDB();
    if (!db.conversations[phone]) {
        db.conversations[phone] = { name, phone, messages: [] };
    }
    db.conversations[phone].messages.push({
        id: Date.now(),
        text: message,
        direction,
        time: new Date().toISOString()
    });
    db.conversations[phone].lastMessage = message;
    db.conversations[phone].lastTime = new Date().toISOString();
    saveDB(db);
}

// Verificación webhook
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

// Recepción de mensajes
app.post('/webhook', (req, res) => {
    const body = req.body;
    res.sendStatus(200);
    if (body.object !== 'whatsapp_business_account') return;
    try {
        const value = body.entry?.[0]?.changes?.[0]?.value;
        if (!value) return;
        if (value.messages && value.messages.length > 0) {
            const message = value.messages[0];
            const senderPhone = message.from;
            const senderName = value.contacts?.[0]?.profile?.name || senderPhone;
            const text = message.text?.body || `[${message.type}]`;
            if (isAllowed(senderPhone)) {
                logAllowed(senderPhone);
                saveMessage(senderPhone, senderName, text, 'incoming');
            } else {
                logBlocked(senderPhone, message.type);
            }
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
});

// API del panel
app.get('/api/conversations', (req, res) => {
    const db = loadDB();
    const list = Object.values(db.conversations)
        .sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
    res.json(list);
});

app.get('/api/conversations/:phone', (req, res) => {
    const db = loadDB();
    const conv = db.conversations[req.params.phone];
    if (!conv) return res.status(404).json({ error: 'No encontrado' });
    res.json(conv);
});

// Enviar mensaje
app.post('/api/send', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Faltan datos' });
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: phone,
                type: 'text',
                text: { body: message }
            },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );
        saveMessage(phone, phone, message, 'outgoing');
        res.json({ ok: true });
    } catch (error) {
        console.error('Error enviando:', error.response?.data || error.message);
        res.status(500).json({ error: 'Error al enviar' });
    }
});

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