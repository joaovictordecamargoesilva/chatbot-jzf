DisconnectReason, 
fetchLatestBaileysVersion, 
downloadMediaMessage,
    delay
    delay,
    Browsers
} = pkg;

import pino from 'pino';
import QRCode from 'qrcode';

// --- MANIPULADORES GLOBAIS DE ERRO DE PROCESSO ---
process.on('uncaughtException', (err, origin) => {
  if (err.message && (err.message.includes('Bad MAC') || err.message.includes('decryption'))) {
      console.warn(`[WARNING - DECRYPTION] Erro de descriptografia (Bad MAC). Geralmente resolvido automaticamente.`);
// --- MANIPULADORES GLOBAIS DE ERRO ---
process.on('uncaughtException', (err) => {
  if (err.message && (err.message.includes('Bad MAC') || err.message.includes('decryption') || err.message.includes('ciphertext'))) {
      console.warn(`[WhatsApp] Aviso: Erro de descriptografia (Bad MAC). Geralmente ignorado.`);
return;
}
  if (err.code === 'ENOSPC') {
      console.error(`[CRITICAL] DISCO CHEIO (ENOSPC). Limpando...`);
      cleanupStorage();
      return;
  }
  console.error(`[FATAL] Exceção: ${err.message}`, { stack: err.stack, origin });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Rejeição não tratada:', reason);
  console.error(`[Fatal] Erro Crítico no Processo: ${err.message}`);
});

const SERVER_VERSION = "30.4.0_404_STABILITY_FIX";
console.log(`[JZF Chatbot Server] Iniciando... Versão: ${SERVER_VERSION}`);
const SERVER_VERSION = "30.6.0_STABILITY_AND_ROUTES_FIX";
console.log(`[JZF Server] Iniciando Versão: ${SERVER_VERSION}`);

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;
@@ -68,54 +59,29 @@ const MEDIA_DIR = path.join(DATA_DIR, 'media');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// --- SISTEMA DE LIMPEZA AGRESSIVO ---
function cleanupStorage() {
    try {
        const files = fs.readdirSync(MEDIA_DIR);
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(MEDIA_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(filePath);
        });
    } catch (e) {}
}
setInterval(cleanupStorage, 4 * 60 * 60 * 1000);

// Persistence
// --- PERSISTÊNCIA ---
const saveData = (filename, data) => {
try {
const filePath = path.join(DATA_DIR, filename);
let dataToSave = data;
if (data instanceof Map) dataToSave = Array.from(data.entries());
fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));
  } catch (e) {}
  } catch (e) { console.error(`Erro ao salvar ${filename}`); }
};

const loadData = (filename, defaultValue) => {
try {
const filePath = path.join(DATA_DIR, filename);
if (!fs.existsSync(filePath)) return defaultValue;
const content = fs.readFileSync(filePath, 'utf8');
    if (!content) return defaultValue;
const parsed = JSON.parse(content);
if (defaultValue instanceof Map) return new Map(parsed);
return parsed;
} catch (e) { return defaultValue; }
};

const saveMediaToDisk = (base64Data, mimeType, originalName) => {
    try {
        if (!base64Data) return null;
        let ext = path.extname(originalName || '').substring(1);
        if (!ext) ext = mimeType.split('/')[1] || 'bin';
        const fileName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const filePath = path.join(MEDIA_DIR, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        return `/media/${fileName}`; 
    } catch (e) { return null; }
};

// --- ESTADO ---
// --- ESTADO GLOBAL ---
let ATTENDANTS = loadData('attendants.json', [{ id: 'attendant_1', name: 'Admin' }]);
const userSessions = loadData('userSessions.json', new Map());
const activeChats = loadData('activeChats.json', new Map());
@@ -126,22 +92,36 @@ let sock = null;

const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

// --- STORE & NAME RESOLUTION ---
let contacts = {};
try { contacts = loadData('baileys_store.json', {}).contacts || {}; } catch(e) {}
// --- LOGICA DO BOT ---

function resolveBestName(userId, pushName = null) {
    const contact = contacts[userId];
    return contact?.name || contact?.notify || pushName || userId.split('@')[0];
function getSession(userId, userName = null) {
    let session = activeChats.get(userId) || userSessions.get(userId);
    if (!session) {
        session = { 
            userId, 
            userName: userName || userId.split('@')[0], 
            currentState: ChatState.GREETING, 
            context: { history: {} }, 
            aiHistory: [], 
            messageLog: [], 
            handledBy: 'bot', 
            createdAt: new Date().toISOString() 
        };
        userSessions.set(userId, session);
        saveData('userSessions.json', userSessions);
    }
    return session;
}

// --- BOT LOGIC ---
async function handleBotResponse(userId, userInput, session) {
const config = conversationFlow.get(session.currentState);
if (!config || session.handledBy === 'human') return;

    const inputClean = userInput.trim();

    // 1. Tentar processar como Opção (Número)
if (config.options) {
        const optionIndex = parseInt(userInput.trim()) - 1;
        const optionIndex = parseInt(inputClean) - 1;
if (!isNaN(optionIndex) && config.options[optionIndex]) {
const selected = config.options[optionIndex];
session.currentState = selected.nextState;
@@ -150,22 +130,25 @@ async function handleBotResponse(userId, userInput, session) {
}
}

    // 2. Tentar processar como entrada de texto
if (config.requiresTextInput) {
if (session.currentState === ChatState.AI_ASSISTANT_CHATTING) {
            return handleAiChat(userId, userInput, session);
            return handleAiChat(userId, inputClean, session);
} else {
            session.context.history[session.currentState] = userInput;
            session.context.history[session.currentState] = inputClean;
if (config.nextState) {
session.currentState = config.nextState;
return sendCurrentStateMenu(userId, session);
}
}
}
    if (session.currentState !== ChatState.AI_ASSISTANT_CHATTING) sendCurrentStateMenu(userId, session);

    // 3. Fallback: Se não entendeu o comando ou é uma mensagem genérica, re-envia o menu
    sendCurrentStateMenu(userId, session);
}

async function handleAiChat(userId, userInput, session) {
    if (!ai) return queueOutbound(userId, { text: "IA offline." });
    if (!ai) return queueOutbound(userId, { text: "Assistente de IA temporariamente indisponível." });
try {
const dept = session.context.department || "Contábil";
const instruction = departmentSystemInstructions.pt[dept] || departmentSystemInstructions.pt["Contábil"];
@@ -174,18 +157,36 @@ async function handleAiChat(userId, userInput, session) {
contents: [{ parts: [{ text: `Usuário: ${userInput}` }] }],
config: { systemInstruction: instruction }
});

queueOutbound(userId, { text: response.text });
    } catch (e) { queueOutbound(userId, { text: "Erro na IA." }); }
        
        // Re-envia as opções de navegação da IA
        const config = conversationFlow.get(ChatState.AI_ASSISTANT_CHATTING);
        let menuText = "\n\n--- OPÇÕES ---\n";
        config.options.forEach((opt, idx) => {
            menuText += `*${idx + 1}* - ${translations.pt[opt.textKey] || opt.textKey}\n`;
        });
        queueOutbound(userId, { text: menuText });

    } catch (e) { 
        queueOutbound(userId, { text: "Tive um problema técnico. Pode repetir sua pergunta?" });
    }
}

function sendCurrentStateMenu(userId, session) {
const config = conversationFlow.get(session.currentState);
if (!config) return;
    let text = typeof config.textKey === 'function' ? config.textKey(session) : (translations.pt[config.textKey] || config.textKey);

    let textTemplate = translations.pt[config.textKey] || config.textKey;
    let text = typeof textTemplate === 'function' ? textTemplate(session.context || session) : textTemplate;
    
if (config.options) {
        text += "\n\nEscolha:\n";
        config.options.forEach((opt, idx) => { text += `*${idx + 1}* - ${translations.pt[opt.textKey] || opt.textKey}\n`; });
        text += "\n\nEscolha uma opção digitando o número correspondente:\n";
        config.options.forEach((opt, idx) => {
            text += `*${idx + 1}* - ${translations.pt[opt.textKey] || opt.textKey}\n`;
        });
}

queueOutbound(userId, { text });

if (session.currentState === ChatState.ATTENDANT_TRANSFER || session.currentState === ChatState.SCHEDULING_CONFIRMED) {
@@ -196,82 +197,158 @@ function sendCurrentStateMenu(userId, session) {
}
}

// --- WHATSAPP CORE ---
// --- WHATSAPP ENGINE ---

async function startWhatsApp() {
gatewayStatus.status = 'LOADING';
try {
const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, 'baileys_auth_info'));
const { version } = await fetchLatestBaileysVersion();
        sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: true, browser: ['JZF Chat', 'Chrome', '1.0.0'] });
        
        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            browser: Browsers.macOS('Desktop'),
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            retryRequestDelayMs: 2000
        });

sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (u) => {
            if (u.qr) { gatewayStatus.qrCode = await QRCode.toDataURL(u.qr); gatewayStatus.status = 'QR_CODE_READY'; }
            if (u.connection === 'open') { gatewayStatus.status = 'CONNECTED'; gatewayStatus.qrCode = null; }
            if (u.connection === 'close') setTimeout(startWhatsApp, 5000);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                gatewayStatus.qrCode = await QRCode.toDataURL(qr);
                gatewayStatus.status = 'QR_CODE_READY';
            }
            if (connection === 'open') {
                gatewayStatus.status = 'CONNECTED';
                gatewayStatus.qrCode = null;
                console.log('[WhatsApp] Online!');
            }
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                gatewayStatus.status = 'DISCONNECTED';
                if (shouldReconnect) setTimeout(startWhatsApp, 5000);
            }
});

sock.ev.on('messages.upsert', async ({ messages, type }) => {
if (type !== 'notify') return;
for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;
                if (msg.key.fromMe) continue;
                
const cleanId = msg.key.remoteJid.replace(/:.*$/, '');
                const name = resolveBestName(cleanId, msg.pushName);
                const name = msg.pushName || cleanId.split('@')[0];
                
                // Se não houver mensagem legível, pode ser erro de chave ou mídia sem legenda
                if (!msg.message) {
                    console.warn(`[WhatsApp] Mensagem ignorada de ${cleanId} (Provável Bad MAC ou Erro de Chave).`);
                    // Mesmo com erro de descriptografia, inicializamos a sessão se for nova
                    getSession(cleanId, name);
                    continue;
                }

let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                
                // Tratar mídia básica
                if (!text) {
                    if (msg.message.imageMessage) text = msg.message.imageMessage.caption || "";
                    if (msg.message.videoMessage) text = msg.message.videoMessage.caption || "";
                    if (msg.message.documentMessage) text = msg.message.documentMessage.caption || "";
                }

await processIncomingMessage({ userId: cleanId, userName: name, userInput: text });
}
});
    } catch (e) { setTimeout(startWhatsApp, 5000); }

    } catch (e) {
        console.error('[WhatsApp] Erro fatal:', e);
        setTimeout(startWhatsApp, 10000);
    }
}

async function processIncomingMessage({ userId, userName, userInput }) {
const session = getSession(userId, userName);
    session.messageLog.push({ sender: 'user', text: userInput, timestamp: new Date().toISOString() });
    if (session.handledBy === 'bot') await handleBotResponse(userId, userInput, session);
    
    session.messageLog.push({ sender: 'user', text: userInput || "(Mídia)", timestamp: new Date().toISOString() });

    if (session.handledBy === 'bot') {
        // Se for a PRIMEIRA mensagem real ou se o bot estiver no estado inicial, envia o menu
        if (session.messageLog.length === 1 || session.currentState === ChatState.GREETING) {
             // Se o usuário já enviou algo que não seja comando, tratamos como saudação
             await handleBotResponse(userId, userInput, session);
        } else {
             await handleBotResponse(userId, userInput, session);
        }
    }

saveData(activeChats.has(userId) ? 'activeChats.json' : 'userSessions.json', activeChats.has(userId) ? activeChats : userSessions);
}

function queueOutbound(userId, content) { outboundGatewayQueue.push({ userId, ...content }); }
function queueOutbound(userId, content) {
    outboundGatewayQueue.push({ userId, ...content, retry: 0 });
}

async function processOutboundQueue() {
if (outboundGatewayQueue.length > 0 && sock && gatewayStatus.status === 'CONNECTED') {
const item = outboundGatewayQueue.shift();
try {
const jid = item.userId.includes('@') ? item.userId : item.userId + '@s.whatsapp.net';
await sock.sendMessage(jid, { text: item.text });
        } catch (e) { outboundGatewayQueue.push(item); }
        } catch (e) {
            if (item.retry < 3) {
                item.retry++;
                outboundGatewayQueue.push(item);
            }
        }
}
setTimeout(processOutboundQueue, 1500);
}

function getSession(userId, userName = null) {
    let session = activeChats.get(userId) || userSessions.get(userId);
    if (!session) {
        session = { userId, userName: userName || userId.split('@')[0], currentState: ChatState.GREETING, context: { history: {} }, aiHistory: [], messageLog: [], handledBy: 'bot', createdAt: new Date().toISOString() };
        userSessions.set(userId, session);
        setTimeout(() => sendCurrentStateMenu(userId, session), 1000);
    }
    return session;
}
// --- EXPRESS API (CORREÇÃO DE ROTAS 404) ---

// --- EXPRESS SETUP ---
app.use(express.json({ limit: '50mb' }));
app.use('/media', express.static(MEDIA_DIR));

// ROTAS UNIFICADAS (Garante que /attendants e /api/attendants funcionem)
const unifiedRoutes = (path, handler) => {
    app.get(path, handler);
    app.get(`/api${path}`, handler);
// Helper para expor rotas em múltiplos caminhos requisitados pelo frontend
const expose = (paths, handler) => {
    const p = Array.isArray(paths) ? paths : [paths];
    p.forEach(path => {
        app.get(path, handler);
        app.get(`/api${path}`, handler);
    });
};

unifiedRoutes('/attendants', (req, res) => res.json(ATTENDANTS));
unifiedRoutes('/requests', (req, res) => res.json(requestQueue));
unifiedRoutes('/ai-active', (req, res) => res.json(Array.from(userSessions.values()).filter(s => s.handledBy === 'bot')));
unifiedRoutes('/history', (req, res) => {
expose(['/attendants'], (req, res) => res.json(ATTENDANTS));
expose(['/requests'], (req, res) => res.json(requestQueue));
expose(['/ai-active'], (req, res) => res.json(Array.from(userSessions.values()).filter(s => s.handledBy === 'bot')));
expose(['/history'], (req, res) => {
const { userId } = req.query;
const chat = activeChats.get(userId) || userSessions.get(userId);
res.json(chat || { userId, messageLog: [] });
});
expose(['/active', '/chats/active'], (req, res) => {
    res.json(Array.from(activeChats.values()));
});
expose(['/clients'], (req, res) => {
    const clients = Array.from(userSessions.values()).map(s => ({ userId: s.userId, userName: s.userName }));
    res.json(clients);
});

// Handler para attendant específico
app.get(['/attendant_*', '/api/attendant_*'], (req, res) => {
    const id = req.path.split('/').pop();
    const attendant = ATTENDANTS.find(a => a.id === id);
    if (attendant) res.json(attendant);
    else res.status(404).json({ error: "Atendente não encontrado" });
});

app.get('/api/gateway/status', (req, res) => res.json(gatewayStatus));

app.post('/api/chats/takeover/:userId', (req, res) => {
const { userId } = req.params;
let session = getSession(userId);
@@ -281,7 +358,7 @@ app.post('/api/chats/takeover/:userId', (req, res) => {
requestQueue = requestQueue.filter(r => r.userId !== userId);
saveData('activeChats.json', activeChats);
saveData('requestQueue.json', requestQueue);
    queueOutbound(userId, { text: "Olá! Sou um atendente humano. Como posso ajudar?" });
    queueOutbound(userId, { text: "Olá! Assumi seu atendimento. Como posso ajudar?" });
res.json(session);
});

@@ -296,9 +373,15 @@ app.post('/api/chats/attendant-reply', (req, res) => {
} else res.status(404).send();
});

// Arquivos estáticos por ÚLTIMO para não interceptar as APIs
// Arquivos do frontend (Dist)
app.use(express.static(path.join(__dirname, 'dist')));

// Redireciona qualquer outra rota para o index.html (SPA)
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/media')) return next();
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

startWhatsApp();
processOutboundQueue();
app.listen(port, () => console.log(`Online na porta ${port}`));
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
