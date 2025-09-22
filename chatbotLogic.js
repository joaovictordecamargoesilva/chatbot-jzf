// chatbotLogic.js

// Estados possíveis do chatbot
export const ChatState = {
  INIT: 'init',
  WAITING_USER_INPUT: 'waiting_user_input',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
};

// Traduções e mensagens do chatbot
export const translations = {
  greeting: 'Olá! Como posso ajudar você hoje?',
  farewell: 'Obrigado por usar nosso serviço!',
  unknown: 'Desculpe, não entendi. Pode reformular?',
};

// Fluxo de conversas do chatbot
export const conversationFlow = {
  init: {
    message: translations.greeting,
    nextState: ChatState.WAITING_USER_INPUT,
  },
  fallback: {
    message: translations.unknown,
    nextState: ChatState.WAITING_USER_INPUT,
  },
  end: {
    message: translations.farewell,
    nextState: ChatState.COMPLETED,
  },
};

// Instruções do sistema de departamentos (novo export que faltava)
export const departmentSystemInstructions = `
Use este sistema para gerenciar departamentos:
- Criar novo departamento
- Atualizar dados existentes
- Remover departamentos obsoletos
- Consultar histórico e relatórios
`;
