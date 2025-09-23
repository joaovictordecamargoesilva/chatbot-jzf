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

const SERVER_VERSION = "9.2.0_HISTORY_FIX";
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
        // @google/genai-ts FIX: Use the correct constructor with a named apiKey parameter as per the new SDK guidelines.
        ai = new GoogleGenAI({apiKey: API_KEY});
        console.log("[JZF Chatbot Server] Cliente Google GenAI inicializado com sucesso.");
    } catch (error)
 {
        console.error("[JZF Chatbot Server] ERRO: Falha ao inicializar o cliente Google GenAI.", error);
    }
} else {
    console.warn("[JZF Chatbot Server] AVISO: API_KEY não definida. Funcionalidades de IA estarão desativadas.");
}

// --- FUNÇÕES DE GERENCIAMENTO DE SESSÃO ---
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
        session.userName = userName; // Atualiza o nome se mudou
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
    let currentStep = conversationFlow.get(session.currentState);
    let nextState, payload;

    // LÓGICA CORRIGIDA: Prioriza a seleção numérica, mas permite texto se o passo exigir.
    const choice = parseInt(userInput.trim(), 10);
    const selectedOption = (currentStep.options && !isNaN(choice)) ? currentStep.options[choice - 1] : null;

    if (selectedOption) {
        // O usuário digitou um número e ele corresponde a uma opção válida.
        nextState = selectedOption.nextState;
        payload = selectedOption.payload;
    } else if (currentStep.requiresTextInput) {
        // O passo permite texto livre e o usuário não digitou uma opção numérica válida.
        nextState = currentStep.nextState;
        session.context.history[session.currentState] = userInput;
    } else {
        // O usuário digitou algo que não é nem uma opção válida nem um texto permitido.
        const invalidOptionMsg = "Opção inválida. Por favor, digite apenas o número da opção desejada.";
        replies.push(invalidOptionMsg);
        session.messageLog.push({ sender: 'bot', text: invalidOptionMsg, timestamp: new Date() });
        const stepFormatted = formatFlowStepForWhatsapp(currentStep, session.context);
        replies.push(stepFormatted);
        session.messageLog.push({ sender: 'bot', text: stepFormatted, timestamp: new Date() });
        return; // Encerra o processamento aqui
    }
    
    if (payload) {
        session.context = { ...session.context, ...payload };
    }
    
    if (nextState === ChatState.END_SESSION) {
        const endMsg = translations.pt.sessionEnded;
        replies.push(endMsg);
        session.messageLog.push({ sender: 'bot', text: endMsg, timestamp: new Date() });
        // Em vez de deletar, podemos apenas resetar para o início
        session.currentState = ChatState.GREETING;
        session.context = { history: {} };
        return;
    }
    
    let currentState = nextState;
    while(currentState) {
        session.currentState = currentState;
        const step = conversationFlow.get(currentState);
        if (!step) {
            console.error(`[Flow] Estado inválido: ${currentState}. Reiniciando sessão para ${userId}.`);
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
        
        if (step.nextState && !step.requiresTextInput && (!step.options || step.options.length === 0)) {
            currentState = step.nextState;
            await new Promise(r => setTimeout(r, 500));
        } else {
            currentState = null;
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
  const { userId, userName, userInput } = req.body;
  if (!userId || userInput === undefined) return res.status(400).json({ error: 'userId e userInput são obrigatórios.' });
  
  const session = getSession(userId, userName);
  session.messageLog.push({ sender: 'user', text: userInput, timestamp: new Date() });

  if (session.handledBy === 'human') {
      return res.status(200).json({ replies: [] }); // Message is logged, attendant will see it.
  }

  const replies = [];
  try {
    // Check for global commands first
    const lowerInput = userInput.trim().toLowerCase();
    if (['voltar', 'inicio', 'início', 'menu'].includes(lowerInput)) {
        session.currentState = ChatState.GREETING;
        session.context = { history: {} };
        const greetingStep = conversationFlow.get(ChatState.GREETING);
        const formattedReply = formatFlowStepForWhatsapp(greetingStep, session.context);
        replies.push(formattedReply);
        session.messageLog.push({ sender: 'bot', text: formattedReply, timestamp: new Date() });
    } else if (['sair', 'encerrar', 'finalizar'].includes(lowerInput)) {
        const endMsg = translations.pt.sessionEnded;
        replies.push(endMsg);
        session.messageLog.push({ sender: 'bot', text: endMsg, timestamp: new Date() });
        session.currentState = ChatState.GREETING; // Reset for next time
        session.context = { history: {} };
    } else {
        await processMessage(session, userInput, replies);
    }
    res.status(200).json({ replies });
  } catch (error) {
    console.error(`[Webhook] Erro CRÍTICO ao processar mensagem para ${userId}:`, error);
    res.status(500).json({ replies: [translations.pt.error] });
  }
});

apiRouter.post('/chat', async (req, res) => {
    if (!ai) return res.status(503).send("Funcionalidade de IA indisponível (API Key não configurada).");
    const { message, file, session } = req.body;
    if (session.currentState !== ChatState.AI_ASSISTANT_CHATTING) return res.status(400).send("Endpoint /api/chat é exclusivo para o assistente de IA.");
    
    try {
        const systemInstruction = departmentSystemInstructions.pt[session.context.department] || "Você é um assistente prestativo.";
        
        const contentParts = [];
        if (file) {
            contentParts.push({ inlineData: { mimeType: file.type, data: file.data } });
        }
        if (message) {
            contentParts.push({ text: message });
        }

        const contents = [
            ...(session.aiHistory || []),
            { role: 'user', parts: contentParts }
        ];

        const responseStream = await ai.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: contents,
            config: {
                systemInstruction: systemInstruction,
            }
        });
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        for await (const chunk of responseStream) {
            if (chunk && chunk.text) {
              res.write(chunk.text);
            }
        }
        res.end();
    } catch (error) {
        console.error("Erro na API do Gemini:", error);
        res.status(500).send("Falha ao se comunicar com o assistente de IA.");
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
apiRouter.get('/chats/active', (req, res) => res.status(200).json(Array.from(activeChats.values())));

// NOVA ROTA: Retorna chats que estão sendo atendidos pelo bot no estado de conversação com IA
apiRouter.get('/chats/ai-active', (req, res) => {
    const aiActiveChats = [];
    for (const session of userSessions.values()) {
        if (session.handledBy === 'bot' && session.currentState === ChatState.AI_ASSISTANT_CHATTING) {
            aiActiveChats.push({
                userId: session.userId,
                userName: session.userName,
                timestamp: session.createdAt, // Pode ser útil ter um timestamp
                department: session.context.department, // E o departamento
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
        clients.set(session.userId, { userId: session.userId, userName: session.userName });
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
    // CORREÇÃO: Buscar primeiro em sessões ativas e arquivadas. O uso de `getSession`
    // criava uma nova sessão vazia, sobrescrevendo o histórico ao ser visualizado.
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

    // Remove da fila de espera, se estiver lá.
    const queueIndex = requestQueue.findIndex(r => r.userId === userId);
    if (queueIndex > -1) {
        requestQueue.splice(queueIndex, 1);
        console.log(`[Takeover] Removido ${userId} da fila de espera.`);
    }

    // Se já estiver em um chat ativo, loga a reatribuição.
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
    const { userId, text, attendantId } = req.body;
    if (!userId || !text) return res.status(400).send('userId e text são obrigatórios.');

    const session = getSession(userId);
    if (!session || session.handledBy !== 'human' || session.attendantId !== attendantId) {
        return res.status(403).send('Permissão negada para responder a este chat.');
    }

    outboundGatewayQueue.push({ userId, text });
    session.messageLog.push({ sender: 'attendant', text, timestamp: new Date() });
    
    res.status(200).send('Mensagem enfileirada para envio.');
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

    if (activeChats.has(userId)) {
        const session = getSession(userId);
        if(session.attendantId !== attendantId) return res.status(403).send('Apenas o atendente responsável pode resolver o chat.');

        const closingMessage = `Seu atendimento foi concluído por *${attendant.name}*. Se precisar de mais alguma coisa, é só chamar! A JZF Contabilidade agradece o seu contato.`;
        outboundGatewayQueue.push({ userId, text: closingMessage });
        
        session.resolvedBy = attendant.name; // Salva o nome para exibição
        session.resolvedAt = new Date().toISOString();
        archivedChats.set(userId, { ...session });
        
        userSessions.delete(userId); 
        activeChats.delete(userId);

        console.log(`[Resolve] Atendimento para ${userId} resolvido por ${attendant.name}.`);
        res.status(200).send('Atendimento resolvido.');
    } else {
        res.status(404).send('Nenhum atendimento ativo encontrado para este usuário.');
    }
});

apiRouter.post('/chats/initiate', (req, res) => {
    const { recipientNumber, message, attendantId } = req.body;
    const attendant = ATTENDANTS.find(a => a.id === attendantId);
    if (!attendant) return res.status(400).send('Atendente inválido.');

    const userId = recipientNumber.endsWith('@c.us') ? recipientNumber : `${recipientNumber}@c.us`;

    if (activeChats.has(userId) || requestQueue.some(r => r.userId === userId)) {
        return res.status(409).send('Já existe uma conversa ativa ou na fila para este número.');
    }

    const session = getSession(userId, `Contato (${userId.split('@')[0]})`);
    session.handledBy = 'human';
    session.attendantId = attendantId;
    session.messageLog.push({ sender: 'system', text: `Conversa iniciada por ${attendant.name}.`, timestamp: new Date() });
    session.messageLog.push({ sender: 'attendant', text: message, timestamp: new Date() });

    const activeChatInfo = { userId, userName: session.userName, attendantId, timestamp: new Date().toISOString() };
    activeChats.set(userId, activeChatInfo);

    outboundGatewayQueue.push({ userId, text: message });

    console.log(`[Initiate] Nova conversa iniciada com ${userId} por ${attendant.name}.`);
    res.status(201).json(activeChatInfo);
});

// --- ROTAS DO CHAT INTERNO ---
const getInternalChatId = (id1, id2) => [String(id1), String(id2)].sort().join('-');

apiRouter.get('/internal-chats/:attendantId/:partnerId', (req, res) => {
    const { attendantId, partnerId } = req.params;
    const chatId = getInternalChatId(attendantId, partnerId);
    const chatHistory = internalChats.get(chatId) || [];
    res.status(200).json(chatHistory);
});

apiRouter.post('/internal-chats', (req, res) => {
    const { senderId, recipientId, text } = req.body;

    if (!senderId || !recipientId || !text || !text.trim()) {
        return res.status(400).json({ error: 'senderId, recipientId, and non-empty text are required.' });
    }

    const sender = ATTENDANTS.find(a => String(a.id) === String(senderId));
    if (!sender) {
        return res.status(404).json({ error: 'Sender not found.' });
    }
    
    const chatId = getInternalChatId(senderId, recipientId);
    if (!internalChats.has(chatId)) {
        internalChats.set(chatId, []);
    }

    const message = {
        senderId,
        senderName: sender.name,
        text,
        timestamp: new Date().toISOString()
    };
    
    internalChats.get(chatId).push(message);
    console.log(`[Internal Chat] Message from ${sender.name} to ${recipientId} in chat ${chatId}`);
    res.status(201).json(message);
});


// --- ROTAS DO GATEWAY ---
apiRouter.get('/gateway/poll-outbound', (req, res) => {
    if (outboundGatewayQueue.length > 0) {
        const messagesToSend = [...outboundGatewayQueue];
        outboundGatewayQueue.length = 0; // Limpa a fila
        res.status(200).json(messagesToSend);
    } else {
        res.status(204).send(); // No Content
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

console.log('[Server Setup] Configuration complete. Attempting to start listener...');

app.listen(port, () => {
    console.log(`[JZF Chatbot Server] Servidor escutando na porta ${port}.`);
    console.log('[JZF Chatbot Server] Servidor ONLINE e pronto para receber requisições.');
});
