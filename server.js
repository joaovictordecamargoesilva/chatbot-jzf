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
    downloadMediaMessage,
    makeInMemoryStore
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

// --- MANIPULADORES GLOBAIS DE ERRO DE PROCESSO ---
// Evita que o servidor caia por erros menores
process.on('uncaughtException', (err, origin) => {
  console.error(`[FATAL - RECOVERED] Exceção não capturada: ${err.message}`, { stack: err.stack, origin });
  // Não sai do processo, tenta manter rodando
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL - RECOVERED] Rejeição de Promise não tratada:', reason);
  // Não sai do processo
});

const SERVER_VERSION = "21.5.0_CONTACTS_FIX";
console.log(`[JZF Chatbot Server] Iniciando... Versão: ${SERVER_VERSION}`);

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- PERSISTÊNCIA DE DADOS ---
// Se RENDER_DISK_PATH estiver definido, usa ele (Disco Persistente).
// Caso contrário, usa ./data (Local).
const DATA_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  console.log(`[Persistence] Criando diretório de dados em: ${DATA_DIR}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
} else {
  console.log(`[Persistence] Usando diretório de dados existente: ${DATA_DIR}`);
}

// Helper functions
const serializeMap = (map) => Array.from(map.entries());
const deserializeMap = (arr) => new Map(arr);

// Salvamento Atômico: Escreve em .tmp e renomeia para evitar corrupção se o servidor cair durante a escrita
const saveData = (filename, data) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const tempPath = `${filePath}.tmp`;
    
    let dataToSave = data;
    if (data instanceof Map) dataToSave = serializeMap(data);
    
    fs.writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
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
    console.error(`[Persistence] ERRO ao carregar ${filename}. Usando valor padrão.`, error);
  }
  return defaultValue;
};

// --- STORE DO BAILEYS (MEMÓRIA + ARQUIVO) ---
// O Store gerencia automaticamente contatos e mensagens recebidas via socket
const store = makeInMemoryStore({ 
    logger: pino({ level: 'silent' }) 
});

const STORE_FILE = path.join(DATA_DIR, 'baileys_store.json');
// Tenta ler o arquivo de store existente
try {
    if (fs.existsSync(STORE_FILE)) {
        console.log('[Store] Carregando store do arquivo...');
        store.readFromFile(STORE_FILE);
    }
} catch (e) {
    console.error('[Store] Falha ao ler arquivo de store:', e);
}

// Salva o store periodicamente (a cada 10 segundos)
setInterval(() => {
    try {
        store.writeToFile(STORE_FILE);
    } catch (e) {
        console.error('[Store] Falha ao salvar store:', e);
    }
}, 10_000);


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

// LIMITES AUMENTADOS PARA EVITAR PERDA DE DADOS
const MAX_SESSIONS = 10000; // Aumentado significativamente
const MAX_ARCHIVED_CHATS = 2000;

// Filas internas
const outboundGatewayQueue = []; 
const pendingEdits = new Map(); // Map<AttendantMsgTimestamp, {userId, newText}>

// Status do Gateway (WhatsApp)
let gatewayStatus = { status: 'DISCONNECTED', qrCode: null };
let sock = null; 
let reconnectAttempts = 0;

// --- MIDDLEWARE ---
app.use(express.json({ limit: '50mb' }));

// --- SERVIR ARQUIVOS ESTÁTICOS (FRONTEND) ---
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
}

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
        // Remove mais antigo apenas se exceder o limite seguro (10k)
        if (userSessions.size >= MAX_SESSIONS) {
            const oldestKey = userSessions.keys().next().value;
            userSessions.delete(oldestKey);
        }

        session = {
            userId, userName, currentState: ChatState.GREETING,
            context: { history: {} }, aiHistory: [], messageLog: [],
            handledBy: 'bot', // <--- Default is bot
            attendantId: null, createdAt: new Date().toISOString(),
        };
        userSessions.set(userId, session);
        saveData('userSessions.json', userSessions);
    } else if (userName && session.userName !== userName) {
        session.userName = userName;
        saveData('userSessions.json', userSessions);
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
        // INSTRUÇÃO ADICIONADA
        messageText += `\n\nPor favor, digite o número da opção desejada.`;
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
        keepAliveIntervalMs: 15000,
        emitOwnEvents: false,
        retryRequestDelayMs: 2000,
        defaultQueryTimeoutMs: 60000,
        getMessage: async () => ({ conversation: 'hello' })
    });

    // VINCULA O STORE AO SOCKET (ISSO GARANTE QUE CONTATOS SEJAM SALVOS)
    store.bind(sock.ev);

    sock.ev.on('creds.update', saveCreds);

    // --- SINCRONIZAÇÃO DE CONTATOS ROBUSTA ---
    // (Mantido como backup para o syncedContacts.json, mas o Store é a fonte principal agora)
    const processContacts = (contacts) => {
        let hasNew = false;
        if (!contacts || !Array.isArray(contacts)) return;

        for (const contact of contacts) {
            if (contact.id.endsWith('@g.us') || contact.id === 'status@broadcast') continue;
            
            // Tenta obter o nome. Se não tiver, usa a parte do ID antes do @ (número)
            const name = contact.name || contact.notify || contact.verifiedName || (contact.id ? contact.id.split('@')[0] : 'Desconhecido');
            
            const existingIndex = syncedContacts.findIndex(c => c.userId === contact.id);
            
            if (existingIndex > -1) {
                // Atualiza o nome se o novo for "melhor" (não for apenas o número) e diferente do atual
                const currentName = syncedContacts[existingIndex].userName;
                const isPhoneNumber = name === contact.id.split('@')[0];
                
                if (name && !isPhoneNumber && currentName !== name) {
                    syncedContacts[existingIndex].userName = name;
                    hasNew = true;
                }
            } else {
                syncedContacts.push({ userId: contact.id, userName: name });
                hasNew = true;
            }
        }
        if (hasNew) {
            console.log('[Contacts] Lista de contatos atualizada via Evento.');
            saveData('syncedContacts.json', syncedContacts);
        }
    };

    sock.ev.on('contacts.upsert', async (contacts) => {
        processContacts(contacts);
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('[WhatsApp] Novo QR Code gerado.');
            gatewayStatus.qrCode = await QRCode.toDataURL(qr);
            gatewayStatus.status = 'QR_CODE_READY';
        }

        if (connection === 'close') {
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`[WhatsApp] Conexão fechada. Status: ${statusCode}, Deve Reconectar: ${shouldReconnect}`);
            gatewayStatus.status = 'DISCONNECTED';

            if (shouldReconnect) {
                // Cálculo de Backoff para evitar loops rápidos
                const delay = Math.min(5000 * (reconnectAttempts + 1), 60000); // Max 60s
                reconnectAttempts++;
                console.log(`[WhatsApp] Reconectando em ${delay/1000}s... (Tentativa ${reconnectAttempts})`);
                
                setTimeout(() => {
                    startWhatsApp();
                }, delay);
            } else {
                // APENAS AQUI apagamos a sessão (Logout explícito)
                console.log(`[WhatsApp] Desconectado permanentemente (Logout). Limpando sessão.`);
                fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                gatewayStatus.qrCode = null;
                reconnectAttempts = 0;
                setTimeout(startWhatsApp, 2000);
            }
        } else if (connection === 'open') {
            gatewayStatus.status = 'CONNECTED';
            gatewayStatus.qrCode = null;
            reconnectAttempts = 0; // Reset
            console.log('[WhatsApp] CONEXÃO ESTABELECIDA COM SUCESSO!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.key.fromMe && msg.message) {
                const userId = msg.key.remoteJid;
                const userName = msg.pushName || userId.split('@')[0];
                
                // --- ATUALIZAÇÃO DE CONTATOS (Backup) ---
                const existingContact = syncedContacts.find(c => c.userId === userId);
                if (!existingContact) {
                    syncedContacts.push({ userId, userName });
                    saveData('syncedContacts.json', syncedContacts);
                }
                // -----------------------------------------------------------

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
              const status = update.update.status; 
              for (const [userId, chat] of activeChats.entries()) {
                   if (userId === update.key.remoteJid) {
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
            
            if (item.files && item.files.length > 0) {
                 for (const file of item.files) {
                    const buffer = Buffer.from(file.data, 'base64');
                    await sock.sendMessage(jid, { 
                        [file.type.startsWith('image') ? 'image' : 'document']: buffer, 
                        caption: item.text,
                        mimetype: file.type,
                        fileName: file.name
                    });
                 }
            } else {
                 await sock.sendMessage(jid, { text: item.text });
            }

            if(activeChats.has(item.userId)) {
                const chat = activeChats.get(item.userId);
                const lastMsg = chat.messageLog[chat.messageLog.length - 1];
                if(lastMsg && lastMsg.text === item.text) {
                    lastMsg.status = 2; // Enviado
                    saveData('activeChats.json', activeChats);
                }
            }

        } catch (e) {
            console.error('[Outbound] Erro ao enviar (colocando de volta na fila):', e.message);
            outboundGatewayQueue.unshift(item); // Tenta de novo
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}, 500); 

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

// Listagem de clientes (COMBINADA: Store do Baileys + SyncedContacts + Chats Ativos)
app.get('/api/clients', (req, res) => {
    const clientsMap = new Map();
    
    // 1. Prioridade: Store oficial do Baileys (contatos da agenda)
    if (store && store.contacts) {
        // store.contacts é um dicionário { id: Contact }
        for (const id in store.contacts) {
            const c = store.contacts[id];
            if (id.endsWith('@g.us') || id === 'status@broadcast') continue;
            
            // Lógica para extrair o melhor nome disponível
            const name = c.name || c.notify || c.verifiedName || id.split('@')[0];
            clientsMap.set(id, { userId: id, userName: name });
        }
    }

    // 2. Backup: Contatos sincronizados manualmente via eventos
    syncedContacts.forEach(c => {
        if (!clientsMap.has(c.userId)) {
            clientsMap.set(c.userId, c);
        }
    });

    // 3. Chats Ativos (garante que quem está falando está na lista)
    activeChats.forEach(c => { 
        if(!clientsMap.has(c.userId)) clientsMap.set(c.userId, { userId: c.userId, userName: c.userName }); 
    });
    
    // 4. Fila
    requestQueue.forEach(r => { 
        if(!clientsMap.has(r.userId)) clientsMap.set(r.userId, { userId: r.userId, userName: r.userName }); 
    });
    
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
    
    // Busca nome do atendente
    const attendantObj = ATTENDANTS.find(a => a.id === attendantId);
    const attendantName = attendantObj ? attendantObj.name : 'um atendente';

    session.handledBy = 'human';
    session.attendantId = attendantId;
    
    // Mensagem de takeover personalizada
    const takeoverMsg = `Olá, eu sou o atendente ${attendantName} e vou dar continuidade em seu atendimento.`;

    session.messageLog.push({
        sender: 'attendant',
        text: takeoverMsg,
        timestamp: new Date().toISOString(),
        status: 2
    });

    // Move para activeChats
    userSessions.delete(userId);
    saveData('userSessions.json', userSessions);
    activeChats.set(userId, session);
    saveData('activeChats.json', activeChats);
    
    queueOutbound(userId, { text: takeoverMsg });
    
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
    const { recipientNumber, clientName, message, attendantId, files } = req.body;
    let userId = recipientNumber.includes('@') ? recipientNumber : recipientNumber + '@s.whatsapp.net';
    
    // 1. Verifica se já está ativo
    if(activeChats.has(userId)) return res.json(activeChats.get(userId));
    
    // 2. Verifica se está na fila de espera e remove de lá
    const qIdx = requestQueue.findIndex(r => r.userId === userId);
    if(qIdx !== -1) {
        requestQueue.splice(qIdx, 1);
        saveData('requestQueue.json', requestQueue);
    }
    
    // 3. Obtém ou cria a sessão (pode pegar de userSessions que estava 'idle' ou 'bot_queued')
    const session = getSession(userId, clientName); 
    
    // 4. Define explicitamente como Humano e altera o estado para evitar gatilho do bot
    session.handledBy = 'human';
    session.attendantId = attendantId;
    session.currentState = 'HUMAN_INTERACTION_INITIATED'; // Estado de segurança
    
    const msg = { 
        sender: 'attendant', 
        text: message, 
        timestamp: new Date().toISOString(), 
        status: 1 
    };
    if (files && files.length > 0) {
        msg.files = files;
    }

    session.messageLog.push(msg);
    
    // 5. Garante a transferência correta de listas (Remove do Bot, Adiciona em Ativos)
    userSessions.delete(userId);
    activeChats.set(userId, session);
    
    // 6. Salva TUDO imediatamente antes de enviar
    saveData('userSessions.json', userSessions);
    saveData('activeChats.json', activeChats);
    
    queueOutbound(userId, { text: message, files });
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
            res.json({ success: true });
        } else {
            res.status(404).send();
        }
    } else {
        res.status(404).send();
    }
});

app.get('/api/internal-chats/summary/:attendantId', (req, res) => res.json({}));

// ROTA CATCH-ALL PARA SPA
app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: 'Endpoint API não encontrado' });
    }
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(500).send('Erro: Build do frontend não encontrado (index.html)');
    }
});

// Inicia servidor
startWhatsApp();
app.listen(port, () => console.log(`[Server] Rodando na porta ${port}`));// --- SERVIDOR DE API INTEGRADO COM WHATSAPP (BAILEYS) ---
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
// Evita que o servidor caia por erros menores
process.on('uncaughtException', (err, origin) => {
  console.error(`[FATAL - RECOVERED] Exceção não capturada: ${err.message}`, { stack: err.stack, origin });
  // Não sai do processo, tenta manter rodando
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL - RECOVERED] Rejeição de Promise não tratada:', reason);
  // Não sai do processo
});

const SERVER_VERSION = "21.4.0_STABILITY_FIX";
console.log(`[JZF Chatbot Server] Iniciando... Versão: ${SERVER_VERSION}`);

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- PERSISTÊNCIA DE DADOS ---
// Se RENDER_DISK_PATH estiver definido, usa ele (Disco Persistente).
// Caso contrário, usa ./data (Local).
const DATA_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  console.log(`[Persistence] Criando diretório de dados em: ${DATA_DIR}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
} else {
  console.log(`[Persistence] Usando diretório de dados existente: ${DATA_DIR}`);
}

// Helper functions
const serializeMap = (map) => Array.from(map.entries());
const deserializeMap = (arr) => new Map(arr);

// Salvamento Atômico: Escreve em .tmp e renomeia para evitar corrupção se o servidor cair durante a escrita
const saveData = (filename, data) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const tempPath = `${filePath}.tmp`;
    
    let dataToSave = data;
    if (data instanceof Map) dataToSave = serializeMap(data);
    
    fs.writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
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
    console.error(`[Persistence] ERRO ao carregar ${filename}. Usando valor padrão.`, error);
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

// LIMITES AUMENTADOS PARA EVITAR PERDA DE DADOS
const MAX_SESSIONS = 10000; // Aumentado significativamente
const MAX_ARCHIVED_CHATS = 2000;

// Filas internas
const outboundGatewayQueue = []; 
const pendingEdits = new Map(); // Map<AttendantMsgTimestamp, {userId, newText}>

// Status do Gateway (WhatsApp)
let gatewayStatus = { status: 'DISCONNECTED', qrCode: null };
let sock = null; 
let reconnectAttempts = 0;

// --- MIDDLEWARE ---
app.use(express.json({ limit: '50mb' }));

// --- SERVIR ARQUIVOS ESTÁTICOS (FRONTEND) ---
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
}

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
        // Remove mais antigo apenas se exceder o limite seguro (10k)
        if (userSessions.size >= MAX_SESSIONS) {
            const oldestKey = userSessions.keys().next().value;
            userSessions.delete(oldestKey);
        }

        session = {
            userId, userName, currentState: ChatState.GREETING,
            context: { history: {} }, aiHistory: [], messageLog: [],
            handledBy: 'bot', // <--- Default is bot
            attendantId: null, createdAt: new Date().toISOString(),
        };
        userSessions.set(userId, session);
        saveData('userSessions.json', userSessions);
    } else if (userName && session.userName !== userName) {
        session.userName = userName;
        saveData('userSessions.json', userSessions);
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
        // INSTRUÇÃO ADICIONADA
        messageText += `\n\nPor favor, digite o número da opção desejada.`;
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
        keepAliveIntervalMs: 15000,
        emitOwnEvents: false,
        retryRequestDelayMs: 2000,
        defaultQueryTimeoutMs: 60000,
        getMessage: async () => ({ conversation: 'hello' })
    });

    sock.ev.on('creds.update', saveCreds);

    // --- SINCRONIZAÇÃO DE CONTATOS ROBUSTA ---
    
    // Função auxiliar para processar lista de contatos (usada em upsert e history.set)
    const processContacts = (contacts) => {
        let hasNew = false;
        if (!contacts || !Array.isArray(contacts)) return;

        for (const contact of contacts) {
            if (contact.id.endsWith('@g.us') || contact.id === 'status@broadcast') continue;
            
            // Tenta obter o nome. Se não tiver, usa a parte do ID antes do @ (número)
            const name = contact.name || contact.notify || contact.verifiedName || (contact.id ? contact.id.split('@')[0] : 'Desconhecido');
            
            const existingIndex = syncedContacts.findIndex(c => c.userId === contact.id);
            
            if (existingIndex > -1) {
                // Atualiza o nome se o novo for "melhor" (não for apenas o número) e diferente do atual
                const currentName = syncedContacts[existingIndex].userName;
                const isPhoneNumber = name === contact.id.split('@')[0];
                
                if (name && !isPhoneNumber && currentName !== name) {
                    syncedContacts[existingIndex].userName = name;
                    hasNew = true;
                }
            } else {
                syncedContacts.push({ userId: contact.id, userName: name });
                hasNew = true;
            }
        }
        if (hasNew) {
            console.log('[Contacts] Lista de contatos atualizada.');
            saveData('syncedContacts.json', syncedContacts);
        }
    };

    // 1. Recebe histórico completo ao conectar (AQUI ESTÃO OS CONTATOS ANTIGOS)
    sock.ev.on('messaging-history.set', async ({ contacts }) => {
        if (contacts && contacts.length > 0) {
            console.log(`[WhatsApp] Histórico recebido com ${contacts.length} contatos.`);
            processContacts(contacts);
        }
    });

    // 2. Recebe novos contatos ou atualizações incrementais
    sock.ev.on('contacts.upsert', async (contacts) => {
        processContacts(contacts);
    });

    // 3. Atualização específica de dados do contato (ex: Mudou o nome)
    sock.ev.on('contacts.update', async (updates) => {
        let hasUpdates = false;
        for (const update of updates) {
            if (update.id.includes('@g.us')) continue;
            
            const name = update.name || update.notify || update.verifiedName;
            if (name) {
                const exists = syncedContacts.find(c => c.userId === update.id);
                if (exists && exists.userName !== name) {
                    exists.userName = name;
                    hasUpdates = true;
                } else if (!exists) {
                    syncedContacts.push({ userId: update.id, userName: name });
                    hasUpdates = true;
                }
            }
        }
        if (hasUpdates) {
            saveData('syncedContacts.json', syncedContacts);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('[WhatsApp] Novo QR Code gerado.');
            gatewayStatus.qrCode = await QRCode.toDataURL(qr);
            gatewayStatus.status = 'QR_CODE_READY';
        }

        if (connection === 'close') {
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`[WhatsApp] Conexão fechada. Status: ${statusCode}, Deve Reconectar: ${shouldReconnect}`);
            gatewayStatus.status = 'DISCONNECTED';

            if (shouldReconnect) {
                // Cálculo de Backoff para evitar loops rápidos
                const delay = Math.min(5000 * (reconnectAttempts + 1), 60000); // Max 60s
                reconnectAttempts++;
                console.log(`[WhatsApp] Reconectando em ${delay/1000}s... (Tentativa ${reconnectAttempts})`);
                
                setTimeout(() => {
                    startWhatsApp();
                }, delay);
            } else {
                // APENAS AQUI apagamos a sessão (Logout explícito)
                console.log(`[WhatsApp] Desconectado permanentemente (Logout). Limpando sessão.`);
                fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                gatewayStatus.qrCode = null;
                reconnectAttempts = 0;
                setTimeout(startWhatsApp, 2000);
            }
        } else if (connection === 'open') {
            gatewayStatus.status = 'CONNECTED';
            gatewayStatus.qrCode = null;
            reconnectAttempts = 0; // Reset
            console.log('[WhatsApp] CONEXÃO ESTABELECIDA COM SUCESSO!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.key.fromMe && msg.message) {
                const userId = msg.key.remoteJid;
                const userName = msg.pushName || userId.split('@')[0];
                
                // --- ATUALIZAÇÃO DE CONTATOS (Correção para lista vazia) ---
                const existingContact = syncedContacts.find(c => c.userId === userId);
                if (!existingContact) {
                    syncedContacts.push({ userId, userName });
                    saveData('syncedContacts.json', syncedContacts);
                } else if (msg.pushName && existingContact.userName !== msg.pushName) {
                    // Atualiza nome se vier um pushName melhor
                    existingContact.userName = msg.pushName;
                    saveData('syncedContacts.json', syncedContacts);
                }
                // -----------------------------------------------------------

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
              const status = update.update.status; 
              for (const [userId, chat] of activeChats.entries()) {
                   if (userId === update.key.remoteJid) {
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
            
            if (item.files && item.files.length > 0) {
                 for (const file of item.files) {
                    const buffer = Buffer.from(file.data, 'base64');
                    await sock.sendMessage(jid, { 
                        [file.type.startsWith('image') ? 'image' : 'document']: buffer, 
                        caption: item.text,
                        mimetype: file.type,
                        fileName: file.name
                    });
                 }
            } else {
                 await sock.sendMessage(jid, { text: item.text });
            }

            if(activeChats.has(item.userId)) {
                const chat = activeChats.get(item.userId);
                const lastMsg = chat.messageLog[chat.messageLog.length - 1];
                if(lastMsg && lastMsg.text === item.text) {
                    lastMsg.status = 2; // Enviado
                    saveData('activeChats.json', activeChats);
                }
            }

        } catch (e) {
            console.error('[Outbound] Erro ao enviar (colocando de volta na fila):', e.message);
            outboundGatewayQueue.unshift(item); // Tenta de novo
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}, 500); 

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
    
    // Busca nome do atendente
    const attendantObj = ATTENDANTS.find(a => a.id === attendantId);
    const attendantName = attendantObj ? attendantObj.name : 'um atendente';

    session.handledBy = 'human';
    session.attendantId = attendantId;
    
    // Mensagem de takeover personalizada
    const takeoverMsg = `Olá, eu sou o atendente ${attendantName} e vou dar continuidade em seu atendimento.`;

    session.messageLog.push({
        sender: 'attendant',
        text: takeoverMsg,
        timestamp: new Date().toISOString(),
        status: 2
    });

    // Move para activeChats
    userSessions.delete(userId);
    saveData('userSessions.json', userSessions);
    activeChats.set(userId, session);
    saveData('activeChats.json', activeChats);
    
    queueOutbound(userId, { text: takeoverMsg });
    
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
    const { recipientNumber, clientName, message, attendantId, files } = req.body;
    let userId = recipientNumber.includes('@') ? recipientNumber : recipientNumber + '@s.whatsapp.net';
    
    // 1. Verifica se já está ativo
    if(activeChats.has(userId)) return res.json(activeChats.get(userId));
    
    // 2. Verifica se está na fila de espera e remove de lá
    const qIdx = requestQueue.findIndex(r => r.userId === userId);
    if(qIdx !== -1) {
        requestQueue.splice(qIdx, 1);
        saveData('requestQueue.json', requestQueue);
    }
    
    // 3. Obtém ou cria a sessão (pode pegar de userSessions que estava 'idle' ou 'bot_queued')
    const session = getSession(userId, clientName); 
    
    // 4. Define explicitamente como Humano e altera o estado para evitar gatilho do bot
    session.handledBy = 'human';
    session.attendantId = attendantId;
    session.currentState = 'HUMAN_INTERACTION_INITIATED'; // Estado de segurança
    
    const msg = { 
        sender: 'attendant', 
        text: message, 
        timestamp: new Date().toISOString(), 
        status: 1 
    };
    if (files && files.length > 0) {
        msg.files = files;
    }

    session.messageLog.push(msg);
    
    // 5. Garante a transferência correta de listas (Remove do Bot, Adiciona em Ativos)
    userSessions.delete(userId);
    activeChats.set(userId, session);
    
    // 6. Salva TUDO imediatamente antes de enviar
    saveData('userSessions.json', userSessions);
    saveData('activeChats.json', activeChats);
    
    queueOutbound(userId, { text: message, files });
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
            res.json({ success: true });
        } else {
            res.status(404).send();
        }
    } else {
        res.status(404).send();
    }
});

app.get('/api/internal-chats/summary/:attendantId', (req, res) => res.json({}));

// ROTA CATCH-ALL PARA SPA
app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: 'Endpoint API não encontrado' });
    }
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(500).send('Erro: Build do frontend não encontrado (index.html)');
    }
});

// Inicia servidor
startWhatsApp();
app.listen(port, () => console.log(`[Server] Rodando na porta ${port}`));
