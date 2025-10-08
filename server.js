// --- SERVIDOR DE API EXCLUSIVO PARA RENDER ---
// Versão para deploy limpo. Nenhuma lógica do wppconnect deve estar aqui.

import express from 'express';
// @google/genai-ts FIX: Use the correct class name as per the new SDK guidelines.
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

// --- MANIPULADORES GLOBAIS DE ERRO DE PROCESSO ---
// Essencial para produção: captura exceções não tratadas e rejeições de promise
// para evitar que o servidor trave silenciosamente, o que causa erros 502.
process.on('uncaughtException', (err, origin) => {
  console.error(`[FATAL] Exceção não capturada: ${err.message}`, {
    stack: err.stack,
    origin: origin,
  });
  // Para erros graves, é mais seguro encerrar o processo e deixar o orquestrador (Render) reiniciá-lo.
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Rejeição de Promise não tratada:', {
    reason: reason,
    promise: promise,
  });
  // Encerrar o processo em caso de rejeições não tratadas também é uma prática segura.
  process.exit(1);
});


const SERVER_VERSION = "17.0.1_STABILITY_FIX";
console.log(`[JZF Chatbot Server] Iniciando... Versão: ${SERVER_VERSION}`);

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- DADOS EM MEMÓRIA ---
// AVISO DE PRODUÇÃO: Os dados em memória são voláteis e serão perdidos a cada reinicialização
// ou deploy do servidor. Para uma aplicação real, substitua por um banco de dados
// persistente (ex: PostgreSQL, MongoDB) e um cache (ex: Redis).
const ATTENDANTS = [];
let nextAttendantId = 1; // Inicia o contador em 1
const userSessions = new Map();
const requestQueue = [];
const activeChats = new Map();
const archivedChats = new Map();
const MAX_SESSIONS = 2000; // Limite de segurança para sessões em memória
const MAX_ARCHIVED_CHATS = 500; // Cap para prevenir vazamento de memória
const outboundGatewayQueue = [];
const internalChats = new Map();
let syncedContacts = [];
let nextRequestId = 1;


// --- MIDDLEWARE DE LOG GLOBAL ---
app.use((req, res, next) => {
  console.log(`[Request Logger] Recebida: ${req.method} ${req.originalUrl}`);
  next();
});

// --- PARSERS E CONFIGURAÇÕES BÁSICAS ---
app.use(express.json({ limit: '50mb' }));

// --- INICIALIZAÇÃO RESILIENTE DO CLIENTE DE IA ---
let ai = null;
if (API_KEY) {
    try {
        ai = new GoogleGenAI({apiKey: API_KEY});
        console.log("[JZF Chatbot Server] Cliente Google GenAI inicializado com sucesso.");
    } catch (error) {
        console.error("[JZF Chatbot Server] ERRO: Falha ao inicializar o cliente Google GenAI.", error);
    }
} else {
    console.warn("[JZF Chatbot Server] AVISO: API_KEY não definida. Funcionalidades de IA estarão desativadas.");
}

// --- FUNÇÃO DE TRANSCRIÇÃO DE ÁUDIO COM GEMINI AI ---
async function transcribeAudio(file) {
    if (!ai) {
        console.warn("[Transcribe] Tentativa de transcrever áudio, mas a IA não está inicializada.");
        return "[Áudio não pôde ser transcrito - IA indisponível]";
    }
    if (!file || !file.data || !file.type) {
        console.error("[Transcribe] Dados de áudio inválidos fornecidos.");
        return "[Erro na transcrição: dados de áudio ausentes]";
    }

    try {
        console.log(`[Transcribe] Iniciando transcrição para arquivo do tipo ${file.type}...`);
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { 
                parts: [
                    { inlineData: { mimeType: file.type, data: file.data } },
                    { text: "Transcreva este áudio em português do Brasil de forma literal." }
                ]
            },
        });

        // MODIFICAÇÃO: Tratamento robusto da resposta da IA
        const transcription = response?.text?.trim();
        
        if (transcription) {
            console.log(`[Transcribe] Transcrição concluída: "${transcription}"`);
            return transcription;
        } else {
            console.warn(`[Transcribe] A transcrição da IA retornou um texto vazio para o arquivo: ${file.name || 'desconhecido'}`);
            return "[Transcrição falhou ou o áudio estava em silêncio.]";
        }

    } catch (error) {
        console.error("[Transcribe] Erro CRÍTICO durante a chamada da API Gemini para transcrição:", error);
        return `[Não foi possível transcrever o áudio]`;
    }
}


// --- FUNÇÕES DE GERENCIAMENTO DE SESSÃO E DADOS ---
function archiveSession(session) {
    if (!session || !session.userId) {
        console.error('[archiveSession] Tentativa de arquivar sessão inválida.');
        return;
    }
    archivedChats.delete(session.userId);
    archivedChats.set(session.userId, { ...session });
    
    if (archivedChats.size > MAX_ARCHIVED_CHATS) {
        const oldestKey = archivedChats.keys().next().value;
        archivedChats.delete(oldestKey);
        console.log(`[Memory] Limite de arquivos atingido. Chat arquivado mais antigo (${oldestKey}) removido.`);
    }
}

function getSession(userId, userName = null) {
    if (!userSessions.has(userId)) {
        // CONTROLE DE MEMÓRIA: Remove a sessão mais antiga se o limite for atingido.
        if (userSessions.size >= MAX_SESSIONS) {
            const oldestKey = userSessions.keys().next().value;
            userSessions.delete(oldestKey);
            console.warn(`[Memory] Limite de ${MAX_SESSIONS} sessões atingido. Sessão mais antiga (${oldestKey}) removida.`);
        }
        userSessions.set(userId, {
            userId: userId,
            userName: userName,
            currentState: ChatState.GREETING,
            context: { history: {} },
            aiHistory: [],
            messageLog: [],
            handledBy: 'bot', // 'bot' | 'human' | 'bot_queued'
            attendantId: null,
            createdAt: new Date().toISOString(),
        });
    }
    const session = userSessions.get(userId);
    if (userName && session.userName !== userName) {
        session.userName = userName;
    }
    return session;
}

function addRequestToQueue(session, department, message) {
    const { userId, userName } = session;
    if (requestQueue.some(r => r.userId === userId) || activeChats.has(userId)) {
        console.log(`[Queue] Bloqueada adição de ${userId} à fila pois já existe uma solicitação.`);
        return;
    }
    const request = {
        id: nextRequestId++,
        userId,
        userName,
        department,
        message,
        timestamp: new Date().toISOString(),
    };
    requestQueue.unshift(request);
    console.log(`[Queue] Nova solicitação adicionada: ID ${request.id} (${userName}) para o setor ${department}`);
}

// --- FUNÇÃO DE PROCESSAMENTO DE MENSAGENS DO BOT (STATE MACHINE) ---
async function processMessage(session, userInput, file) {
    const lang = 'pt';
    let currentStep = conversationFlow.get(session.currentState);
    let replies = [];

    // Função auxiliar para gerar texto e opções
    const generateReply = (stepKey, context) => {
        const step = conversationFlow.get(stepKey);
        if (!step) return '';

        let text = typeof translations[lang][step.textKey] === 'function'
            ? translations[lang][step.textKey](context)
            : translations[lang][step.textKey];

        if (step.options) {
            text += '\n\n';
            step.options.forEach((opt, index) => {
                text += `${index + 1}. ${translations[lang][opt.textKey]}\n`;
            });
        }
        return text.trim();
    };

    // 1. Lidar com opções de navegação primeiro (ex: "Voltar ao início")
    const navigationOption = currentStep?.options?.find(opt => 
        userInput.toLowerCase().includes(translations[lang][opt.textKey].toLowerCase()) || 
        userInput === (currentStep.options.indexOf(opt) + 1).toString()
    );

    if (navigationOption) {
        session.currentState = navigationOption.nextState;
        if (navigationOption.payload) {
            session.context = { ...session.context, ...navigationOption.payload };
        }
        
        // Se a próxima etapa for de transferência, lida com ela
        if (session.currentState === ChatState.ATTENDANT_TRANSFER || session.currentState === ChatState.SCHEDULING_CONFIRMED) {
             addRequestToQueue(session, session.context.department || 'Agendamento', userInput);
             replies.push(generateReply(session.currentState, session.context));
             session.handledBy = 'bot_queued'; // Estado intermediário para não processar mais msgs
        } else if (session.currentState === ChatState.END_SESSION) {
            replies.push(generateReply(ChatState.END_SESSION, session.context));
            session.currentState = ChatState.GREETING; // Reinicia para a próxima vez
        } else {
            replies.push(generateReply(session.currentState, session.context));
        }

    } // 2. Lidar com entrada de texto livre
    else if (currentStep && currentStep.requiresTextInput) {
        
        if (session.currentState === ChatState.AI_ASSISTANT_CHATTING) {
            // Lógica da IA
            if (!ai) {
                 replies.push("Desculpe, a função de Assistente Virtual está indisponível no momento. Tente novamente mais tarde.");
            } else {
                const systemInstruction = departmentSystemInstructions[lang][session.context.department];
                session.aiHistory.push({ role: 'user', parts: [{ text: userInput }] });

                try {
                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: [...session.aiHistory],
                        config: { systemInstruction },
                    });
                    
                    const aiResponseText = response.text;
                    session.aiHistory.push({ role: 'model', parts: [{ text: aiResponseText }] });
                    replies.push(aiResponseText);
                    
                } catch (e) {
                    console.error("Erro na chamada da Gemini API:", e);
                    replies.push(translations[lang].error);
                }
            }
        } else {
            // Outros estados que precisam de texto (agendamento)
            session.context.history[session.currentState] = userInput;
            session.currentState = currentStep.nextState;
            replies.push(generateReply(session.currentState, session.context));
        }

    } else { // 3. Entrada inesperada ou inválida
         replies.push("Desculpe, não entendi sua resposta. Por favor, escolha uma das opções numeradas.");
         replies.push(generateReply(session.currentState, session.context)); // Reenvia as opções
    }
    
    // Enfileira as respostas para serem enviadas pelo gateway
    for (const reply of replies) {
        if (reply) { // Garante que não enfileire respostas vazias
           outboundGatewayQueue.push({ userId: session.userId, text: reply });
        }
    }
}


// --- PROCESSADOR DE MENSAGENS EM SEGUNDO PLANO ---
async function processIncomingMessage(body) {
    const { userId, userName, userInput, file, gatewayError } = body;
    
    // Validação essencial
    if (!userId) {
        console.error('[Background Processor] Ignorando mensagem sem userId.');
        return;
    }

    const session = getSession(userId, userName);
    let effectiveInput = userInput;

    if (gatewayError) {
        session.messageLog.push({ sender: 'system', text: `Erro no gateway: ${userInput}`, timestamp: new Date().toISOString() });
        return; // Não processa mais se houve erro no gateway
    }

    // Log da mensagem do usuário
    if (file) {
        session.messageLog.push({ sender: 'user', text: userInput, file: { ...file }, timestamp: new Date().toISOString() });
        if (file.type && file.type.startsWith('audio/')) {
            const transcription = await transcribeAudio(file);
            effectiveInput = transcription; // Usa a transcrição como a entrada do usuário
            session.messageLog.push({ sender: 'system', text: `Transcrição do áudio: "${transcription}"`, timestamp: new Date().toISOString() });
        }
    } else {
        session.messageLog.push({ sender: 'user', text: userInput, timestamp: new Date().toISOString() });
    }

    // Se o chat já está com um atendente humano ou na fila, não faz nada.
    if (session.handledBy === 'human' || session.handledBy === 'bot_queued') {
        console.log(`[Background Processor] Mensagem de ${userId} recebida para chat já em atendimento humano/fila. Apenas registrando.`);
        return;
    }
    
    // Se a sessão está com o bot, processa a mensagem
    if (session.handledBy === 'bot') {
       await processMessage(session, effectiveInput, file);
    }
}


// --- ROTAS DA API ---
const apiRouter = express.Router();

// Helper para envolver rotas async e capturar erros
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);


// --- ROTAS DO PAINEL DE ATENDIMENTO ---

// Rota de Health Check - essencial para plataformas de deploy
apiRouter.get('/health', (req, res) => {
  res.status(200).send('OK');
});

apiRouter.get('/attendants', asyncHandler(async (req, res) => {
    res.status(200).json(ATTENDANTS);
}));

apiRouter.post('/attendants', asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return res.status(400).send('Nome do atendente é inválido.');
    }
    const normalizedName = name.trim();
    if (ATTENDANTS.some(a => a.name.toLowerCase() === normalizedName.toLowerCase())) {
        return res.status(409).send('Um atendente com este nome já existe.');
    }
    const newAttendant = {
        id: `attendant_${nextAttendantId++}`,
        name: normalizedName
    };
    ATTENDANTS.push(newAttendant);
    console.log(`[Auth] Novo atendente registrado: ${normalizedName} (ID: ${newAttendant.id})`);
    res.status(201).json(newAttendant);
}));

apiRouter.get('/requests', asyncHandler(async (req, res) => {
    res.status(200).json(requestQueue);
}));

apiRouter.get('/chats/active', asyncHandler(async (req, res) => {
    const chats = Array.from(activeChats.values()).map(session => ({
        userId: session.userId,
        userName: session.userName,
        attendantId: session.attendantId,
        lastMessage: session.messageLog[session.messageLog.length - 1] || null
    }));
    res.status(200).json(chats);
}));

apiRouter.get('/chats/ai-active', asyncHandler(async (req, res) => {
    const aiChats = Array.from(userSessions.values())
        .filter(s => s.handledBy === 'bot' && !requestQueue.some(r => r.userId === s.userId) && s.currentState !== ChatState.GREETING)
        .map(session => ({
            userId: session.userId,
            userName: session.userName,
            lastMessage: session.messageLog[session.messageLog.length - 1] || null
        }));
    res.status(200).json(aiChats);
}));

apiRouter.get('/clients', asyncHandler(async (req, res) => {
    res.status(200).json(syncedContacts);
}));

apiRouter.get('/chats/history', asyncHandler(async (req, res) => {
    const history = Array.from(archivedChats.values()).map(session => ({
        userId: session.userId,
        userName: session.userName,
        attendantId: session.attendantId,
        lastMessage: session.messageLog[session.messageLog.length - 1] || null,
        resolvedAt: session.resolvedAt,
        resolvedBy: session.resolvedBy
    })).sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));
    res.status(200).json(history);
}));

apiRouter.get('/chats/history/:userId', asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const session = activeChats.get(userId) || userSessions.get(userId) || archivedChats.get(userId);
    if (session) {
        res.status(200).json(session);
    } else {
        res.status(404).send('Chat não encontrado.');
    }
}));

apiRouter.post('/chats/takeover/:userId', asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { attendantId } = req.body;
    
    let session;
    let requestIndex = requestQueue.findIndex(r => r.userId === userId);

    if (requestIndex !== -1) {
        const request = requestQueue.splice(requestIndex, 1)[0];
        session = getSession(userId, request.userName);
    } else {
        session = getSession(userId);
    }
    
    if (activeChats.has(userId)) {
        return res.status(409).send('Este chat já está sendo atendido.');
    }

    session.handledBy = 'human';
    session.attendantId = attendantId;
    const attendantName = ATTENDANTS.find(a => a.id === attendantId)?.name || 'um atendente';
    session.messageLog.push({ sender: 'system', text: `Atendimento transferido para ${attendantName}.`, timestamp: new Date().toISOString() });
    activeChats.set(userId, session);
    userSessions.delete(userId); // Move de sessões de bot para ativas

    console.log(`[Takeover] Atendente ${attendantId} assumiu o chat com ${userId}.`);
    res.status(200).json({ 
        userId: session.userId, 
        userName: session.userName, 
        attendantId: session.attendantId 
    });
}));

apiRouter.post('/chats/attendant-reply', asyncHandler(async (req, res) => {
    const { userId, text, attendantId, files, replyTo } = req.body;
    if (!userId || (!text && (!files || files.length === 0))) {
        return res.status(400).send('userId e um texto ou arquivos são obrigatórios.');
    }

    const session = activeChats.get(userId);
    if (!session || session.handledBy !== 'human' || session.attendantId !== attendantId) {
        return res.status(403).send('Permissão negada para responder a este chat.');
    }
    
    if (text) {
        outboundGatewayQueue.push({ userId, text });
    }
    if (files && files.length > 0) {
        files.forEach(file => {
             outboundGatewayQueue.push({ userId, file, text: file.name });
        });
    }
    
    const fileLogs = files ? files.map(f => ({ ...f })) : [];
    session.messageLog.push({ 
        sender: 'attendant', 
        text, 
        files: fileLogs, 
        timestamp: new Date().toISOString(),
        replyTo
    });
    
    res.status(200).send('Mensagem(ns) enfileirada(s) para envio.');
}));

apiRouter.post('/chats/edit-message', asyncHandler(async (req, res) => {
    const { userId, attendantId, messageTimestamp, newText } = req.body;

    if (!userId || !attendantId || !messageTimestamp || newText === undefined) {
        return res.status(400).send('Dados insuficientes para editar a mensagem.');
    }

    const session = activeChats.get(userId);
    if (!session) {
        return res.status(404).send('Sessão do usuário não encontrada em chats ativos.');
    }
    if (session.handledBy !== 'human' || session.attendantId !== attendantId) {
        return res.status(403).send('Permissão negada para editar mensagens neste chat.');
    }

    const messageIndex = session.messageLog.findIndex(
        msg => msg.timestamp === messageTimestamp && msg.sender === 'attendant'
    );

    if (messageIndex > -1) {
        session.messageLog[messageIndex].text = newText;
        session.messageLog[messageIndex].edited = true;
        console.log(`[Edit] Mensagem de ${attendantId} para ${userId} (timestamp: ${messageTimestamp}) foi editada.`);
        res.status(200).send('Mensagem editada com sucesso.');
    } else {
        console.warn(`[Edit] Tentativa de editar mensagem não encontrada para ${userId}. Timestamp: ${messageTimestamp}`);
        res.status(404).send('Mensagem original não encontrada para edição.');
    }
}));


apiRouter.post('/chats/transfer/:userId', asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { newAttendantId, transferringAttendantId } = req.body;

    const session = activeChats.get(userId);
    if (!session || session.attendantId !== transferringAttendantId) {
        return res.status(403).send('Permissão negada para transferir este chat.');
    }
    const newAttendant = ATTENDANTS.find(a => a.id === newAttendantId);
    if (!newAttendant) return res.status(404).send('Novo atendente não encontrado.');
    
    const oldAttendantName = ATTENDANTS.find(a => a.id === transferringAttendantId)?.name || 'Atendente anterior';

    session.attendantId = newAttendantId;
    const transferMessage = `Atendimento transferido de ${oldAttendantName} para ${newAttendant.name}.`;
    session.messageLog.push({ sender: 'system', text: transferMessage, timestamp: new Date().toISOString() });
    
    outboundGatewayQueue.push({ userId, text: `Você foi transferido para o atendente ${newAttendant.name}.` });
    
    res.status(200).json(session);
}));

apiRouter.post('/chats/resolve/:userId', asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { attendantId } = req.body;
    const session = activeChats.get(userId) || userSessions.get(userId);
    if (!session) return res.status(404).send('Chat não encontrado.');

    const attendant = ATTENDANTS.find(a => a.id === attendantId);

    session.resolvedAt = new Date().toISOString();
    session.resolvedBy = attendant ? attendant.name : 'Sistema';
    archiveSession(session);
    activeChats.delete(userId);
    userSessions.delete(userId);
    
    // Remove da fila, se estiver lá
    const queueIndex = requestQueue.findIndex(r => r.userId === userId);
    if (queueIndex > -1) requestQueue.splice(queueIndex, 1);
    
    outboundGatewayQueue.push({ userId, text: translations.pt.sessionEnded });
    console.log(`[Resolve] Chat com ${userId} foi resolvido e arquivado.`);
    res.status(200).send('Chat resolvido.');
}));

apiRouter.post('/chats/initiate', asyncHandler(async (req, res) => {
    const { recipientNumber, attendantId, message } = req.body;
    if (!recipientNumber || !attendantId || !message) {
        return res.status(400).send('Dados insuficientes para iniciar o chat.');
    }
    // O cliente pode não estar na lista de contatos, então usamos o número diretamente.
    const client = syncedContacts.find(c => c.userId === recipientNumber) || { userId: recipientNumber, userName: recipientNumber.split('@')[0] };

    const session = getSession(client.userId, client.userName);
    session.handledBy = 'human';
    session.attendantId = attendantId;
    
    const attendantName = ATTENDANTS.find(a => a.id === attendantId)?.name || 'Atendente';

    session.messageLog.push({ sender: 'system', text: `Conversa iniciada por ${attendantName}.`, timestamp: new Date().toISOString() });
    session.messageLog.push({ sender: 'attendant', text: message, timestamp: new Date().toISOString() });
    
    activeChats.set(client.userId, session);
    
    outboundGatewayQueue.push({ userId: client.userId, text: message });
    res.status(201).json({
        userId: session.userId,
        userName: session.userName,
        attendantId: session.attendantId,
    });
}));

// --- ROTAS DO CHAT INTERNO ---
apiRouter.get('/internal-chats/summary/:attendantId', asyncHandler(async (req, res) => {
    const { attendantId } = req.params;
    const summary = {};
    for (const [key, chat] of internalChats.entries()) {
        const participants = key.split('--');
        if (participants.includes(attendantId)) {
            const partnerId = participants.find(p => p !== attendantId);
            if (chat.length > 0) {
                summary[partnerId] = {
                    lastMessage: chat[chat.length - 1]
                };
            }
        }
    }
    res.status(200).json(summary);
}));

apiRouter.get('/internal-chats/:attendant1Id/:attendant2Id', asyncHandler(async (req, res) => {
    const { attendant1Id, attendant2Id } = req.params;
    const key = [attendant1Id, attendant2Id].sort().join('--');
    const chat = internalChats.get(key) || [];
    res.status(200).json(chat);
}));

apiRouter.post('/internal-chats', asyncHandler(async (req, res) => {
    const { senderId, recipientId, text, files, replyTo } = req.body;
    if (!senderId || !recipientId || (!text && (!files || files.length === 0))) {
        return res.status(400).send('Dados insuficientes para enviar mensagem interna.');
    }
    const key = [senderId, recipientId].sort().join('--');
    if (!internalChats.has(key)) {
        internalChats.set(key, []);
    }
    const sender = ATTENDANTS.find(a => a.id === senderId);
    const newMessage = {
        senderId,
        senderName: sender?.name || 'Desconhecido',
        text,
        files,
        replyTo,
        timestamp: new Date().toISOString()
    };
    internalChats.get(key).push(newMessage);
    res.status(201).send('Mensagem interna enviada.');
}));

apiRouter.post('/internal-chats/edit-message', asyncHandler(async (req, res) => {
    const { senderId, recipientId, messageTimestamp, newText } = req.body;
    if (!senderId || !recipientId || !messageTimestamp || newText === undefined) {
        return res.status(400).send('Dados insuficientes para editar a mensagem.');
    }
    const key = [senderId, recipientId].sort().join('--');
    const chat = internalChats.get(key);
    if (!chat) {
        return res.status(404).send('Chat interno não encontrado.');
    }
    const messageIndex = chat.findIndex(m => m.timestamp === messageTimestamp && m.senderId === senderId);
    if (messageIndex > -1) {
        chat[messageIndex].text = newText;
        chat[messageIndex].edited = true;
        res.status(200).send('Mensagem interna editada.');
    } else {
        res.status(404).send('Mensagem interna para editar não encontrada.');
    }
}));


// --- ROTAS DO GATEWAY ---
apiRouter.post('/gateway/sync-contacts', asyncHandler(async (req, res) => {
    const { contacts } = req.body;
    if (Array.isArray(contacts)) {
        syncedContacts = contacts;
        console.log(`[Gateway] Contatos sincronizados: ${contacts.length} recebidos.`);
        res.status(200).send('Contatos sincronizados.');
    } else {
        res.status(400).send('Formato de contatos inválido.');
    }
}));

apiRouter.get('/gateway/poll-outbound', asyncHandler(async (req, res) => {
    if (outboundGatewayQueue.length > 0) {
        const messagesToSend = [...outboundGatewayQueue];
        outboundGatewayQueue.length = 0; // Limpa a fila
        res.status(200).json(messagesToSend);
    } else {
        res.status(204).send(); // No content
    }
}));

// --- ROTA DE WEBHOOK ---
apiRouter.post('/whatsapp-webhook', (req, res) => {
    res.status(200).json({ replies: [] });
    processIncomingMessage(req.body).catch(err => {
        console.error(`[FATAL] Erro não capturado no processamento de fundo do webhook para o usuário ${req.body?.userId}:`, err);
    });
});


app.use('/api', apiRouter);
console.log('[Server Setup] Rotas da API registradas em /api');

// --- VERIFICAÇÃO DE BUILD E SERVIR ARQUIVOS ESTÁTICOS ---
const staticFilesPath = path.resolve(__dirname, 'dist');
const indexPath = path.join(staticFilesPath, 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error('[FATAL STARTUP ERROR] O arquivo principal do frontend (dist/index.html) não foi encontrado.');
  console.error('Isso geralmente significa que o comando `npm run build` (ou `vite build`) falhou.');
  console.error('Verifique os logs de build para encontrar o erro e corrija-o antes de tentar o deploy novamente.');
  process.exit(1); // Encerra o processo com um código de erro.
}

app.use(express.static(staticFilesPath));
console.log(`[Server Setup] Servindo arquivos estáticos de: ${staticFilesPath}`);

// --- ROTA "CATCH-ALL" PARA SPA (Single Page Application) ---
app.get('*', (req, res) => {
    if (!req.originalUrl.startsWith('/api')) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Rota de API não encontrada.');
    }
});


// --- ERROR HANDLING E INICIALIZAÇÃO DO SERVIDOR ---
app.use((err, req, res, next) => {
  console.error("[FATAL ERROR HANDLER] Erro não tratado na rota:", {
      path: req.path,
      method: req.method,
      error: err.message,
      stack: err.stack,
  });
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: 'Algo deu terrivelmente errado no servidor!' });
});

// --- VERIFICADOR DE TIMEOUT DA FILA DE ATENDIMENTO ---
const checkRequestQueueTimeout = () => {
    const now = new Date();
    const timeout = 10 * 60 * 1000; // 10 minutos
    const toRemove = [];

    for (const request of requestQueue) {
        const requestTime = new Date(request.timestamp);
        if (now - requestTime > timeout) {
            toRemove.push(request.userId);
        }
    }

    if (toRemove.length > 0) {
        console.log(`[Queue Timeout] Removendo ${toRemove.length} solicitações expiradas.`);
        for (const userId of toRemove) {
            const index = requestQueue.findIndex(r => r.userId === userId);
            if (index > -1) requestQueue.splice(index, 1);
            
            const session = getSession(userId);
            session.currentState = ChatState.GREETING; // Reseta o estado
            outboundGatewayQueue.push({ userId, text: "Sua solicitação de atendimento expirou por inatividade. Se ainda precisar de ajuda, por favor, comece novamente." });
        }
    }
};

// Inicia o verificador de timeout
setInterval(checkRequestQueueTimeout, 30 * 1000); 
console.log('[Server Setup] Verificador de timeout da fila de atendimento iniciado.');

app.listen(port, () => {
    console.log(`[JZF Chatbot Server] Servidor escutando na porta ${port}.`);
    console.log('[JZF Chatbot Server] Servidor ONLINE e pronto para receber requisições.');
});
