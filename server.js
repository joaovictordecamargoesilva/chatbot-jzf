// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import {
  conversationFlow,
  translations,
  ChatState,
  departmentSystemInstructions,
} from './chatbotLogic.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// Estado atual do chat (exemplo simples)
let chatState = ChatState.INIT;

// Endpoint inicial do chatbot
app.get('/chat', (req, res) => {
  const flow = conversationFlow.init;
  chatState = flow.nextState;
  res.json({ message: flow.message, state: chatState });
});

// Endpoint para enviar mensagem do usuário
app.post('/chat', (req, res) => {
  const userMessage = req.body.message || '';

  if (!userMessage) {
    return res.status(400).json({ error: 'Mensagem do usuário é obrigatória.' });
  }

  // Aqui você pode adicionar sua lógica de processamento de mensagens
  let response;
  if (userMessage.toLowerCase().includes('departamento')) {
    response = {
      message: departmentSystemInstructions,
      state: ChatState.PROCESSING,
    };
  } else {
    response = {
      message: conversationFlow.fallback.message,
      state: conversationFlow.fallback.nextState,
    };
  }

  chatState = response.state;
  res.json(response);
});

// Endpoint de finalização do chat
app.get('/chat/end', (req, res) => {
  const flow = conversationFlow.end;
  chatState = flow.nextState;
  res.json({ message: flow.message, state: chatState });
});

// Inicializa o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
