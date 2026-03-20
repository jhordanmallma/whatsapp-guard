require('dotenv').config();
const express = require('express');
const { isAllowed, addContact, removeContact, listContacts } = require('./contacts');
const { logBlocked, logAllowed, logCallBlocked, getStats } = require('./logger');

const app = express();
app.use(express.json());

const {
    VERIFY_TOKEN,
    WHATSAPP_TOKEN,
    PHONE_NUMBER_ID,
    PORT = 3000
} = process.env;

app.get('/webhook', (req, res) => {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ Webhook verificado correctamente por Meta');
        return res.status(200).send(challenge);
    }
    console.log('❌ Verificación fallida — token incorrecto');
    res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
    const body = req.body;
    res.sendStatus(200);

    if (body.object !== 'whatsapp_business_account') return;

    try {
        const entry   = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value   = changes?.value;

        if (!value) return;

        if (value.messages && value.messages.length > 0) {
            const message = value.messages[0];
            const senderPhone = message.from;
            const messageType = message.type;

            if (isAllowed(senderPhone)) {
                logAllowed(senderPhone);
                processMessage(message, value.contacts?.[0]);
            } else {
                logBlocked(senderPhone, messageType);
            }
        }

        if (value.statuses && value.statuses.length > 0) {
            value.statuses.forEach(status => {
                if (status.type === 'call') {
                    const callerPhone = status.recipient_id;
                    if (!isAllowed(callerPhone)) {
                        logCallBlocked(callerPhone);
                    }
                }
            });
        }

    } catch (error) {
        console.error('Error procesando webhook:', error.message);
    }
});

function processMessage(message, contactInfo) {
    const name  = contactInfo?.profile?.name || 'Sin nombre';
    const phone = message.from;
    const type  = message.type;
    console.log(`📨 Mensaje de ${name} (+${phone}) — tipo: ${type}`);
    if (type === 'text') {
        console.log(`   Contenido: "${message.text?.body}"`);
    }
}

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
    res.json({ ok: true, message: `+${phone} agregado a la whitelist` });
});

app.post('/contacts/remove', (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Falta el número' });
    removeContact(phone);
    res.json({ ok: true, message: `+${phone} eliminado de la whitelist` });
});

app.listen(PORT, () => {
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  🛡️  WhatsApp Guard — ACTIVO');
    console.log(`  Puerto: ${PORT}`);
    console.log(`  Contactos permitidos: ${listContacts().length}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
});