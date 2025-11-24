// --- SERVIDOR DE API INTEGRADO COM WHATSAPP (BAILEYS) ---
// Versão Monolítica: Express + Lógica de Negócio + Conexão WhatsApp no mesmo processo.

import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  ChatState,
  conversationFlow,
  departmentSystemInstructions,
  translations
} from './chatbotLogic.js';

// --- IMPORTAÇÕES DO BAILEYS ---
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    downloadMediaMessage 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

// --- MANIPULADORES GLOBAIS DE ERRO DE PROCESSO ---
process.on('uncaughtException', (err, origin) => {
  console.error(`[FATAL] Exceção não capturada: ${err.message}`, { stack: err.stack, origin: origin });
  // Em produção crítica, talvez não sair, mas reiniciar a conexão do WPP
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Rejeição de Promise não tratada:', { reason: reason, promise: promise });
});

const SERVER_VERSION = "21.0.3_FEATURES_UPDATE";
console.log(`[JZF Chatbot Server] Iniciando... Versão: ${SERVER_VERSION}`);

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- PERSISTÊNCIA DE DADOS ---
const DATA_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  console.log(`[Persistence] Criando diretório de dados em: ${DATA_DIR}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helper functions
const serializeMap = (map) => Array.from(map.entries());
const deserializeMap = (arr) => new Map(arr);

const saveData = (filename, data) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    let dataToSave = data;
    if (data instanceof Map) dataToSave = serializeMap(data);
    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2), 'utf8');
  } catch (error) {
    console.error(`[Persistence] ERRO CRÍTICO ao salvar dados em ${filename}:`, error);
  }
};

const loadData = (filename, defaultValue) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      if (fileContent.trim() === '') return defaultValue;
      const parsedData = JSON.parse(fileContent);
      if (defaultValue instanceof Map && Array.isArray(parsedData)) return deserializeMap(parsedData);
      return parsedData;
    }
  } catch (error) {
    console.error(`[Persistence] ERRO ao carregar ${filename}.`, error);
  }
  return defaultValue;
};

// --- ESTADO DO SISTEMA ---
let ATTENDANTS = loadData('attendants.json', []);
let nextAttendantId = ATTENDANTS.length > 0 ? Math.max(...ATTENDANTS.map(a => parseInt(a.id.split('_')[1]))) + 1 : 1;

const userSessions = loadData('userSessions.json', new Map());
let requestQueue = loadData('requestQueue.json', []);
const activeChats = loadData('activeChats.json', new Map());
const archivedChats = loadData('archivedChats.json', new Map());
const internalChats = loadData('internalChats.json', new Map());
let syncedContacts = loadData('syncedContacts.json', []);

let nextRequestId = requestQueue.length > 0 && requestQueue.every(r => typeof r.id === 'number') ? Math.max(...requestQueue.map(r => r.id)) + 1 : 1;
const MAX_SESSIONS = 2000;
const MAX_ARCHIVED_CHATS = 500;

// Filas internas
const outboundGatewayQueue = []; // Fila de mensagens para enviar via WhatsApp
const pendingEdits = new Map();

// Status do Gateway (WhatsApp)
let gatewayStatus = { status: 'DISCONNECTED', qrCode: null };
let sock = null; // Instância do socket do Baileys
const apiRouter = express.Router(); // Declarar Router aqui para uso global

// --- MIDDLEWARE ---
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  // console.log(`[Request] ${req.method} ${req.originalUrl}`); // Verbose off
  next();
});

// --- CONFIGURAÇÃO IA (GEMINI) ---
let ai = null;
if (API_KEY) {
    try {
        ai = new GoogleGenAI({apiKey: API_KEY});
        console.log("[AI] Cliente Google GenAI inicializado.");
    } catch (error) {
        console.error("[AI] ERRO na inicialização da IA.", error);
    }
}

async function transcribeAudio(file) {
    if (!ai) return "[Áudio não transcrito - IA indisponível]";
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ parts: [{ inlineData: { mimeType: file.type, data: file.data } }, { text: "Transcreva este áudio em português do Brasil de forma literal." }] }],
        });
        return response?.text?.trim() || "[Transcrição vazia]";
    } catch (error) {
        console.error("[Transcribe] Erro:", error);
        return `[Erro na transcrição]`;
    }
}

// --- LÓGICA DE SESSÃO ---
function archiveSession(session) {
    if (!session?.userId) return;
    const userHistory = archivedChats.get(session.userId) || [];
    userHistory.push({ ...session });
    archivedChats.set(session.userId, userHistory);
    saveData('archivedChats.json', archivedChats);
    if (archivedChats.size > MAX_ARCHIVED_CHATS) {
        const oldestKey = archivedChats.keys().next().value;
        archivedChats.delete(oldestKey);
        saveData('archivedChats.json', archivedChats);
    }
}

function getSession(userId, userName = null) {
    let session = activeChats.get(userId) || userSessions.get(userId);
    if (!session) {
        if (userSessions.size >= MAX_SESSIONS) userSessions.delete(userSessions.keys().next().value);
        session = {
            userId, userName, currentState: ChatState.GREETING,
            context: { history: {} }, aiHistory: [], messageLog: [],
            handledBy: 'bot', attendantId: null, createdAt: new Date().toISOString(),
        };
        userSessions.set(userId, session);
        saveData('userSessions.json', userSessions);
    } else if (userName && session.userName !== userName) {
        session.userName = userName;
    }
    return session;
}

function addRequestToQueue(session, department, message) {
    if (requestQueue.some(r => r.userId === session.userId) || activeChats.has(session.userId)) return;
    const request = { id: nextRequestId++, userId: session.userId, userName: session.userName, department, message, timestamp: new Date().toISOString() };
    requestQueue.unshift(request);
    saveData('requestQueue.json', requestQueue);
    console.log(`[Queue] Nova solicitação: ${session.userName} -> ${department}`);
}

// --- LÓGICA DO CHATBOT ---
function formatFlowStepForWhatsapp(step, context) {
    let messageText = '';
    const textTemplate = translations.pt[step.textKey];
    if (textTemplate) messageText = typeof textTemplate === 'function' ? textTemplate(context) : textTemplate;
    if (step.options?.length > 0) {
        messageText += `\n\n${step.options.map((opt, i) => `*${i + 1}*. ${translations.pt[opt.textKey] || opt.textKey}`).join('\n')}`;
    }
    return messageText;
}

async function processMessage(session, userInput, file) {
    const { userId } = session;
    
    // Recuperação de erro de estado
    if (!conversationFlow.has(session.currentState)) session.currentState = ChatState.GREETING;
    
    let currentStep = conversationFlow.get(session.currentState);
    let nextState, payload;

    const choice = parseInt(userInput.trim(), 10);
    const selectedOption = (currentStep.options && !isNaN(choice)) ? currentStep.options[choice - 1] : null;

    if (selectedOption) {
        nextState = selectedOption.nextState;
        payload = selectedOption.payload;
    } else if (currentStep.requiresTextInput) {
        if (session.currentState === ChatState.AI_ASSISTANT_CHATTING) {
            if (!ai) {
                queueOutbound(userId, { text: "IA indisponível no momento." });
                return;
            }
            try {
                session.aiHistory.push({ role: 'user', parts: [{ text: userInput }] });
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: session.aiHistory,
                    config: { systemInstruction: departmentSystemInstructions.pt[session.context.department] || "Você é um assistente prestativo." }
                });
                const aiText = response.text;
                queueOutbound(userId, { text: aiText });
                session.messageLog.push({ sender: 'bot', text: aiText, timestamp: new Date() });
                session.aiHistory.push({ role: 'model', parts: [{ text: aiText }] });
            } catch (error) {
                console.error(`[AI] Erro:`, error);
                queueOutbound(userId, { text: translations.pt.error });
            }
            return;
        }
        nextState = currentStep.nextState;
        session.context.history[session.currentState] = userInput;
    } else {
        // Entrada inválida
        if (session.currentState !== ChatState.GREETING) {
            queueOutbound(userId, { text: "Opção inválida. Digite apenas o número." });
        }
        const retryMsg = formatFlowStepForWhatsapp(currentStep, session.context);
        queueOutbound(userId, { text: retryMsg });
        return;
    }
    
    if (payload) session.context = { ...session.context, ...payload };
    
    if (nextState === ChatState.END_SESSION) {
        queueOutbound(userId, { text: translations.pt.sessionEnded });
        session.resolvedBy = "Cliente";
        session.resolvedAt = new Date().toISOString();
        archiveSession(session);
        userSessions.delete(userId);
        saveData('userSessions.json', userSessions);
        return;
    }
    
    let currentState = nextState;
    while(currentState) {
        session.currentState = currentState;
        const step = conversationFlow.get(currentState);
        
        // Lógica de Transferência/Fila
        if (currentState === ChatState.ATTENDANT_TRANSFER || currentState === ChatState.SCHEDULING_CONFIRMED) {
            const department = currentState === ChatState.SCHEDULING_CONFIRMED ? 'Agendamento' : session.context.department;
            const details = session.context.history[ChatState.SCHEDULING_NEW_CLIENT_DETAILS] || session.context.history[ChatState.SCHEDULING_EXISTING_CLIENT_DETAILS];
            const reason = currentState === ChatState.SCHEDULING_CONFIRMED ? `Agendamento: ${session.context.clientType} - ${details}` : `Contato para setor ${department}.`;
            addRequestToQueue(session, department, reason);
            session.handledBy = 'bot_queued';
        }

        const reply = formatFlowStepForWhatsapp(step, session.context);
        queueOutbound(userId, { text: reply });
        session.messageLog.push({ sender: 'bot', text: reply, timestamp: new Date() });
        
        if (step.nextState && !step.requiresTextInput && (!step.options || step.options.length === 0)) {
            currentState = step.nextState;
            await new Promise(r => setTimeout(r, 500));
        } else {
            currentState = null;
        }
    }
}

// Função auxiliar para enfileirar mensagens de saída (abstração)
function queueOutbound(userId, content) {
    outboundGatewayQueue.push({ userId, ...content });
}

// --- PROCESSADOR DE MENSAGENS RECEBIDAS (INTERNO) ---
async function processIncomingMessage({ userId, userName, userInput, file, replyContext }) {
    if (!userId) return;

    const session = getSession(userId, userName);
    let effectiveInput = userInput;

    const logEntry = { sender: 'user', text: userInput, timestamp: new Date().toISOString() };
    if (file) logEntry.files = [file];
    if (replyContext) {
        logEntry.replyTo = { text: replyContext.text, sender: replyContext.fromMe ? 'attendant' : 'user', senderName: replyContext.fromMe ? 'Você' : session.userName };
    }
    session.messageLog.push(logEntry);

    if (file?.type?.startsWith('audio/')) {
        const transcription = await transcribeAudio(file);
        effectiveInput = transcription;
        session.messageLog.push({ sender: 'system', text: `Transcrição: "${transcription}"`, timestamp: new Date().toISOString() });
    }
    
    if (session.handledBy === 'human' || session.handledBy === 'bot_queued') {
        if (activeChats.has(userId)) saveData('activeChats.json', activeChats);
        else saveData('userSessions.json', userSessions);
        return;
    }
    
    if (session.handledBy === 'bot') {
       await processMessage(session, effectiveInput, file);
       saveData('userSessions.json', userSessions);
    }
}

// --- INTEGRAÇÃO WHATSAPP (BAILEYS) ---
const SESSION_FOLDER = path.join(DATA_DIR, 'baileys_auth_info');

async function startWhatsApp() {
    console.log('[WhatsApp] Iniciando serviço...');
    gatewayStatus.status = 'LOADING';
    
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    
    console.log(`[WhatsApp] Versão Baileys: v${version.join('.')}`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['JZF Atendimento', 'Chrome', '1.0.0'], // Usando identificador estável
        // Otimizações de conexão
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: false,
        retryRequestDelayMs: 250,
        // Habilitar a busca de status de mensagens antigas se necessário
        getMessage: async (key) => {
            return { conversation: 'hello' };
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('[WhatsApp] Novo QR Code gerado');
            try {
                gatewayStatus.qrCode = await QRCode.toDataURL(qr);
                gatewayStatus.status = 'QR_CODE_READY';
            } catch (e) { console.error('Erro QR:', e); }
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            console.log(`[WhatsApp] Conexão fechada. Razão: ${reason}. Reconectar: ${shouldReconnect}`);
            
            gatewayStatus.status = 'DISCONNECTED';
            
            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            } else {
                console.log('[WhatsApp] Desconectado (Logout). Limpando sessão...');
                fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                gatewayStatus.qrCode = null;
                setTimeout(startWhatsApp, 1000);
            }
        } else if (connection === 'open') {
            console.log('[WhatsApp] >>> CONECTADO <<<');
            gatewayStatus.status = 'CONNECTED';
            gatewayStatus.qrCode = null;
        }
    });

    // --- MANIPULADOR DE ATUALIZAÇÃO DE STATUS (TICKS) ---
    sock.ev.on('messages.update', async (updates) => {
        let hasChanges = false;
        
        for (const update of updates) {
            // update.key.remoteJid é o ID do chat
            // update.update.status é o novo status (4 = lido, 3 = entregue)
            if (!update.update.status) continue;
            
            const userId = update.key.remoteJid;
            const session = activeChats.get(userId) || userSessions.get(userId);
            
            if (session) {
                // Procura a mensagem pelo whatsappId
                const msg = session.messageLog.find(m => m.whatsappId === update.key.id);
                if (msg) {
                    // Só atualiza se o status novo for maior que o atual (evita regressão de lido para entregue)
                    if (!msg.status || update.update.status > msg.status) {
                        msg.status = update.update.status;
                        hasChanges = true;
                    }
                }
            }
        }
        
        if (hasChanges) {
             saveData('activeChats.json', activeChats);
             saveData('userSessions.json', userSessions);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            
            // Marca como lido automaticamente se estivermos processando
            // await sock.readMessages([msg.key]); 

            const userId = msg.key.remoteJid;
            const userName = msg.pushName || userId.split('@')[0];
            
            let userInput = '';
            let filePayload = null;
            let replyContext = null;

            const messageType = Object.keys(msg.message)[0];
            const content = msg.message[messageType];

            // Extração de texto
            if (messageType === 'conversation') userInput = content;
            else if (messageType === 'extendedTextMessage') {
                userInput = content.text;
                const ctx = content.contextInfo;
                if (ctx?.quotedMessage) {
                     const quoted = ctx.quotedMessage;
                     const qBody = quoted.conversation || quoted.extendedTextMessage?.text || (quoted.imageMessage ? '[Imagem]' : '[Mídia]');
                     replyContext = { text: qBody, fromMe: ctx.participant === sock.user.id.split(':')[0] + '@s.whatsapp.net' };
                }
            } 
            // Extração de Mídia
            else if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType)) {
                userInput = content.caption || '';
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', { logger: pino({ level: 'silent' }) });
                    filePayload = {
                        name: `${messageType}.${content.mimetype.split('/')[1] || 'bin'}`,
                        type: content.mimetype,
                        data: buffer.toString('base64')
                    };
                } catch (err) { console.error('[WhatsApp] Erro download mídia:', err); }
            }

            if (!userInput && !filePayload) continue;

            // Processamento interno
            processIncomingMessage({ userId, userName, userInput, file: filePayload, replyContext });
        }
    });
}

// --- PROCESSADOR DE FILA DE SAÍDA (OUTBOUND LOOP) ---
// Processa mensagens enviadas pelo sistema/atendentes para o WhatsApp
setInterval(async () => {
    if (!sock || gatewayStatus.status !== 'CONNECTED' || outboundGatewayQueue.length === 0) return;

    const msg = outboundGatewayQueue.shift(); // Pega a próxima mensagem
    
    try {
        // Delay artificial para evitar banimento por spam
        await new Promise(r => setTimeout(r, 300 + Math.random() * 500));

        // Tratamento de Edição
        if (msg.type === 'edit') {
             await sock.sendMessage(msg.userId, { text: msg.newText, edit: { remoteJid: msg.userId, fromMe: true, id: msg.messageId } });
             return;
        }

        let sentMsg;
        // Tratamento de Arquivos
        if (msg.file && msg.file.data) {
            const buffer = Buffer.from(msg.file.data, 'base64');
            const mimetype = msg.file.type;
            const options = { caption: msg.text };
            
            if (mimetype.startsWith('image/')) sentMsg = await sock.sendMessage(msg.userId, { image: buffer, ...options });
            else if (mimetype.startsWith('video/')) sentMsg = await sock.sendMessage(msg.userId, { video: buffer, ...options });
            else if (mimetype.startsWith('audio/')) sentMsg = await sock.sendMessage(msg.userId, { audio: buffer, mimetype });
            else sentMsg = await sock.sendMessage(msg.userId, { document: buffer, mimetype, fileName: msg.file.name, ...options });
        } 
        // Tratamento de Texto Puro
        else if (msg.text) {
            sentMsg = await sock.sendMessage(msg.userId, { text: msg.text });
        }

        // Confirmação de envio (ACK para lógica interna)
        if (sentMsg && msg.tempId) {
            const session = activeChats.get(msg.userId) || userSessions.get(msg.userId);
            if (session) {
                const logMsg = session.messageLog.find(m => m.tempId === msg.tempId);
                if (logMsg) {
                    logMsg.whatsappId = sentMsg.key.id;
                    logMsg.status = 2; // SERVER_ACK (Enviado)
                    
                    if (activeChats.has(msg.userId)) saveData('activeChats.json', activeChats);
                    else saveData('userSessions.json', userSessions);
                    
                    // Se havia uma edição pendente para esta mensagem (race condition), executa agora
                    if (pendingEdits.has(msg.tempId)) {
                        const edit = pendingEdits.get(msg.tempId);
                        outboundGatewayQueue.unshift({ type: 'edit', userId: edit.userId, messageId: sentMsg.key.id, newText: edit.newText });
                        pendingEdits.delete(msg.tempId);
                    }
                }
            }
        }

    } catch (e) {
        console.error(`[WhatsApp] Erro no envio para ${msg.userId}:`, e.message);
        // Opcional: recolocar na fila se for erro de rede recuperável
    }
}, 500);


// --- ROTAS DA API (Express) ---

// Rotas simplificadas, removendo webhooks e polling externos
apiRouter.get('/gateway/status', (req, res) => res.json(gatewayStatus));

apiRouter.get('/health', (req, res) => res.send('OK'));
apiRouter.get('/attendants', (req, res) => res.json(ATTENDANTS));
apiRouter.post('/attendants', (req, res) => {
    const { name } = req.body;
    if (!name || name.trim().length < 2) return res.status(400).send('Nome inválido');
    const newAttendant = { id: `attendant_${nextAttendantId++}`, name: name.trim() };
    ATTENDANTS.push(newAttendant);
    saveData('attendants.json', ATTENDANTS);
    res.status(201).json(newAttendant);
});

apiRouter.get('/requests', (req, res) => res.json(requestQueue));

// Endpoint melhorado: Retorna também o último status e comprimento do log para facilitar o polling eficiente
apiRouter.get('/chats/active', (req, res) => {
    const list = Array.from(activeChats.values()).map(s => {
        const lastMsg = s.messageLog.slice(-1)[0];
        return { 
            userId: s.userId, 
            userName: s.userName, 
            attendantId: s.attendantId, 
            lastMessage: lastMsg,
            // Metadados extras para o frontend detectar mudanças sem baixar tudo
            logLength: s.messageLog.length,
            lastMsgStatus: lastMsg?.status
        };
    });
    res.json(list);
});

apiRouter.get('/chats/ai-active', (req, res) => {
    res.json(Array.from(userSessions.values()).filter(s => s.handledBy === 'bot' && !requestQueue.some(r => r.userId === s.userId) && s.currentState !== ChatState.GREETING).map(s => ({ userId: s.userId, userName: s.userName, department: s.context?.department, lastMessage: s.messageLog.slice(-1)[0] })));
});
apiRouter.get('/clients', (req, res) => res.json(syncedContacts));
apiRouter.get('/chats/history', (req, res) => {
    const history = Array.from(archivedChats.values()).map(uArr => uArr[uArr.length - 1]).sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));
    res.json(history);
});
apiRouter.get('/chats/history/:userId', (req, res) => {
    const { userId } = req.params;
    const current = activeChats.get(userId) || userSessions.get(userId);
    const hist = archivedChats.get(userId) || [];
    if (!current && hist.length === 0) return res.status(404).send('Chat não encontrado');
    const combinedLog = [...hist, ...(current ? [current] : [])].flatMap(s => s.messageLog).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const rep = current || hist[hist.length - 1];
    res.json({ userId: rep.userId, userName: rep.userName, attendantId: rep.attendantId, handledBy: rep.handledBy || 'human', context: rep.context, messageLog: combinedLog });
});

// Ações de Chat
apiRouter.post('/chats/takeover/:userId', (req, res) => {
    const { userId } = req.params;
    const { attendantId } = req.body;
    const attendant = ATTENDANTS.find(a => a.id === attendantId);
    if (!attendant) return res.status(404).send('Atendente não encontrado');

    let session;
    const idx = requestQueue.findIndex(r => r.userId === userId);
    if (idx !== -1) {
        const req = requestQueue.splice(idx, 1)[0];
        saveData('requestQueue.json', requestQueue);
        session = getSession(userId, req.userName);
    } else {
        session = getSession(userId);
    }
    
    if (!session) return res.status(404).send('Sessão não encontrada');
    
    // Permitir takeover mesmo se já ativo (reassumir/transferir forçado pelo próprio user)
    session.handledBy = 'human';
    session.attendantId = attendantId;
    activeChats.set(userId, session);
    userSessions.delete(userId);
    saveData('activeChats.json', activeChats);
    saveData('userSessions.json', userSessions);

    const msg = `Olá! Sou *${attendant.name}* e vou prosseguir com seu atendimento.`;
    queueOutbound(userId, { text: msg });
    session.messageLog.push({ sender: 'system', text: `Assumido por ${attendant.name}`, timestamp: new Date().toISOString() });
    session.messageLog.push({ sender: 'attendant', text: msg.replace(/\*/g, ''), timestamp: new Date().toISOString() });
    
    res.json({ userId: session.userId, userName: session.userName, attendantId });
});

apiRouter.post('/chats/attendant-reply', (req, res) => {
    const { userId, text, attendantId, replyTo } = req.body;
    let { files } = req.body;
    if (files && !Array.isArray(files)) files = [files];

    const session = activeChats.get(userId);
    if (!session || session.attendantId !== attendantId) return res.status(403).send('Proibido');

    const timestamp = new Date().toISOString();
    // Status 1 = Pendente
    const newMessage = { sender: 'attendant', text, files: files ? [...files] : [], timestamp, replyTo, tempId: `temp_${timestamp}`, status: 1 };

    if (text) queueOutbound(userId, { text, tempId: newMessage.tempId });
    if (files) files.forEach(f => queueOutbound(userId, { file: f, text: f.name }));

    session.messageLog.push(newMessage);
    saveData('activeChats.json', activeChats);
    res.send('Enviado');
});

// NOVA ROTA: Encaminhar Mensagem
apiRouter.post('/chats/forward', (req, res) => {
    const { originalMessage, targetUserId, attendantId } = req.body;
    const session = activeChats.get(targetUserId); // Só permite encaminhar para chats ativos por enquanto
    
    if (!session) return res.status(404).send('Destinatário não está em um atendimento ativo.');

    const timestamp = new Date().toISOString();
    const isMedia = originalMessage.files && originalMessage.files.length > 0;
    
    const textToSend = originalMessage.text || (isMedia ? "" : ""); // Mantém texto se houver

    if (originalMessage.files) {
        originalMessage.files.forEach(f => {
            queueOutbound(targetUserId, { file: f, text: textToSend });
        });
    } else {
        queueOutbound(targetUserId, { text: textToSend });
    }

    const newMessage = { 
        sender: 'attendant', 
        text: textToSend, 
        files: originalMessage.files || [], 
        timestamp, 
        tempId: `fwd_${timestamp}`, 
        status: 1,
        isForwarded: true
    };

    session.messageLog.push(newMessage);
    saveData('activeChats.json', activeChats);
    res.send('Encaminhado');
});

apiRouter.post('/chats/edit-message', (req, res) => {
    const { userId, attendantId, messageTimestamp, newText } = req.body;
    const session = activeChats.get(userId);
    if (!session || session.attendantId !== attendantId) return res.status(403).send('Proibido');
    
    const msg = session.messageLog.find(m => m.timestamp === messageTimestamp && m.sender === 'attendant');
    if (!msg) return res.status(404).send('Mensagem não encontrada');

    msg.text = newText;
    msg.edited = true;
    saveData('activeChats.json', activeChats);

    if (msg.whatsappId) {
        queueOutbound(userId, { type: 'edit', messageId: msg.whatsappId, newText });
    } else if (msg.tempId) {
        pendingEdits.set(msg.tempId, { newText, userId, timestamp: Date.now() });
    }
    res.send('Editado');
});

apiRouter.post('/chats/resolve/:userId', (req, res) => {
    const { userId } = req.params;
    const session = activeChats.get(userId) || userSessions.get(userId);
    if (!session) return res.status(404).send('Chat não encontrado');

    session.resolvedAt = new Date().toISOString();
    session.resolvedBy = ATTENDANTS.find(a => a.id === req.body.attendantId)?.name || 'Sistema';
    archiveSession(session);
    activeChats.delete(userId);
    userSessions.delete(userId);
    saveData('activeChats.json', activeChats);
    saveData('userSessions.json', userSessions);
    
    const idx = requestQueue.findIndex(r => r.userId === userId);
    if (idx > -1) { requestQueue.splice(idx, 1); saveData('requestQueue.json', requestQueue); }
    
    queueOutbound(userId, { text: translations.pt.sessionEnded });
    res.send('Resolvido');
});

apiRouter.post('/chats/transfer/:userId', (req, res) => {
    const { userId } = req.params;
    const session = activeChats.get(userId);
    if (!session) return res.status(403).send('Erro');
    
    const newAttendant = ATTENDANTS.find(a => a.id === req.body.newAttendantId);
    if (!newAttendant) return res.status(404).send('Atendente não encontrado');

    session.attendantId = newAttendant.id;
    const msg = `Transferido para ${newAttendant.name}.`;
    session.messageLog.push({ sender: 'system', text: msg, timestamp: new Date().toISOString() });
    saveData('activeChats.json', activeChats);
    queueOutbound(userId, { text: `Você foi transferido para ${newAttendant.name}.` });
    res.json(session);
});

apiRouter.post('/chats/initiate', (req, res) => {
    const { recipientNumber, attendantId, message } = req.body;
    const session = getSession(recipientNumber, recipientNumber.split('@')[0]);
    session.handledBy = 'human';
    session.attendantId = attendantId;
    const attName = ATTENDANTS.find(a=>a.id===attendantId)?.name || 'Atendente';
    
    session.messageLog.push({ sender: 'system', text: `Iniciado por ${attName}`, timestamp: new Date().toISOString() });
    session.messageLog.push({ sender: 'attendant', text: message, timestamp: new Date().toISOString(), status: 1 });
    activeChats.set(recipientNumber, session);
    saveData('activeChats.json', activeChats);
    
    queueOutbound(recipientNumber, { text: message });
    res.status(201).json(session);
});

// Chat Interno
apiRouter.get('/internal-chats/summary/:attendantId', (req, res) => {
    const summary = {};
    for (const [key, chat] of internalChats.entries()) {
        if (key.includes(req.params.attendantId) && chat.length) {
            const pid = key.split('--').find(p => p !== req.params.attendantId);
            summary[pid] = { lastMessage: chat[chat.length - 1] };
        }
    }
    res.json(summary);
});

apiRouter.get('/internal-chats/:a1/:a2', (req, res) => {
    res.json(internalChats.get([req.params.a1, req.params.a2].sort().join('--')) || []);
});

apiRouter.post('/internal-chats', (req, res) => {
    const { senderId, recipientId, text, replyTo, files } = req.body;
    const key = [senderId, recipientId].sort().join('--');
    if (!internalChats.has(key)) internalChats.set(key, []);
    const senderName = ATTENDANTS.find(a=>a.id===senderId)?.name || 'Desc';
    internalChats.get(key).push({ senderId, senderName, text, files, replyTo, timestamp: new Date().toISOString() });
    saveData('internalChats.json', internalChats);
    res.status(201).send('OK');
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.use('/api', apiRouter);
app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res) => {
    if (!req.originalUrl.startsWith('/api')) res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    else res.status(404).send('API Not Found');
});

// Start WhatsApp Connection
startWhatsApp().catch(e => console.error('[FATAL] Erro ao iniciar WhatsApp:', e));

// Start HTTP Server
app.listen(port, () => {
    console.log(`[JZF Chatbot Server] Servidor rodando na porta ${port}`);
});
