
// --- SERVIDOR DE API EXCLUSIVO PARA RENDER ---
// Versão para deploy limpo. Nenhuma lógica do wppconnect deve estar aqui.

import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ChatState,
  conversationFlow,
  departmentSystemInstructions,
  translations
} from './chatbotLogic.js';

const SERVER_VERSION = "5.0.0_HUMAN_TAKEOVER";
console.log(`[JZF Chatbot Server] Iniciando... Versão: ${SERVER_VERSION}`);

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;

express.static.mime.types['tsx'] = 'text/javascript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
        ai = new GoogleGenAI({ apiKey: API_KEY });
        console.log("[JZF Chatbot Server] Cliente Google GenAI inicializado com sucesso.");
    } catch (error) {
        console.error("[JZF Chatbot Server] ERRO: Falha ao inicializar o cliente Google GenAI.", error);
    }
} else {
    console.warn("[JZF Chatbot Server] AVISO: API_KEY não definida. Funcionalidades de IA estarão desativadas.");
}

// --- GERENCIAMENTO DE SESSÃO, FILA E ATENDIMENTO ---
const userSessions = new Map();
const requestQueue = [];
const activeChats = new Map();
const outboundGatewayQueue = [];
let nextRequestId = 1;

function getSession(userId) {
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            userId: userId,
            currentState: ChatState.GREETING,
            context: { history: {} },
            aiHistory: [],
            messageLog: [],
            handledBy: 'bot',
        });
    }
    return userSessions.get(userId);
}

function addRequestToQueue(userId, department, message, fullContext) {
    if (requestQueue.some(r => r.userId === userId) || activeChats.has(userId)) {
        console.log(`[Queue] Bloqueada adição de ${userId} à fila pois já existe uma solicitação.`);
        return;
    }
    const request = {
        id: nextRequestId++,
        userId,
        department,
        message,
        timestamp: new Date().toISOString(),
        fullContext,
    };
    requestQueue.unshift(request);
    console.log(`[Queue] Nova solicitação adicionada: ID ${request.id} para o setor ${department}`);
}

// --- PROCESSAMENTO PRINCIPAL DO CHATBOT (Lógica do WhatsApp) ---
async function processMessage(session, userInput, replies) {
    const { userId } = session;
    let currentStep = conversationFlow.get(session.currentState);
    let nextState, payload;

    if (currentStep && currentStep.options && currentStep.options.length > 0) {
        const choice = parseInt(userInput.trim(), 10);
        const selectedOption = currentStep.options[choice - 1];
        if (selectedOption) {
            nextState = selectedOption.nextState;
            payload = selectedOption.payload;
        } else {
            const invalidOptionMsg = "Opção inválida. Por favor, digite apenas o número da opção desejada.";
            replies.push(invalidOptionMsg);
            session.messageLog.push({ sender: 'bot', text: invalidOptionMsg, timestamp: new Date() });
            
            const stepFormatted = formatFlowStepForWhatsapp(currentStep, session.context);
            replies.push(stepFormatted);
            session.messageLog.push({ sender: 'bot', text: stepFormatted, timestamp: new Date() });
            return;
        }
    } else if (currentStep && currentStep.requiresTextInput) {
        nextState = currentStep.nextState;
        session.context.history[session.currentState] = userInput;
    } else {
        nextState = ChatState.GREETING;
    }
    
    if (payload) {
        session.context = { ...session.context, ...payload };
    }
    
    if (nextState === ChatState.END_SESSION) {
        const endMsg = translations.pt.sessionEnded;
        replies.push(endMsg);
        session.messageLog.push({ sender: 'bot', text: endMsg, timestamp: new Date() });
        userSessions.delete(userId);
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
                ? `Solicitação de agendamento.\n\n- *Tipo:* ${session.context.clientType}\n- *Detalhes:* ${details}`
                : `Cliente pediu para falar com o setor ${department}.`;
            addRequestToQueue(userId, department, reason, session.context);
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
  const { userId, userInput } = req.body;
  if (!userId || userInput === undefined) return res.status(400).json({ error: 'userId e userInput são obrigatórios.' });
  
  const session = getSession(userId);
  session.messageLog.push({ sender: 'user', text: userInput, timestamp: new Date() });

  if (session.handledBy === 'human') {
      return res.status(200).json({ replies: [] }); // Message is logged, attendant will see it.
  }

  const replies = [];
  try {
    await processMessage(session, userInput, replies);
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
        const systemInstruction = departmentSystemInstructions.pt[session.conversationContext.department] || "Você é um assistente prestativo.";
        const chat = ai.chats.create({ model: 'gemini-2.5-flash', config: { systemInstruction }, history: session.aiHistory || [] });
        
        const contentParts = [];
        if (file) contentParts.push({ inlineData: { mimeType: file.type, data: file.data } });
        if (message) contentParts.push({ text: message });

        const responseStream = await chat.sendMessageStream(contentParts);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        for await (const chunk of responseStream) {
          res.write(chunk.text);
        }
        res.end();
    } catch (error) {
        console.error("Erro na API do Gemini:", error);
        res.status(500).send("Falha ao se comunicar com o assistente de IA.");
    }
});

// --- ROTAS DO PAINEL DE ATENDIMENTO ---
apiRouter.get('/requests', (req, res) => res.status(200).json(requestQueue));

apiRouter.get('/chats/history/:userId', (req, res) => {
    const session = getSession(req.params.userId);
    res.status(200).json(session.messageLog || []);
});

apiRouter.post('/chats/takeover/:userId', (req, res) => {
    const { userId } = req.params;
    const queueIndex = requestQueue.findIndex(r => r.userId === userId);
    if (queueIndex === -1) return res.status(404).send('Solicitação não encontrada na fila.');
    
    requestQueue.splice(queueIndex, 1);
    const session = getSession(userId);
    session.handledBy = 'human';
    activeChats.set(userId, session);

    const takeoverMessage = `Olá! Um de nossos atendentes irá te ajudar agora.`;
    outboundGatewayQueue.push({ userId, text: takeoverMessage });
    session.messageLog.push({ sender: 'bot', text: takeoverMessage, timestamp: new Date() });

    console.log(`[Takeover] Atendimento para ${userId} iniciado.`);
    res.status(200).send('Atendimento iniciado.');
});

apiRouter.post('/chats/attendant-reply', (req, res) => {
    const { userId, text } = req.body;
    if (!userId || !text) return res.status(400).send('userId e text são obrigatórios.');

    const session = getSession(userId);
    if (!session || session.handledBy !== 'human') {
        return res.status(400).send('Este usuário não está em atendimento humano.');
    }

    outboundGatewayQueue.push({ userId, text });
    session.messageLog.push({ sender: 'attendant', text, timestamp: new Date() });
    
    res.status(200).send('Mensagem enfileirada para envio.');
});

apiRouter.post('/chats/resolve/:userId', (req, res) => {
    const { userId } = req.params;
    if (activeChats.has(userId)) {
        const closingMessage = "Seu atendimento foi concluído. Se precisar de mais alguma coisa, é só chamar! A JZF Contabilidade agradece o seu contato.";
        outboundGatewayQueue.push({ userId, text: closingMessage });
        
        userSessions.delete(userId); 
        activeChats.delete(userId);

        console.log(`[Resolve] Atendimento para ${userId} resolvido.`);
        res.status(200).send('Atendimento resolvido.');
    } else {
        res.status(404).send('Nenhum atendimento ativo encontrado para este usuário.');
    }
});

// --- ROTA DO GATEWAY ---
apiRouter.get('/gateway/poll-outbound', (req, res) => {
    if (outboundGatewayQueue.length > 0) {
        const messagesToSend = [...outboundGatewayQueue];
        outboundGatewayQueue.length = 0; // Limpa a fila
        res.status(200).json(messagesToSend);
    } else {
        res.status(204).send(); // No Content
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

app.listen(port, () => {
    console.log(`[JZF Chatbot Server] Servidor escutando na porta ${port}.`);
    console.log('[JZF Chatbot Server] Servidor ONLINE e pronto para receber requisições.');
});
