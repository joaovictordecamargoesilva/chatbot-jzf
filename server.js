// --- SERVIDOR DE API EXCLUSIVO PARA RENDER ---
// Versão para deploy limpo. Nenhuma lógica do wppconnect deve estar aqui.

import express from 'express';
// @google/genai-ts FIX: Use the correct class name as per the new SDK guidelines.
import { GoogleGenAI } from '@google/genai';
import path from 'path';
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


const SERVER_VERSION = "13.0.0_SMART_AUDIO";
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
        userSessions.set(userId, {
            userId: userId,
            userName: userName,
            currentState: ChatState.GREETING,
            context: { history: {} },
            aiHistory: [],
            messageLog: [],
            handledBy: 'bot', // 'bot' | 'human'
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

// --- PROCESSAMENTO PRINCIPAL DO CHATBOT (Lógica do WhatsApp) ---
async function processMessage(session, userInput, replies) {
    const { userId } = session;
    
    // SAFEGUARD: Se o estado for inválido, reseta para o início.
    if (!conversationFlow.has(session.currentState)) {
        console.error(`[Flow] Estado inválido ou desconhecido: "${session.currentState}" para o usuário ${userId}. Reiniciando a sessão.`);
        session.currentState = ChatState.GREETING;
    }
    
    let currentStep = conversationFlow.get(session.currentState);
    let nextState, payload;

    const choice = parseInt(userInput.trim(), 10);
    const selectedOption = (currentStep.options && !isNaN(choice)) ? currentStep.options[choice - 1] : null;

    if (selectedOption) {
        nextState = selectedOption.nextState;
        payload = selectedOption.payload;
    } else if (currentStep.requiresTextInput) {
        nextState = currentStep.nextState;
        session.context.history[session.currentState] = userInput;
    } else {
        // LÓGICA ATUALIZADA: No estado de GREETING, qualquer texto que não seja uma opção válida
        // simplesmente reenvia a mensagem de saudação, evitando o "opção inválida".
        if (session.currentState === ChatState.GREETING) {
            nextState = session.currentState;
            payload = null;
        } else {
            const invalidOptionMsg = "Opção inválida. Por favor, digite apenas o número da opção desejada.";
            replies.push(invalidOptionMsg);
            session.messageLog.push({ sender: 'bot', text: invalidOptionMsg, timestamp: new Date() });
            const stepFormatted = formatFlowStepForWhatsapp(currentStep, session.context);
            replies.push(stepFormatted);
            session.messageLog.push({ sender: 'bot', text: stepFormatted, timestamp: new Date() });
            return;
        }
    }
    
    if (payload) {
        session.context = { ...session.context, ...payload };
    }
    
    if (nextState === ChatState.END_SESSION) {
        const endMsg = translations.pt.sessionEnded;
        replies.push(endMsg);
        session.messageLog.push({ sender: 'bot', text: endMsg, timestamp: new Date() });
        session.resolvedBy = "Cliente";
        session.resolvedAt = new Date().toISOString();
        archiveSession(session);
        userSessions.delete(userId);
        console.log(`[Flow] Sessão para ${userId} finalizada pelo cliente e arquivada.`);
        return;
    }
    
    let currentState = nextState;
    while(currentState) {
        session.currentState = currentState;
        const step = conversationFlow.get(currentState);
        if (!step) {
            console.error(`[Flow] Estado inválido no loop: ${currentState}. Reiniciando sessão para ${userId}.`);
            currentState = ChatState.GREETING;
            continue;
        }

        if (currentState === ChatState.ATTENDANT_TRANSFER || currentState === ChatState.SCHEDULING_CONFIRMED) {
            const department = currentState === ChatState.SCHEDULING_CONFIRMED ? 'Agendamento' : session.context.department;
            const details = session.context.history[ChatState.SCHEDULING_NEW_CLIENT_DETAILS] || session.context.history[ChatState.SCHEDULING_EXISTING_CLIENT_DETAILS];
            const reason = currentState === ChatState.SCHEDULING_CONFIRMED
                ? `Solicitação de agendamento.\n- Tipo: ${session.context.clientType}\n- Detalhes: ${details}`
                : `Cliente pediu para falar com o setor ${department}.`;
            addRequestToQueue(session, department, reason);
        }
        const formattedReply = formatFlowStepForWhatsapp(step, session.context);
        replies.push(formattedReply);
        session.messageLog.push({ sender: 'bot', text: formattedReply, timestamp: new Date() });
        
        // Se o próximo passo não requer input e não tem opções, avança automaticamente.
        // A lógica é interrompida se `nextState` não estiver definido (como no ATTENDANT_TRANSFER).
        if (step.nextState && !step.requiresTextInput && (!step.options || step.options.length === 0)) {
            currentState = step.nextState;
            await new Promise(r => setTimeout(r, 500));
        } else {
            currentState = null; // Interrompe o loop
        }
    }
}
function formatFlowStepForWhatsapp(step, context) {
    let messageText = '';
    const textTemplate = translations.pt[step.textKey];
    if (textTemplate) { messageText = typeof textTemplate === 'function' ? textTemplate(context) : textTemplate; }
    if (step.options && step.options.length > 0) {
        const optionsText = step.options.map((opt, index) => `*${index + 1}*. ${translations.pt[opt.textKey] || opt.textKey}`).join('\n');
        messageText += `\n\n${optionsText}`;
    }
    return messageText;
}

// --- ROTAS DA API ---
const apiRouter = express.Router();

apiRouter.post('/whatsapp-webhook', async (req, res) => {
  const { userId, userName, userInput: originalInput, file, gatewayError } = req.body;
  if (!userId || originalInput === undefined) return res.status(400).json({ error: 'userId e userInput são obrigatórios.' });

  let effectiveInput = originalInput;
  const session = getSession(userId, userName);
  const isAudio = file && file.type && (file.type.startsWith('audio/') || file.type === 'application/ogg');

  // NOVO: Tratamento de erro do Gateway. Se a mídia falhar, apenas loga e não responde.
  if (gatewayError) {
      console.warn(`[Webhook] Erro de mídia do Gateway para ${userId}. Mensagem: "${originalInput}"`);
      session.messageLog.push({ sender: 'user', text: originalInput, file: null, timestamp: new Date() });
      return res.status(200).json({ replies: [] });
  }
  
  // Transcrição de áudio, se houver
  if (isAudio) {
      const transcription = await transcribeAudio(file);
      effectiveInput = transcription;
  }
  
  // Log da mensagem do usuário com texto (transcrito ou original) e arquivo (com base64)
  session.messageLog.push({ 
      sender: 'user', 
      text: effectiveInput, 
      file: file, 
      timestamp: new Date() 
  });

  if (session.handledBy === 'human') {
      return res.status(200).json({ replies: [] }); // Apenas loga a mensagem para o atendente.
  }
  
  const replies = [];
  try {
    // Se o usuário está no estado de chat com a IA, processa a mensagem com a IA.
    if (session.currentState === ChatState.AI_ASSISTANT_CHATTING) {
        const currentStep = conversationFlow.get(session.currentState);
        const choice = parseInt(effectiveInput.trim(), 10);
        const selectedOption = (currentStep.options && !isNaN(choice)) ? currentStep.options[choice - 1] : null;

        // Se a entrada do usuário corresponde a uma opção de menu (ex: "Falar com atendente"),
        // a lógica do `processMessage` será acionada para mudar de estado.
        if (selectedOption) {
            await processMessage(session, effectiveInput, replies);
        } else {
            // Se não for uma opção, é uma mensagem de texto livre para a IA.
            if (!ai) {
                const errorMsg = "Desculpe, o assistente de IA está temporariamente indisponível.";
                replies.push(errorMsg);
                session.messageLog.push({ sender: 'bot', text: errorMsg, timestamp: new Date() });
            } else {
                try {
                    // Adiciona a mensagem do usuário ao histórico da IA
                    session.aiHistory.push({ role: 'user', parts: [{ text: effectiveInput }] });
                    
                    // Gera a resposta da IA
                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: session.aiHistory,
                        config: { systemInstruction: departmentSystemInstructions.pt[session.context.department] || "Você é um assistente prestativo." }
                    });
                    const aiResponseText = response.text;
                    
                    replies.push(aiResponseText);
                    session.messageLog.push({ sender: 'bot', text: aiResponseText, timestamp: new Date() });
                    
                    // Adiciona a resposta da IA ao histórico
                    session.aiHistory.push({ role: 'model', parts: [{ text: aiResponseText }] });
                } catch (error) {
                    console.error(`[AI Chat] Erro CRÍTICO ao processar AI para ${userId}:`, error);
                    const errorMsg = translations.pt.error;
                    replies.push(errorMsg);
                    session.messageLog.push({ sender: 'bot', text: errorMsg, timestamp: new Date() });
                }
            }
        }
    } else {
        // Para TODOS os outros estados, incluindo GREETING, a lógica de menu padrão é usada.
        // Isso garante que o bot não tome ações proativas de IA e sempre siga o fluxo definido.
        await processMessage(session, effectiveInput, replies);
    }
    res.status(200).json({ replies });
  } catch (error) {
    console.error(`[Webhook] Erro CRÍTICO ao processar mensagem para ${userId}:`, error);
    res.status(500).json({ replies: [translations.pt.error] });
  }
});


// --- ROTAS DO PAINEL DE ATENDIMENTO ---
apiRouter.get('/attendants', (req, res) => res.status(200).json(ATTENDANTS));

apiRouter.post('/attendants', (req, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length < 3) {
        return res.status(400).json({ error: 'O nome é obrigatório e deve ter pelo menos 3 caracteres.' });
    }
    const newAttendant = {
        id: String(nextAttendantId++),
        name: name.trim(),
        departments: [],
    };
    ATTENDANTS.push(newAttendant);
    console.log(`[Attendants] Novo atendente criado: ${newAttendant.name} (ID: ${newAttendant.id})`);
    res.status(201).json(newAttendant);
});

apiRouter.get('/requests', (req, res) => res.status(200).json(requestQueue));

apiRouter.get('/chats/active', (req, res) => {
    const chats = Array.from(activeChats.values()).map(chat => {
        const session = userSessions.get(chat.userId);
        const lastMessage = session?.messageLog?.[session.messageLog.length - 1] || null;
        return { ...chat, lastMessage };
    });
    res.status(200).json(chats);
});

apiRouter.get('/chats/ai-active', (req, res) => {
    const aiActiveChats = [];
    for (const session of userSessions.values()) {
        if (session.handledBy === 'bot' && session.currentState === ChatState.AI_ASSISTANT_CHATTING) {
             const lastMessage = session.messageLog?.[session.messageLog.length - 1] || null;
            aiActiveChats.push({
                userId: session.userId,
                userName: session.userName,
                timestamp: session.createdAt,
                department: session.context.department,
                lastMessage: lastMessage
            });
        }
    }
    res.status(200).json(aiActiveChats);
});


apiRouter.get('/clients', (req, res) => {
    const clients = new Map();
    syncedContacts.forEach(c => {
        if (!clients.has(c.userId)) {
            clients.set(c.userId, { userId: c.userId, userName: c.userName });
        }
    });
    for (const session of userSessions.values()) {
        if (!clients.has(session.userId)) {
           clients.set(session.userId, { userId: session.userId, userName: session.userName });
        }
    }
    for (const chat of archivedChats.values()) {
         if (!clients.has(chat.userId)) {
            clients.set(chat.userId, { userId: chat.userId, userName: chat.userName });
        }
    }
    res.status(200).json(Array.from(clients.values()));
});


apiRouter.get('/chats/history', (req, res) => {
    const historyList = Array.from(archivedChats.values()).map(s => ({
        userId: s.userId,
        userName: s.userName,
        resolvedBy: s.resolvedBy,
        resolvedAt: s.resolvedAt,
    })).sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));
    res.status(200).json(historyList);
});

apiRouter.get('/chats/history/:userId', (req, res) => {
    const { userId } = req.params;
    const session = userSessions.get(userId) || archivedChats.get(userId);
    
    if (session) {
        res.status(200).json({
            userId: session.userId,
            userName: session.userName,
            handledBy: session.handledBy,
            attendantId: session.attendantId,
            messageLog: session.messageLog || [],
        });
    } else {
        res.status(404).send('Histórico não encontrado.');
    }
});

apiRouter.post('/chats/takeover/:userId', (req, res) => {
    const { userId } = req.params;
    const { attendantId } = req.body;
    const attendant = ATTENDANTS.find(a => a.id === attendantId);
    if (!attendant) return res.status(400).send('Atendente inválido.');

    const session = getSession(userId);
    if (!session) return res.status(404).send('Sessão do usuário não encontrada.');

    const queueIndex = requestQueue.findIndex(r => r.userId === userId);
    if (queueIndex > -1) {
        requestQueue.splice(queueIndex, 1);
        console.log(`[Takeover] Removido ${userId} da fila de espera.`);
    }

    if (activeChats.has(userId)) {
        console.log(`[Takeover] Reatribuindo chat ativo ${userId} para ${attendant.name}.`);
    }
    
    session.handledBy = 'human';
    session.attendantId = attendantId;
    
    const activeChatInfo = { userId, userName: session.userName, attendantId, timestamp: new Date().toISOString() };
    activeChats.set(userId, activeChatInfo);

    const takeoverMessage = `Olá! Meu nome é *${attendant.name}* e vou continuar seu atendimento.`;
    outboundGatewayQueue.push({ userId, text: takeoverMessage });
    session.messageLog.push({ sender: 'system', text: `Atendimento assumido por ${attendant.name}.`, timestamp: new Date() });
    session.messageLog.push({ sender: 'attendant', text: takeoverMessage.replace(/\*/g, ''), timestamp: new Date() });

    console.log(`[Takeover] Atendimento para ${userId} iniciado/assumido por ${attendant.name}.`);
    res.status(200).json(activeChatInfo);
});

apiRouter.post('/chats/attendant-reply', (req, res) => {
    // ATUALIZAÇÃO: Aceita `files` (array) em vez de `file` (objeto)
    const { userId, text, attendantId, files } = req.body; 
    if (!userId || (!text && (!files || files.length === 0))) {
        return res.status(400).send('userId e um texto ou arquivos são obrigatórios.');
    }

    const session = getSession(userId);
    if (!session || session.handledBy !== 'human' || session.attendantId !== attendantId) {
        return res.status(403).send('Permissão negada para responder a este chat.');
    }
    
    // Enfileira o texto (se houver) e cada arquivo separadamente para envio
    if (text) {
        outboundGatewayQueue.push({ userId, text });
    }
    if (files && files.length > 0) {
        files.forEach(file => {
             outboundGatewayQueue.push({ userId, file, text: file.name }); // Envia nome do arquivo como legenda
        });
    }
    
    // Loga uma única mensagem com o texto e todos os arquivos
    const fileLogs = files ? files.map(f => ({ ...f })) : [];
    session.messageLog.push({ sender: 'attendant', text, files: fileLogs, timestamp: new Date() });
    
    res.status(200).send('Mensagem(ns) enfileirada(s) para envio.');
});

apiRouter.post('/chats/transfer/:userId', (req, res) => {
    const { userId } = req.params;
    const { newAttendantId, transferringAttendantId } = req.body;
    
    const newAttendant = ATTENDANTS.find(a => a.id === newAttendantId);
    const transferringAttendant = ATTENDANTS.find(a => a.id === transferringAttendantId);
    if (!newAttendant || !transferringAttendant) return res.status(400).send('Atendente inválido.');

    const session = getSession(userId);
    if (!activeChats.has(userId) || session.attendantId !== transferringAttendantId) {
        return res.status(403).send('Não é possível transferir este chat.');
    }

    session.attendantId = newAttendantId;
    const activeChat = activeChats.get(userId);
    activeChat.attendantId = newAttendantId;

    const systemMessage = `Chat transferido de ${transferringAttendant.name} para ${newAttendant.name}.`;
    session.messageLog.push({ sender: 'system', text: systemMessage, timestamp: new Date() });
    
    const clientMessage = `Aguarde um momento, estou te transferindo para meu colega *${newAttendant.name}*.`;
    outboundGatewayQueue.push({ userId, text: clientMessage });
    
    console.log(`[Transfer] ${systemMessage}`);
    res.status(200).send('Transferência realizada com sucesso.');
});

apiRouter.post('/chats/resolve/:userId', (req, res) => {
    const { userId } = req.params;
    const { attendantId } = req.body;
    const attendant = ATTENDANTS.find(a => a.id === attendantId);

    const session = userSessions.get(userId);
    if (!session) {
        return res.status(404).send('Nenhum atendimento ativo encontrado para este usuário.');
    }
    
    if (session.handledBy === 'human' && session.attendantId !== attendantId) {
        return res.status(403).send('Apenas o atendente responsável pode resolver o chat.');
    }

    const closingMessage = `Seu atendimento foi concluído por *${attendant.name}*. Se precisar de mais alguma coisa, é só chamar! A JZF Contabilidade agradece o seu contato.`;
    outboundGatewayQueue.push({ userId, text: closingMessage });
    
    session.resolvedBy = attendant.name;
    session.resolvedAt = new Date().toISOString();
    archiveSession(session);
    
    userSessions.delete(userId); 
    activeChats.delete(userId);

    console.log(`[Resolve] Atendimento para ${userId} resolvido por ${attendant.name}.`);
    res.status(200).send('Atendimento resolvido.');
});

apiRouter.post('/chats/initiate', (req, res) => {
    const { recipientNumber, message, attendantId } = req.body;
    const attendant = ATTENDANTS.find(a => String(a.id) === String(attendantId));
    if (!attendant) return res.status(400).send('Atendente inválido.');

    const userId = recipientNumber.endsWith('@c.us') ? recipientNumber : `${recipientNumber}@c.us`;

    if (activeChats.has(userId) || requestQueue.some(r => r.userId === userId)) {
        return res.status(409).send('Já existe uma conversa ativa ou na fila para este número.');
    }

    const clientContact = syncedContacts.find(c => c.userId === userId);
    const userName = clientContact?.userName || `Contato (${userId.split('@')[0]})`;

    const session = getSession(userId, userName);
    session.handledBy = 'human';
    session.attendantId = attendantId;
    session.messageLog.push({ sender: 'system', text: `Conversa iniciada por ${attendant.name}.`, timestamp: new Date() });
    session.messageLog.push({ sender: 'attendant', text: message, timestamp: new Date() });

    const activeChatInfo = { userId, userName: session.userName, attendantId, timestamp: new Date().toISOString() };
    activeChats.set(userId, activeChatInfo);

    const messageForWhatsapp = `*${attendant.name}*: ${message}`;
    outboundGatewayQueue.push({ userId, text: messageForWhatsapp });

    console.log(`[Initiate] Nova conversa iniciada com ${userId} por ${attendant.name}.`);
    res.status(201).json(activeChatInfo);
});

// --- ROTAS DO CHAT INTERNO ---
const getInternalChatId = (id1, id2) => [String(id1), String(id2)].sort().join('-');

apiRouter.get('/internal-chats/summary/:attendantId', (req, res) => {
    const { attendantId } = req.params;
    const summary = {};
    for (const [chatId, messages] of internalChats.entries()) {
        if (chatId.includes(String(attendantId))) {
            const partnerId = chatId.split('-').find(id => id !== String(attendantId));
            if (partnerId && messages.length > 0) {
                summary[partnerId] = {
                    lastMessage: messages[messages.length - 1]
                };
            }
        }
    }
    res.status(200).json(summary);
});

apiRouter.get('/internal-chats/:attendantId/:partnerId', (req, res) => {
    const { attendantId, partnerId } = req.params;
    const chatId = getInternalChatId(attendantId, partnerId);
    const chatHistory = internalChats.get(chatId) || [];
    res.status(200).json(chatHistory);
});

apiRouter.post('/internal-chats', (req, res) => {
    const { senderId, recipientId, text, files } = req.body;

    if (!senderId || !recipientId || ((!text || !text.trim()) && (!files || files.length === 0))) {
        return res.status(400).json({ error: 'senderId, recipientId e texto ou arquivos são obrigatórios.' });
    }

    const sender = ATTENDANTS.find(a => String(a.id) === String(senderId));
    if (!sender) {
        return res.status(404).json({ error: 'Remetente não encontrado.' });
    }
    
    const chatId = getInternalChatId(senderId, recipientId);
    if (!internalChats.has(chatId)) {
        internalChats.set(chatId, []);
    }

    const message = {
        senderId,
        senderName: sender.name,
        text,
        files,
        timestamp: new Date().toISOString()
    };
    
    internalChats.get(chatId).push(message);
    console.log(`[Internal Chat] Mensagem de ${sender.name} para ${recipientId}. Arquivos: ${files ? files.length : '0'}`);
    res.status(201).json(message);
});


// --- ROTAS DO GATEWAY ---
apiRouter.get('/gateway/poll-outbound', (req, res) => {
    if (outboundGatewayQueue.length > 0) {
        const messagesToSend = [...outboundGatewayQueue];
        outboundGatewayQueue.length = 0;
        res.status(200).json(messagesToSend);
    } else {
        res.status(204).send();
    }
});

apiRouter.post('/gateway/sync-contacts', (req, res) => {
    const { contacts } = req.body;
    if (Array.isArray(contacts)) {
        syncedContacts = contacts;
        console.log(`[Gateway Sync] ${contacts.length} contatos sincronizados do WhatsApp.`);
        res.status(200).send('Contatos sincronizados.');
    } else {
        res.status(400).send('Formato de contatos inválido.');
    }
});


app.use('/api', apiRouter);
console.log('[Server Setup] Rotas da API registradas em /api');

// --- SERVINDO ARQUIVOS ESTÁTICOS ---
app.use(express.static(path.resolve(__dirname)));
console.log(`[Server Setup] Servindo arquivos estáticos de: ${path.resolve(__dirname)}`);


// --- ROTA "CATCH-ALL" PARA SPA (DEVE SER A ÚLTIMA) ---
app.get('*', (req, res) => {
    console.log(`[Catch-all] Rota não correspondida. Servindo index.html como fallback para: ${req.path}`);
    res.sendFile(path.resolve(__dirname, 'index.html'));
});

// --- ERROR HANDLING E INICIALIZAÇÃO DO SERVIDOR ---
app.use((err, req, res, next) => {
  console.error("ERRO INESPERADO NO SERVIDOR:", err.stack);
  res.status(500).send('Algo deu errado no servidor!');
});

// --- VERIFICADOR DE TIMEOUT DA FILA DE ATENDIMENTO ---
const checkRequestQueueTimeout = () => {
    const now = new Date();
    const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos

    for (let i = requestQueue.length - 1; i >= 0; i--) {
        const request = requestQueue[i];
        const requestAge = now - new Date(request.timestamp);

        if (requestAge > TIMEOUT_MS) {
            console.log(`[Timeout] A solicitação de ${request.userName} (${request.userId}) expirou.`);
            
            requestQueue.splice(i, 1); // Remove da fila

            const session = userSessions.get(request.userId);
            if (session) {
                // Notifica o usuário e reseta o estado dele
                const timeoutMessage = "Nossos atendentes parecem estar ocupados no momento. Enquanto você aguarda, você pode tentar falar com nosso assistente virtual ou escolher uma das opções abaixo novamente.";
                outboundGatewayQueue.push({ userId: request.userId, text: timeoutMessage });
                
                // Reseta a sessão e envia o menu de boas-vindas
                session.currentState = ChatState.GREETING;
                session.context = { history: {} };
                const greetingStep = conversationFlow.get(ChatState.GREETING);
                const formattedReply = formatFlowStepForWhatsapp(greetingStep, session.context);
                outboundGatewayQueue.push({ userId: request.userId, text: formattedReply });
            }
        }
    }
};

// Inicia o verificador de timeout
setInterval(checkRequestQueueTimeout, 30 * 1000); // Roda a cada 30 segundos
console.log('[Server Setup] Verificador de timeout da fila de atendimento iniciado.');

app.listen(port, () => {
    console.log(`[JZF Chatbot Server] Servidor escutando na porta ${port}.`);
    console.log('[JZF Chatbot Server] Servidor ONLINE e pronto para receber requisições.');
});
