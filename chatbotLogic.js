// Este arquivo é a ÚNICA FONTE DE VERDADE para a lógica, estados e textos do chatbot.
// Tanto o frontend (App.tsx) quanto o backend (server.js) devem usar este arquivo.

export const ChatState = {
  GREETING: 'GREETING',
  AI_ASSISTANT_SELECT_DEPT: 'AI_ASSISTANT_SELECT_DEPT',
  AI_ASSISTANT_CHATTING: 'AI_ASSISTANT_CHATTING',
  SCHEDULING_CLIENT_TYPE: 'SCHEDULING_CLIENT_TYPE',
  SCHEDULING_NEW_CLIENT_DETAILS: 'SCHEDULING_NEW_CLIENT_DETAILS',
  SCHEDULING_EXISTING_CLIENT_DETAILS: 'SCHEDULING_EXISTING_CLIENT_DETAILS',
  SCHEDULING_SUMMARY: 'SCHEDULING_SUMMARY',
  SCHEDULING_CONFIRMED: 'SCHEDULING_CONFIRMED', // Ponto de transferência
  ATTENDANT_SELECT: 'ATTENDANT_SELECT',
  ATTENDANT_TRANSFER: 'ATTENDANT_TRANSFER', // Ponto de transferência
  END_SESSION: 'END_SESSION',
};

const commonNavigationOptions = [
    { textKey: "backToStart", nextState: ChatState.GREETING },
    { textKey: "optionEndSession", nextState: ChatState.END_SESSION },
];

const flowSteps = [
  [
    ChatState.GREETING,
    {
      textKey: "greeting",
      options: [
        { textKey: "optionAiAssistant", nextState: ChatState.AI_ASSISTANT_SELECT_DEPT },
        { textKey: "optionScheduling", nextState: ChatState.SCHEDULING_CLIENT_TYPE },
        { textKey: "optionAttendant", nextState: ChatState.ATTENDANT_SELECT },
        { textKey: "optionEndSession", nextState: ChatState.END_SESSION },
      ],
      requiresTextInput: false,
    },
  ],
  // AI Assistant Flow
  [
    ChatState.AI_ASSISTANT_SELECT_DEPT,
    {
      textKey: "aiDeptSelect",
      options: [
        { textKey: "deptRH", nextState: ChatState.AI_ASSISTANT_CHATTING, payload: { department: "RH" } },
        { textKey: "deptAccounting", nextState: ChatState.AI_ASSISTANT_CHATTING, payload: { department: "Contábil" } },
        { textKey: "deptTax", nextState: ChatState.AI_ASSISTANT_CHATTING, payload: { department: "Fiscal" } },
        { textKey: "deptCorporate", nextState: ChatState.AI_ASSISTANT_CHATTING, payload: { department: "Societário" } },
        { textKey: "deptFinancial", nextState: ChatState.AI_ASSISTANT_CHATTING, payload: { department: "Financeiro" } },
        { textKey: "backToStart", nextState: ChatState.GREETING },
      ],
      requiresTextInput: false,
    },
  ],
  [
    ChatState.AI_ASSISTANT_CHATTING,
    {
      textKey: 'aiDeptPrompt',
      options: [
        { textKey: "optionHumanTransfer", nextState: ChatState.ATTENDANT_SELECT },
        { textKey: "backToStart", nextState: ChatState.GREETING },
        { textKey: "optionEndSession", nextState: ChatState.END_SESSION },
      ],
      requiresTextInput: true,
    },
  ],
  // Scheduling Flow
  [
    ChatState.SCHEDULING_CLIENT_TYPE,
    {
        textKey: "schedulingClientType",
        options: [
            { textKey: "clientTypeNo", nextState: ChatState.SCHEDULING_NEW_CLIENT_DETAILS, payload: { clientType: "Novo Cliente" } },
            { textKey: "clientTypeYes", nextState: ChatState.SCHEDULING_EXISTING_CLIENT_DETAILS, payload: { clientType: "Cliente Existente" } },
            { textKey: "backToStart", nextState: ChatState.GREETING },
        ]
    }
  ],
  [
    ChatState.SCHEDULING_NEW_CLIENT_DETAILS,
    {
        textKey: "schedulingNewClientDetails",
        requiresTextInput: true,
        nextState: ChatState.SCHEDULING_SUMMARY,
        options: commonNavigationOptions,
    }
  ],
  [
    ChatState.SCHEDULING_EXISTING_CLIENT_DETAILS,
    {
        textKey: "schedulingExistingClientDetails",
        requiresTextInput: true,
        nextState: ChatState.SCHEDULING_SUMMARY,
        options: commonNavigationOptions,
    }
  ],
  [
    ChatState.SCHEDULING_SUMMARY,
    {
      textKey: "schedulingSummary",
      options: [
        { textKey: "confirmYes", nextState: ChatState.SCHEDULING_CONFIRMED },
        { textKey: "confirmNo", nextState: ChatState.SCHEDULING_CLIENT_TYPE },
        ...commonNavigationOptions
      ],
    },
  ],
  [
    ChatState.SCHEDULING_CONFIRMED,
    {
      textKey: "schedulingConfirmed",
      nextState: ChatState.GREETING,
    },
  ],
  // Attendant Flow
  [
    ChatState.ATTENDANT_SELECT,
    {
      textKey: "attendantSelect",
      options: [
        { textKey: "deptRH", nextState: ChatState.ATTENDANT_TRANSFER, payload: { department: "RH" } },
        { textKey: "deptAccounting", nextState: ChatState.ATTENDANT_TRANSFER, payload: { department: "Contábil" } },
        { textKey: "deptTax", nextState: ChatState.ATTENDANT_TRANSFER, payload: { department: "Fiscal" } },
        { textKey: "deptCorporate", nextState: ChatState.ATTENDANT_TRANSFER, payload: { department: "Societário" } },
        { textKey: "deptFinancial", nextState: ChatState.ATTENDANT_TRANSFER, payload: { department: "Financeiro" } },
        { textKey: "backToStart", nextState: ChatState.GREETING },
      ],
    },
  ],
  [
    ChatState.ATTENDANT_TRANSFER,
    {
      // A chave do texto foi alterada para refletir a nova mensagem de espera.
      textKey: "attendantTransferWait", 
      // IMPORTANTE: O nextState foi removido. Isso faz com que o bot pare aqui
      // e aguarde a intervenção de um atendente, em vez de voltar ao menu principal.
    },
  ],
  [
    ChatState.END_SESSION,
    {
      textKey: "sessionEnded",
    },
  ],
];

export const conversationFlow = new Map(flowSteps);

// --- TEXTOS E TRADUÇÕES ---
export const translations = {
    pt: {
        greeting: "Olá! Eu sou o assistente virtual da JZF Contabilidade. Como posso te ajudar hoje?",
        optionAiAssistant: "🤖 Falar com Assistente Virtual",
        optionScheduling: "📅 Agendar um horário",
        optionAttendant: "🙋‍♂️ Falar com um atendente",
        optionEndSession: "🚪 Encerrar conversa",
        optionHumanTransfer: "🗣️ Falar com um atendente",
        
        aiDeptSelect: "Para qual departamento você gostaria de direcionar sua pergunta?",
        deptRH: "RH (Recursos Humanos)",
        deptAccounting: "Contábil",
        deptTax: "Fiscal",
        deptCorporate: "Societário",
        deptFinancial: "Financeiro",
        backToStart: "↩️ Voltar ao início",

        aiDeptPrompt: (context) => `Ok, você selecionou o departamento *${context.department}*. Pode me fazer sua pergunta agora. Se precisar, pode também me enviar um arquivo (como PDF, imagem ou planilha).\n\nSe preferir, escolha uma das opções abaixo:`,

        schedulingClientType: "Para começar o agendamento, por favor, me informe: você já é nosso cliente?",
        clientTypeYes: "Sim, já sou cliente",
        clientTypeNo: "Não, sou um novo cliente",
        
        schedulingNewClientDetails: "Entendido. Por favor, descreva o motivo do seu contato, seu nome completo e um telefone para que possamos preparar nosso encontro.",
        schedulingExistingClientDetails: "Ok. Por favor, informe o nome da sua empresa (ou seu nome completo) e o motivo do contato para agilizarmos o seu atendimento.",
        
        schedulingSummary: (context) => {
            const details = context.history[ChatState.SCHEDULING_NEW_CLIENT_DETAILS] || context.history[ChatState.SCHEDULING_EXISTING_CLIENT_DETAILS];
            return `Obrigado! Revise as informações, por favor:\n\n- *Tipo:* ${context.clientType}\n- *Detalhes:* ${details}\n\nEstá tudo correto?`;
        },
        confirmYes: "👍 Sim, está correto",
        confirmNo: "👎 Não, quero corrigir",
        
        schedulingConfirmed: "Perfeito! Sua solicitação de agendamento foi enviada. Em breve, um de nossos especialistas entrará em contato para confirmar a data e a hora.",

        attendantSelect: "Entendido. Para qual departamento você precisa de atendimento humano?",
        attendantTransfer: (context) => `Ok, estou te transferindo para um atendente do setor *${context.department}*. Por favor, aguarde um momento.`,
        // Nova mensagem de espera, conforme solicitado.
        attendantTransferWait: "Aguarde, em alguns instantes um de nossos atendentes irá te atender.",

        sessionEnded: "Obrigado por utilizar nossos serviços. A JZF Contabilidade está sempre à disposição!",
        error: "Desculpe, ocorreu um erro inesperado. Por favor, tente novamente mais tarde.",
    }
};

// --- INSTRUÇÕES DE SISTEMA PARA A IA ---
const instructionSuffix = "Responda sempre em português do Brasil. Ao final de cada resposta completa e útil, adicione uma frase perguntando se o usuário precisa de mais alguma coisa e lembre-o de que ele pode usar a opção '🚪 Encerrar conversa' para finalizar o atendimento. Exemplo: 'Isso ajuda a esclarecer sua dúvida? Se não precisar de mais nada, é só escolher a opção para encerrar.' Se você não souber a resposta para uma pergunta, peça desculpas, diga que não entendeu e sugira que o usuário fale com um atendente humano para obter ajuda especializada.";

export const departmentSystemInstructions = {
    pt: {
        "RH": `Você é um especialista em RH da JZF Contabilidade. Responda a perguntas sobre folhas de pagamento, benefícios, legislação trabalhista e processos de RH de forma clara e objetiva. ${instructionSuffix}`,
        "Contábil": `Você é um especialista contábil da JZF Contabilidade. Responda a perguntas sobre balanços, DRE, impostos sobre lucro, e outras questões contábeis com precisão. ${instructionSuffix}`,
        "Fiscal": `Você é um especialista fiscal da JZF Contabilidade. Responda a perguntas sobre ICMS, IPI, PIS, COFINS, Simples Nacional e outras obrigações fiscais. ${instructionSuffix}`,
        "Societário": `Você é um especialista em questões societárias da JZF Contabilidade. Responda a perguntas sobre abertura, alteração e encerramento de empresas, contratos sociais e tipos de sociedade. ${instructionSuffix}`,
        "Financeiro": `Você é um especialista do departamento financeiro da JZF Contabilidade. Responda a perguntas sobre faturamento, boletos, pagamentos e renegociação de dívidas de forma clara e educada. ${instructionSuffix}`
    }
};
