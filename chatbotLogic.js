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
        { textKey: "backToStart", nextState: ChatState.GREETING },
      ],
    },
  ],
  [
    ChatState.AI_ASSISTANT_CHATTING,
    {
      textKey: 'aiDeptPrompt',
      options: [{ textKey: "backToStart", nextState: ChatState.GREETING }],
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
        nextState: ChatState.SCHEDULING_SUMMARY
    }
  ],
  [
    ChatState.SCHEDULING_EXISTING_CLIENT_DETAILS,
    {
        textKey: "schedulingExistingClientDetails",
        requiresTextInput: true,
        nextState: ChatState.SCHEDULING_SUMMARY
    }
  ],
  [
    ChatState.SCHEDULING_SUMMARY,
    {
      textKey: "schedulingSummary",
      options: [
        { textKey: "confirmYes", nextState: ChatState.SCHEDULING_CONFIRMED },
        { textKey: "confirmNo", nextState: ChatState.SCHEDULING_CLIENT_TYPE },
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
          { textKey: "backToStart", nextState: ChatState.GREETING },
      ]
    }
  ],
  [
    ChatState.ATTENDANT_TRANSFER,
    {
      textKey: 'attendantTransfer',
      // No nextState here, it becomes a waiting state.
    },
  ],
];

export const conversationFlow = new Map(flowSteps);

export const translations = {
  pt: {
    // General
    greeting: "Olá! Bem-vindo(a) ao Atendimento Virtual JZF. Sou seu assistente virtual. Como posso te ajudar hoje?\n\nNosso horário de atendimento é de segunda a sexta, das 08h00min às 17h50min.",
    backToStart: "↩️ Voltar ao Início",
    welcomeBack: "👋 Bem-vindo(a) de volta! Continuando de onde paramos.",
    sessionEnded: "Sessão finalizada. Se precisar de algo mais, é só chamar!",
    error: "Desculpe, ocorreu um erro de comunicação com o servidor. Por favor, tente novamente.",
    // Main Menu Options
    optionAiAssistant: "🧠 Tirar Dúvidas",
    optionScheduling: "📅 Agendar Reunião",
    optionAttendant: "💬 Falar com um Atendente",
    optionEndSession: '🔚 Finalizar Atendimento',
    // AI Assistant
    aiDeptSelect: "Com certeza! Para que eu possa te ajudar melhor, sobre qual área você tem dúvidas?",
    aiDeptPrompt: (context) => `Pode perguntar. Estou à disposição para ajudar com suas dúvidas sobre ${context.department}. Você também pode anexar um arquivo para análise.`,
    aiFollowUp: "\n\nAqui estão alguns tópicos relacionados:",
    // Departments
    deptRH: "RH",
    deptAccounting: "Contábil",
    deptTax: "Fiscal",
    deptCorporate: "Societário",
    // Scheduling
    schedulingClientType: "Para o agendamento, você já é nosso cliente?",
    clientTypeYes: "Sim, sou cliente",
    clientTypeNo: "Não, sou um novo cliente",
    schedulingNewClientDetails: "Entendido. Por favor, informe em uma *única mensagem* os seguintes dados para o agendamento:\n\n- Nome completo do responsável\n- Nome da empresa\n- Motivo da reunião\n- Modalidade (Online ou Presencial)",
    schedulingExistingClientDetails: "Que bom te ver de volta! Por favor, informe em uma *única mensagem* os seguintes dados para o agendamento:\n\n- Nome da empresa\n- Modalidade (Online ou Presencial)",
    schedulingSummary: (context) => {
      const clientType = context.clientType;
      const details = clientType === 'Novo Cliente' 
        ? context.history[ChatState.SCHEDULING_NEW_CLIENT_DETAILS]
        : context.history[ChatState.SCHEDULING_EXISTING_CLIENT_DETAILS];
      
      return `Ótimo! Por favor, confirme se as informações que você enviou estão corretas:\n
- *Tipo de Cliente:* ${clientType}
- *Detalhes Informados:* \n${details}\n
As informações estão corretas?`;
    },
    confirmYes: "Sim, confirmar solicitação",
    confirmNo: "Não, preencher novamente",
    schedulingConfirmed: `Obrigado! Sua solicitação de agendamento foi recebida com sucesso. Nossa equipe entrará em contato através deste número de WhatsApp para confirmar a melhor data e horário para você.\n\nSe precisar de mais alguma coisa, é só chamar!`,
    // Attendant
    attendantSelect: "Entendido. Para qual setor você gostaria de ser direcionado?",
    attendantTransfer: (context) => `Entendido. Estou direcionando sua conversa para o *Setor ${context.department}*. Por favor, aguarde e um de nossos especialistas irá responder em breve.\n\nNosso horário de atendimento humano é de segunda a sexta, das 08h00min às 17h50min. Se você estiver entrando em contato fora desse horário, sua mensagem será respondida no próximo dia útil.`,
  },
};

export const departmentSystemInstructions = {
  pt: {
    'RH': "Você é um assistente de contabilidade especialista em Recursos Humanos e Departamento Pessoal no Brasil. Responda em Português. Seja amigável e conversacional. Adapte-se ao estilo de escrita do usuário, compreendendo gírias, abreviações e linguagem informal.",
    'Contábil': "Você é um assistente de contabilidade especialista em normas contábeis brasileiras (CPCs) e práticas do dia a dia. Responda em Português. Seja amigável e conversacional. Adapte-se ao estilo de escrita do usuário, compreendendo gírias, abreviações e linguagem informal.",
    'Fiscal': "Você é um assistente de contabilidade especialista em legislação fiscal e tributária brasileira. Responda em Português. Seja amigável e conversacional. Adapte-se ao estilo de escrita do usuário, compreendendo gírias, abreviações e linguagem informal.",
    'Societário': "Você é um assistente de contabilidade especialista em direito societário, abertura, alteração e encerramento de empresas no Brasil. Responda em Português. Seja amigável e conversacional. Adapte-se ao estilo de escrita do usuário, compreendendo gírias, abreviações e linguagem informal.",
  },
};
