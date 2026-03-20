let whitelist = new Set(
    (process.env.WHITELIST_NUMBERS || '')
        .split(',')
        .map(n => n.trim())
        .filter(n => n.length > 0)
);

function isAllowed(phoneNumber) {
    const cleaned = phoneNumber.replace(/\D/g, '');
    return whitelist.has(cleaned);
}

function addContact(phoneNumber) {
    const cleaned = phoneNumber.replace(/\D/g, '');
    whitelist.add(cleaned);
    console.log(`✅ Contacto agregado: ${cleaned}`);
}

function removeContact(phoneNumber) {
    const cleaned = phoneNumber.replace(/\D/g, '');
    whitelist.delete(cleaned);
    console.log(`🗑️  Contacto eliminado: ${cleaned}`);
}

function listContacts() {
    return Array.from(whitelist);
}

module.exports = { isAllowed, addContact, removeContact, listContacts };