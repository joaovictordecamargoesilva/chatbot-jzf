// Exemplo de fluxo de conversa e traduções
export const conversationFlow = (message, state) => {
  // Aqui você coloca sua lógica de chatbot
  if (!message) return "Por favor, envie uma mensagem.";
  return `Você disse: ${message}`;
};

export const translations = {
  greeting: "Olá!",
  farewell: "Tchau!"
};

// Remover qualquer export que não existe
