// Traduções
export const translations = {
  greeting: "Olá! Como posso te ajudar hoje?",
  default: "Desculpe, não entendi. Pode reformular?",
};

// Estados do chatbot
export const ChatState = {
  START: "start",
  ASK_NAME: "ask_name",
  END: "end",
};

// Fluxo de conversas
export const conversationFlow = {
  [ChatState.START]: {
    responses: {
      "oi": { message: "Oi! Qual é o seu nome?", nextState: ChatState.ASK_NAME },
      "olá": { message: "Olá! Qual é o seu nome?", nextState: ChatState.ASK_NAME },
    },
  },
  [ChatState.ASK_NAME]: {
    responses: {
      // Qualquer texto será tratado como nome
      "*": { message: "Prazer em te conhecer, {user}! Como posso ajudar?", nextState: ChatState.END },
    },
  },
  [ChatState.END]: {
    responses: {
      "*": { message: "Obrigado pela conversa! Se precisar, estou por aqui." },
    },
  },
};
