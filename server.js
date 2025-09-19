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

const SERVER_VERSION = "3.0.0_FRESH_START"; // Versão para depuração
console.log(`[JZF Chatbot Server] Iniciando... Versão: ${SERVER_VERSION}`);

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;

// --- 1. MIDDLEWARE DE LOG GLOBAL (DEVE SER O PRIMEIRO) ---
app.use((req, res, next) => {
  console.log(`[Request Logger] Recebida: ${req.method} ${req.originalUrl}`);
  next();
});

// --- 2. PARSERS E CONFIGURAÇÕES BÁSICAS ---
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

// --- GERENCIAMENTO DE SESSÃO E FILA ---
const userSessions = new Map();
const requestQueue = [];
let nextRequestId = 1;

function getSession(userId) {
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            userId: userId,
            currentState: ChatState.GREETING,
            context: { history: {} },
            aiHistory: []
        });
    }
    return userSessions.get(userId);
}

function addRequestToQueue(userId, department, message, fullContext) {
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

// --- LÓGICA DE FORMATAÇÃO DE MENSAGENS ---
function formatFlowStepForWhatsapp(step, context) {
    let messageText = '';
    const textTemplate = translations.pt[step.textKey];
    
    if (textTemplate) {
        messageText = typeof textTemplate === 'function' ? textTemplate(context) : textTemplate;
    }

    if (step.options && step.options.length > 0) {
        const optionsText = step.options
            .map((opt, index) => `${index + 1}. ${translations.pt[opt.textKey] || opt.textKey}`)
            .join('\n');
        messageText += `\n\n${optionsText}`;
    }
    return messageText;
}

// --- PROCESSAMENTO PRINCIPAL DO CHATBOT ---
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
            replies.push("Opção inválida. Por favor, digite apenas o número da opção desejada.");
            replies.push(formatFlowStepForWhatsapp(currentStep, session.context));
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
        replies.push(translations.pt.sessionEnded);
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

        replies.push(formatFlowStepForWhatsapp(step, session.context));
        
        if (step.nextState && !step.requiresTextInput && (!step.options || step.options.length === 0)) {
            currentState = step.nextState;
            await new Promise(r => setTimeout(r, 500));
        } else {
            currentState = null;
        }
    }
}

// --- 3. ROTAS DA API (ANTES DE QUALQUER ROTA DE ARQUIVO) ---
console.log('[Server Setup] Registrando rotas da API...');

app.post('/api/whatsapp-webhook', async (req, res) => {
  const { userId, userInput } = req.body;
  if (!userId || userInput === undefined) {
    console.error('[Webhook] Erro: Requisição inválida, faltando userId ou userInput.');
    return res.status(400).json({ error: 'userId e userInput são obrigatórios.' });
  }
  const session = getSession(userId);
  const replies = [];
  try {
    await processMessage(session, userInput, replies);
    res.status(200).json({ replies });
  } catch (error) {
    console.error(`[Webhook] Erro CRÍTICO ao processar mensagem para ${userId}:`, error);
    res.status(500).json({ replies: [translations.pt.error] });
  }
});

app.post('/api/chat', async (req, res) => {
    if (!ai) return res.status(503).send("Funcionalidade de IA indisponível (API Key não configurada).");
    const { message, file, session } = req.body;
    if (session.currentState !== ChatState.AI_ASSISTANT_CHATTING) {
        return res.status(400).send("Endpoint /api/chat é exclusivo para o assistente de IA.");
    }
    try {
        const systemInstruction = departmentSystemInstructions.pt[session.conversationContext.department] || "Você é um assistente prestativo.";
        const chat = ai.chats.create({ model: 'gemini-2.5-flash', config: { systemInstruction }, history: session.aiHistory || [] });
        const contentParts = [];
        if (file) contentParts.push({ inlineData: { mimeType: file.type, data: file.data } });
        contentParts.push({ text: message || '' });
        const responseStream = await chat.sendMessageStream({ parts: contentParts });
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        for await (const chunk of responseStream) res.write(chunk.text);
        res.end();
    } catch (error) {
        console.error("Erro na API do Gemini:", error);
        res.status(500).send("Falha ao se comunicar com o assistente de IA.");
    }
});

app.get('/api/requests', (req, res) => res.status(200).json(requestQueue));

app.post('/api/requests/resolve/:id', (req, res) => {
    const requestId = parseInt(req.params.id, 10);
    const index = requestQueue.findIndex(r => r.id === requestId);
    if (index !== -1) {
        requestQueue.splice(index, 1);
        res.status(200).send('Solicitação resolvida.');
    } else {
        res.status(404).send('Solicitação não encontrada.');
    }
});
console.log('[Server Setup] Rotas da API registradas com sucesso.');

// --- 4. SERVINDO ARQUIVOS ESTÁTICOS (FRONTEND) ---
console.log('[Server Setup] Configurando middleware para arquivos estáticos...');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '/')));
console.log(`[Server Setup] Servindo arquivos estáticos de: ${path.join(__dirname, '/')}`);

// --- 5. ROTA "CATCH-ALL" PARA SPA (DEVE SER A ÚLTIMA) ---
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/')) {
      console.log(`[Catch-all] Servindo index.html para a rota não API: ${req.path}`);
      res.sendFile(path.join(__dirname, 'index.html'));
    } else {
      res.status(404).send(`API route not found: ${req.method} ${req.path}`);
    }
});

// --- 6. ERROR HANDLING E INICIALIZAÇÃO DO SERVIDOR ---
app.use((err, req, res, next) => {
  console.error("ERRO INESPERADO NO SERVIDOR:", err.stack);
  res.status(500).send('Algo deu errado no servidor!');
});

app.listen(port, () => {
    console.log(`[JZF Chatbot Server] Servidor escutando na porta ${port}.`);
    console.log('[JZF Chatbot Server] Servidor ONLINE e pronto para receber requisições.');
});
