const stats = {
    blocked: 0,
    allowed: 0,
    callsBlocked: 0,
    startTime: new Date()
};

function logBlocked(phone, type = 'mensaje') {
    stats.blocked++;
    const time = new Date().toLocaleTimeString('es-PE');
    console.log(`🚫 [${time}] BLOQUEADO (${type}) de: +${phone}`);
}

function logAllowed(phone) {
    stats.allowed++;
    const time = new Date().toLocaleTimeString('es-PE');
    console.log(`✅ [${time}] PERMITIDO mensaje de: +${phone}`);
}

function logCallBlocked(phone) {
    stats.callsBlocked++;
    const time = new Date().toLocaleTimeString('es-PE');
    console.log(`📵 [${time}] LLAMADA BLOQUEADA de: +${phone}`);
}

function getStats() {
    return {
        ...stats,
        uptime: Math.floor((new Date() - stats.startTime) / 1000 / 60) + ' minutos'
    };
}

module.exports = { logBlocked, logAllowed, logCallBlocked, getStats };