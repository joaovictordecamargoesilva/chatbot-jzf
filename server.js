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
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Rejeição de Promise não tratada:', { reason: reason, promise: promise });
});

const SERVER_VERSION = "21.1.1_FIX_DEPLOY";
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
const archivedChats = loadData('archivedChats.json', new Map()); // Map<UserId, Array<Session>>
const internalChats = loadData('internalChats.json', new Map());
let syncedContacts = loadData('syncedContacts.json', []);

let nextRequestId = requestQueue.length > 0 && requestQueue.every(r => typeof r.id === 'number') ? Math.max(...requestQueue.map(r => r.id)) + 1 : 1;
const MAX_SESSIONS = 2000;
const MAX_ARCHIVED_CHATS = 500;

// Filas internas
const outboundGatewayQueue = []; 
const pendingEdits = new Map(); // Map<AttendantMsgTimestamp, {userId, newText}>

// Status do Gateway (WhatsApp)
let gatewayStatus = { status: 'DISCONNECTED', qrCode: null };
let sock = null; 

// --- MIDDLEWARE ---
app.use(express.json({ limit: '50mb' }));

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

// --- LÓGICA DE SESSÃO E ARQUIVAMENTO ---
function archiveSession(session) {
    if (!session?.userId) return;
    
    // Recupera o histórico existente para este usuário
    let userHistory = archivedChats.get(session.userId) || [];
    
    // Adiciona a sessão atual ao histórico
    // Importante: Clonar o objeto para evitar referência circular ou mutação indesejada
    userHistory.push(JSON.parse(JSON.stringify(session)));
    
    archivedChats.set(session.userId, userHistory);
    saveData('archivedChats.json', archivedChats);
    
    // Limpeza de cache se muito grande
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
            if (!ai) { queueOutbound(userId, { text: "IA indisponível no momento." }); return; }
            try {
                session.aiHistory.push({ role: 'user', parts: [{ text: userInput }] });
                const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: session.aiHistory, config: { systemInstruction: departmentSystemInstructions.pt[session.context.department] || "Você é um assistente prestativo." } });
                const aiText = response.text;
                queueOutbound(userId, { text: aiText });
                session.messageLog.push({ sender: 'bot', text: aiText, timestamp: new Date() });
                session.aiHistory.push({ role: 'model', parts: [{ text: aiText }] });
            } catch (error) { console.error(`[AI] Erro:`, error); queueOutbound(userId, { text: translations.pt.error }); }
            return;
        }
        nextState = currentStep.nextState;
        session.context.history[session.currentState] = userInput;
    } else {
        if (session.currentState !== ChatState.GREETING) queueOutbound(userId, { text: "Opção inválida. Digite apenas o número." });
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
        } else { currentState = null; }
    }
}

function queueOutbound(userId, content) {
    outboundGatewayQueue.push({ userId, ...content });
}

async function processIncomingMessage({ userId, userName, userInput, file, replyContext }) {
    if (!userId) return;
    const session = getSession(userId, userName);
    let effectiveInput = userInput;
    const logEntry = { sender: 'user', text: userInput, timestamp: new Date().toISOString() };
    if (file) logEntry.files = [file];
    if (replyContext) logEntry.replyTo = { text: replyContext.text, sender: replyContext.fromMe ? 'attendant' : 'user', senderName: replyContext.fromMe ? 'Você' : session.userName };
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
    
    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['JZF Atendimento', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: false,
        retryRequestDelayMs: 250,
        getMessage: async () => ({ conversation: 'hello' })
    });

    sock.ev.on('creds.update', saveCreds);

    // --- SINCRONIZAÇÃO DE CONTATOS ---
    sock.ev.on('contacts.upsert', async (contacts) => {
        let hasNew = false;
        for (const contact of contacts) {
            if (contact.id.includes('@g.us') || contact.id === 'status@broadcast') continue;
            const exists = syncedContacts.find(c => c.userId === contact.id);
            const name = contact.name || contact.notify || contact.verifiedName || contact.id.split('@')[0];
            if (!exists) {
                syncedContacts.push({ userId: contact.id, userName: name });
                hasNew = true;
            } else if (name && exists.userName !== name) {
                exists.userName = name;
                hasNew = true;
            }
        }
        if (hasNew) {
            saveData('syncedContacts.json', syncedContacts);
            console.log(`[Contacts] Sincronização automática realizada.`);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            gatewayStatus.qrCode = await QRCode.toDataURL(qr);
            gatewayStatus.status = 'QR_CODE_READY';
        }
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            gatewayStatus.status = 'DISCONNECTED';
            if (shouldReconnect) setTimeout(startWhatsApp, 3000);
            else {
                fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                gatewayStatus.qrCode = null;
                setTimeout(startWhatsApp, 1000);
            }
        } else if (connection === 'open') {
            gatewayStatus.status = 'CONNECTED';
            gatewayStatus.qrCode = null;
            console.log('[WhatsApp] Conectado!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.key.fromMe && msg.message) {
                const userId = msg.key.remoteJid;
                const userName = msg.pushName || userId.split('@')[0];
                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                
                // Mídia
                let file = null;
                const messageType = Object.keys(msg.message)[0];
                if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType)) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        file = {
                            name: `${messageType}.${messageType.startsWith('audio') ? 'ogg' : 'jpg'}`,
                            type: messageType.startsWith('audio') ? 'audio/ogg' : (messageType.startsWith('image') ? 'image/jpeg' : 'application/octet-stream'),
                            data: buffer.toString('base64')
                        };
                        text = msg.message[messageType].caption || '';
                    } catch (e) { console.error('Erro download mídia:', e); }
                }

                // Contexto de Resposta
                let replyContext = null;
                const contextInfo = msg.message.extendedTextMessage?.contextInfo || msg.message[messageType]?.contextInfo;
                if (contextInfo && contextInfo.quotedMessage) {
                    const quotedText = contextInfo.quotedMessage.conversation || contextInfo.quotedMessage.extendedTextMessage?.text;
                    replyContext = {
                        text: quotedText || "[Mídia/Arquivo]",
                        fromMe: contextInfo.participant === sock.user.id.split(':')[0] + '@s.whatsapp.net'
                    };
                }

                await processIncomingMessage({ userId, userName, userInput: text, file, replyContext });
            }
        }
    });

    // Atualização de Status (Leitura/Entrega)
    sock.ev.on('messages.update', async(updates) => {
       for(const update of updates) {
           if(update.update.status) {
              const status = update.update.status; // 3: Entregue, 4: Lido
              // Atualiza status nos chats ativos
              for (const [userId, chat] of activeChats.entries()) {
                   if (userId === update.key.remoteJid) {
                       const msgIndex = chat.messageLog.findIndex(m => m.timestamp === update.key.id || (m.timestamp && new Date(m.timestamp).getTime() === new Date(update.key.id).getTime())); 
                       // Nota: Baileys usa key.id como identificador. O chat usa timestamp ou id próprio.
                       // Como simplificação, vamos assumir que atualizamos a última mensagem se for recente ou implementar busca por ID futuramente.
                       // Para este MVP, atualizamos a última mensagem do atendente:
                       const lastMsg = chat.messageLog[chat.messageLog.length -1];
                       if(lastMsg && lastMsg.sender === 'attendant') {
                           lastMsg.status = status;
                           saveData('activeChats.json', activeChats);
                       }
                   }
              }
           }
       }
    });
}

// Loop de envio de mensagens (Outbound)
setInterval(async () => {
    if (outboundGatewayQueue.length > 0 && sock && gatewayStatus.status === 'CONNECTED') {
        const item = outboundGatewayQueue.shift();
        try {
            const jid = item.userId.includes('@') ? item.userId : item.userId + '@s.whatsapp.net';
            let sentMsg;

            if (item.files && item.files.length > 0) {
                 // Envio de Mídia
                 for (const file of item.files) {
                    const buffer = Buffer.from(file.data, 'base64');
                    sentMsg = await sock.sendMessage(jid, { 
                        [file.type.startsWith('image') ? 'image' : 'document']: buffer, 
                        caption: item.text,
                        mimetype: file.type,
                        fileName: file.name
                    });
                 }
            } else {
                 // Texto puro
                 sentMsg = await sock.sendMessage(jid, { text: item.text });
            }

            // Atualiza status local para enviado (2)
            if(activeChats.has(item.userId)) {
                const chat = activeChats.get(item.userId);
                const lastMsg = chat.messageLog[chat.messageLog.length - 1];
                if(lastMsg && lastMsg.text === item.text) {
                    lastMsg.status = 2; // Enviado
                    saveData('activeChats.json', activeChats);
                }
            }

        } catch (e) {
            console.error('[Outbound] Erro ao enviar:', e);
            outboundGatewayQueue.unshift(item); // Tenta de novo
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}, 500); // Check a cada 500ms

// --- API ENDPOINTS ---

// Endpoints básicos
app.get('/api/gateway/status', (req, res) => res.json(gatewayStatus));
app.get('/api/attendants', (req, res) => res.json(ATTENDANTS));
app.post('/api/attendants', (req, res) => {
    const newAttendant = { id: `attendant_${nextAttendantId++}`, name: req.body.name };
    ATTENDANTS.push(newAttendant);
    saveData('attendants.json', ATTENDANTS);
    res.json(newAttendant);
});

// Listagem de clientes (Sincronizados + Ativos)
app.get('/api/clients', (req, res) => {
    const clientsMap = new Map();
    // Prioridade: Contatos sincronizados
    syncedContacts.forEach(c => clientsMap.set(c.userId, c));
    // Adiciona ativos que talvez não estejam na lista de contatos
    activeChats.forEach(c => { if(!clientsMap.has(c.userId)) clientsMap.set(c.userId, { userId: c.userId, userName: c.userName }); });
    requestQueue.forEach(r => { if(!clientsMap.has(r.userId)) clientsMap.set(r.userId, { userId: r.userId, userName: r.userName }); });
    
    res.json(Array.from(clientsMap.values()));
});

app.get('/api/requests', (req, res) => res.json(requestQueue));

app.get('/api/chats/active', (req, res) => {
    // Retorna resumo leve para polling
    const activeSummary = Array.from(activeChats.values()).map(c => {
        const lastMsg = c.messageLog[c.messageLog.length - 1];
        return {
            userId: c.userId,
            userName: c.userName,
            attendantId: c.attendantId,
            logLength: c.messageLog.length,
            lastMsgStatus: lastMsg ? lastMsg.status : 0,
            lastMessage: lastMsg
        };
    });
    res.json(activeSummary);
});

app.get('/api/chats/ai-active', (req, res) => {
    const aiChats = Array.from(userSessions.values())
        .filter(s => s.handledBy === 'bot')
        .map(c => ({ 
            userId: c.userId, 
            userName: c.userName,
            logLength: c.messageLog.length 
        }));
    res.json(aiChats);
});

app.get('/api/chats/history', (req, res) => {
    // Resumo de histórico para a sidebar
    const historySummary = [];
    archivedChats.forEach((sessions, userId) => {
        if(sessions.length > 0) {
            const lastSession = sessions[sessions.length - 1];
            historySummary.push({
                userId,
                userName: lastSession.userName,
                resolvedAt: lastSession.resolvedAt
            });
        }
    });
    res.json(historySummary);
});

// HISTÓRICO UNIFICADO (IMPORTANTE)
app.get('/api/chats/history/:userId', (req, res) => {
    const { userId } = req.params;
    
    // 1. Pega histórico arquivado (Sessões antigas: Segunda, Terça...)
    const oldSessions = archivedChats.get(userId) || [];
    
    // 2. Pega sessão atual (Sexta...)
    const currentSession = activeChats.get(userId) || userSessions.get(userId);
    
    let fullLog = [];
    
    // Adiciona msgs antigas
    oldSessions.forEach(s => {
        if(s.messageLog) fullLog = fullLog.concat(s.messageLog);
    });
    
    // Adiciona msgs atuais
    if(currentSession && currentSession.messageLog) {
        fullLog = fullLog.concat(currentSession.messageLog);
    }
    
    // Ordena por timestamp para garantir linearidade
    fullLog.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    // Retorna objeto de sessão mesclado
    const responseData = currentSession 
        ? JSON.parse(JSON.stringify(currentSession)) 
        : (oldSessions.length > 0 ? JSON.parse(JSON.stringify(oldSessions[oldSessions.length-1])) : { userId, userName: 'Novo Usuário', attendantId: null });
    
    responseData.messageLog = fullLog;
    
    res.json(responseData);
});

// Ações de Chat
app.post('/api/chats/takeover/:userId', (req, res) => {
    const { userId } = req.params;
    const { attendantId } = req.body;
    
    let session = userSessions.get(userId);
    // Se não estiver em sessão ativa, tenta pegar da fila ou cria nova
    if (!session) {
         // Verifica se está na fila
         const queueIndex = requestQueue.findIndex(r => r.userId === userId);
         if (queueIndex !== -1) {
             const reqItem = requestQueue[queueIndex];
             session = getSession(userId, reqItem.userName);
             requestQueue.splice(queueIndex, 1);
             saveData('requestQueue.json', requestQueue);
         } else {
             // Pode ser um início ativo pelo atendente
             session = getSession(userId);
         }
    } else {
        // Remove da fila se estiver lá
        const qIdx = requestQueue.findIndex(r => r.userId === userId);
        if(qIdx !== -1) {
            requestQueue.splice(qIdx, 1);
            saveData('requestQueue.json', requestQueue);
        }
    }
    
    session.handledBy = 'human';
    session.attendantId = attendantId;
    
    // Move para activeChats
    userSessions.delete(userId);
    saveData('userSessions.json', userSessions);
    activeChats.set(userId, session);
    saveData('activeChats.json', activeChats);
    
    queueOutbound(userId, { text: "Um atendente assumiu a conversa." });
    
    res.json(session);
});

app.post('/api/chats/attendant-reply', (req, res) => {
    const { userId, text, attendantId, files, replyTo } = req.body;
    const chat = activeChats.get(userId);
    if (chat) {
        const msg = { 
            sender: 'attendant', 
            text, 
            files, 
            timestamp: new Date().toISOString(),
            status: 1 // Pending
        };
        if(replyTo) msg.replyTo = replyTo;
        
        chat.messageLog.push(msg);
        saveData('activeChats.json', activeChats);
        
        queueOutbound(userId, { text, files });
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Chat não encontrado' });
    }
});

app.post('/api/chats/initiate', (req, res) => {
    const { recipientNumber, message, attendantId } = req.body;
    let userId = recipientNumber.includes('@') ? recipientNumber : recipientNumber + '@s.whatsapp.net';
    
    // Verifica se já existe
    if(activeChats.has(userId)) return res.json(activeChats.get(userId));
    
    const session = getSession(userId); // Cria ou recupera
    session.handledBy = 'human';
    session.attendantId = attendantId;
    session.messageLog.push({ sender: 'attendant', text: message, timestamp: new Date().toISOString(), status: 1 });
    
    userSessions.delete(userId);
    activeChats.set(userId, session);
    saveData('activeChats.json', activeChats);
    
    queueOutbound(userId, { text: message });
    res.json(session);
});

app.post('/api/chats/resolve/:userId', (req, res) => {
    const { userId } = req.params;
    const chat = activeChats.get(userId);
    if (chat) {
        chat.resolvedBy = 'Atendente';
        chat.resolvedAt = new Date().toISOString();
        archiveSession(chat);
        activeChats.delete(userId);
        saveData('activeChats.json', activeChats);
        
        queueOutbound(userId, { text: translations.pt.sessionEnded });
        res.json({ success: true });
    } else {
        res.status(404).send();
    }
});

app.post('/api/chats/transfer/:userId', (req, res) => {
    const { userId } = req.params;
    const { newAttendantId, transferringAttendantId } = req.body;
    const chat = activeChats.get(userId);
    if(chat) {
        chat.attendantId = newAttendantId;
        chat.messageLog.push({ sender: 'system', text: `Transferido para outro atendente.`, timestamp: new Date().toISOString() });
        saveData('activeChats.json', activeChats);
        res.json({ success: true });
    } else {
        res.status(404).send();
    }
});

app.post('/api/chats/forward', (req, res) => {
    const { originalMessage, targetUserId, attendantId } = req.body;
    const targetChat = activeChats.get(targetUserId);
    
    if (targetChat) {
        const fwdMsg = {
            sender: 'attendant',
            text: originalMessage.text,
            files: originalMessage.files,
            isForwarded: true,
            timestamp: new Date().toISOString(),
            status: 1
        };
        targetChat.messageLog.push(fwdMsg);
        saveData('activeChats.json', activeChats);
        
        queueOutbound(targetUserId, { text: originalMessage.text, files: originalMessage.files });
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Chat destino não ativo ou não encontrado.' });
    }
});

app.post('/api/chats/edit-message', (req, res) => {
    const { userId, attendantId, messageTimestamp, newText } = req.body;
    const chat = activeChats.get(userId);
    if(chat) {
        const msg = chat.messageLog.find(m => m.timestamp === messageTimestamp);
        if(msg) {
            msg.text = newText;
            msg.edited = true;
            saveData('activeChats.json', activeChats);
            // Aqui você poderia implementar a lógica real de edição do WhatsApp se o Baileys suportar sendMessage com edit key
            res.json({ success: true });
        } else {
            res.status(404).send();
        }
    } else {
        res.status(404).send();
    }
});

// Chats Internos (Mock)
app.get('/api/internal-chats/summary/:attendantId', (req, res) => res.json({}));

// Inicia servidor
startWhatsApp();
app.listen(port, () => console.log(`[Server] Rodando na porta ${port}`));
