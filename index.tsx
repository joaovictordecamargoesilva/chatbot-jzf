import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { conversationFlow, translations, ChatState as ChatStateValues } from './chatbotLogic.js';

// --- START: Merged from types.ts ---
// FIX: Removed 'as const' as it's TypeScript syntax. The browser runs JavaScript.
const Sender = {
  USER: 'user',
  BOT: 'bot',
};

// All type aliases and interfaces are removed as they are TypeScript-only.
const ChatState = ChatStateValues;
// --- END: Merged from types.ts ---


// --- START: Merged from components/TypingIndicator.tsx ---
// Removed TypeScript type annotation `: React.FC`
const TypingIndicator = () => (
  <div className="flex items-center space-x-1.5 p-4 self-start">
    <span className="sr-only">Bot está digitando</span>
    <div className="h-2 w-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
    <div className="h-2 w-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
    <div className="h-2 w-2 bg-gray-400 rounded-full animate-bounce"></div>
  </div>
);
// --- END: Merged from components/TypingIndicator.tsx ---


// --- START: Merged from components/MessageBubble.tsx ---
// Removed interface and TypeScript type annotation `: React.FC`
const MessageBubble = ({ message }) => {
  const isBot = message.sender === Sender.BOT;

  const bubbleClasses = isBot
    ? 'bg-white text-gray-800 self-start'
    : 'bg-[#dcf8c6] text-gray-800 self-end';

  return (
    <div className={`flex w-full ${isBot ? 'justify-start' : 'justify-end'}`}>
      <div
        className={`max-w-md md:max-w-lg lg:max-w-xl p-2 rounded-lg shadow-sm mb-1 flex flex-col ${bubbleClasses}`}
      >
        <div className="text-sm whitespace-pre-wrap">{message.text}</div>
        {message.file && (
            <div className="mt-2 p-2 bg-gray-100 rounded-lg flex items-center space-x-2 border border-gray-200">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="text-xs text-gray-700 font-medium truncate">{message.file.name}</span>
            </div>
        )}
      </div>
    </div>
  );
};
// --- END: Merged from components/MessageBubble.tsx ---


// --- START: Merged from components/ChatInput.tsx ---
// Removed interface and TypeScript type annotations
const ChatInput = ({ onUserInput, options, requiresTextInput, isBotTyping, onFileChange, selectedFile }) => {
  const [inputValue, setInputValue] = useState('');
  const fileInputRef = useRef(null);

  const handleSend = () => {
    if (inputValue.trim() || selectedFile) {
      onUserInput(inputValue.trim());
      setInputValue('');
    }
  };
  
  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleSend();
    }
  };

  const handleFileClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = (e) => {
    onFileChange(e.target.files?.[0] ?? null);
    if(fileInputRef.current) {
        fileInputRef.current.value = '';
    }
  };

  if (isBotTyping) {
    return <div className="h-24 bg-gray-100" />; // Placeholder to maintain height
  }
  
  return (
    <div className="p-2 bg-gray-100 border-t border-gray-200">
      {options && options.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
          {options.map((option) => (
            <button
              key={option.text}
              onClick={() => onUserInput(option.text, option)}
              disabled={isBotTyping}
              className="w-full bg-white text-blue-600 font-semibold py-2 px-4 rounded-lg border border-blue-500 hover:bg-blue-50 transition duration-200 disabled:bg-gray-300 disabled:text-gray-500 disabled:border-gray-300"
            >
              {option.text}
            </button>
          ))}
        </div>
      )}
      {requiresTextInput && (
        <>
        {selectedFile && (
            <div className="mb-2 p-2 bg-green-100 border border-green-200 rounded-lg flex items-center justify-between text-sm">
                <div className="flex items-center space-x-2 truncate">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                    <span className="text-gray-700 truncate">{selectedFile.name}</span>
                </div>
                <button onClick={() => onFileChange(null)} className="text-gray-500 hover:text-gray-700">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        )}
        <div className="flex items-center space-x-2">
            <input 
                type="file"
                ref={fileInputRef}
                onChange={handleFileSelected}
                className="hidden"
                accept=".pdf,.xml,.csv,.txt,.json,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp"
            />
            <button
                onClick={handleFileClick}
                disabled={isBotTyping}
                className="text-gray-500 p-2 rounded-full hover:bg-gray-200 transition duration-200 disabled:text-gray-300"
                aria-label="Anexar arquivo"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
            </button>
            <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={selectedFile ? "Descreva o arquivo..." : "Mensagem"}
                disabled={isBotTyping}
                className="flex-grow p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#005e54]"
                autoFocus
            />
            <button
                onClick={handleSend}
                disabled={isBotTyping || (!inputValue.trim() && !selectedFile)}
                className="bg-[#005e54] text-white p-3 rounded-full hover:bg-[#004c45] transition duration-200 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center"
                aria-label="Enviar mensagem"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
            </button>
        </div>
        </>
      )}
    </div>
  );
};
// --- END: Merged from components/ChatInput.tsx ---


// --- START: Merged from components/ChatWindow.tsx ---
// Removed interface and type annotations
const ChatWindow = ({ messages, isBotTyping }) => {
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isBotTyping]);

  return (
    <div className="flex-1 p-4 overflow-y-auto whatsapp-bg">
       <div className="flex flex-col space-y-2">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {isBotTyping && <TypingIndicator />}
        <div ref={chatEndRef} />
      </div>
    </div>
  );
};
// --- END: Merged from components/ChatWindow.tsx ---


// --- START: Merged from components/AttendantPanel.tsx ---
// Removed interface and type annotations
const AttendantPanel = () => {
  const [requests, setRequests] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchRequests = useCallback(async () => {
    try {
      const response = await fetch('/api/requests');
      if (!response.ok) {
        throw new Error('Falha ao buscar dados do servidor.');
      }
      const data = await response.json();
      setRequests(data);
      setError(null);
    } catch (err) {
      console.error(err);
      setError('Não foi possível conectar ao servidor do chatbot. Verifique se ele está em execução e se a página foi recarregada.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRequests();
    const intervalId = setInterval(fetchRequests, 5000); // Atualiza a cada 5 segundos

    return () => clearInterval(intervalId); // Limpa o intervalo quando o componente é desmontado
  }, [fetchRequests]);

  const handleResolve = async (id) => {
    try {
        const response = await fetch(`/api/requests/resolve/${id}`, {
            method: 'POST',
        });
        if (!response.ok) {
            throw new Error('Falha ao resolver a solicitação.');
        }
        setRequests(prev => prev.filter(req => req.id !== id));
    } catch (err) {
        console.error(err);
        alert('Ocorreu um erro ao tentar resolver a solicitação.');
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
    }, (err) => {
      console.error('Falha ao copiar texto: ', err);
    });
  };

  if (isLoading) {
    return <div className="flex-1 p-4 text-center text-gray-500">Carregando solicitações...</div>;
  }
  
  if (error) {
    return <div className="flex-1 p-4 text-center text-red-500 bg-red-50">{error}</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-100 p-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold text-gray-700">Fila de Atendimento</h2>
        <button onClick={fetchRequests} className="p-2 rounded-full hover:bg-gray-200 transition-colors" title="Atualizar Agora">
             <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M20 4h-5v5M4 20h5v-5M12 4V1m0 22v-3m8.9-15.9l-2.12-2.12M4.22 19.78l2.12-2.12M1 12H4m19 0h-3m-3.9-8.9l2.12-2.12M19.78 4.22l-2.12 2.12" />
             </svg>
        </button>
      </div>
      {requests.length === 0 ? (
        <div className="text-center text-gray-500 mt-16">
            <svg xmlns="http://www.w3.org/2000/svg" className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
            </svg>
            <p className="mt-2">Nenhuma solicitação de atendimento no momento.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => (
            <div key={req.id} className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
                <div className="flex justify-between items-start">
                    <div>
                        <span className="text-xs font-semibold uppercase text-white bg-blue-500 px-2 py-1 rounded-full">{req.department}</span>
                        <div className="flex items-center mt-2 group">
                             <p className="font-mono text-lg text-gray-800 mr-2">{req.userId}</p>
                             <button onClick={() => copyToClipboard(req.userId)} className="opacity-0 group-hover:opacity-100 transition-opacity" title="Copiar número">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                             </button>
                        </div>
                    </div>
                    <span className="text-xs text-gray-400">{new Date(req.timestamp).toLocaleTimeString('pt-BR')}</span>
                </div>
                <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap border-l-4 border-gray-200 pl-3">{req.message}</p>
                 <div className="text-right mt-3">
                    <button
                        onClick={() => handleResolve(req.id)}
                        className="bg-green-500 text-white text-xs font-bold py-1 px-3 rounded-md hover:bg-green-600 transition-colors"
                    >
                        Marcar como Resolvido
                    </button>
                </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
// --- END: Merged from components/AttendantPanel.tsx ---


// --- START: Merged from App.tsx ---
const App = () => {
  const [messages, setMessages] = useState([]);
  const [isBotTyping, setIsBotTyping] = useState(true);
  const [currentChatState, setCurrentChatState] = useState(ChatState.GREETING);
  const [conversationContext, setConversationContext] = useState({ history: {} });
  const [selectedFile, setSelectedFile] = useState(null);
  const [aiHistory, setAiHistory] = useState([]);
  const [view, setView] = useState('chatbot');
  
  const abortControllerRef = useRef(null);
  
  const addMessage = useCallback((message) => {
    setMessages((prev) => [...prev, { ...message, id: Date.now() + Math.random() }]);
  }, []);
  
  const getFlowResponse = useCallback((state, context) => {
    const flowStep = conversationFlow.get(state);
    
    if (!flowStep) {
        const greetingStep = conversationFlow.get(ChatState.GREETING);
        return {
            text: translations.pt[greetingStep.textKey] || "Error: Greeting text not found.",
            options: greetingStep.options?.map(opt => ({...opt, text: translations.pt[opt.textKey]})),
        };
    }

    let responseText;
    if (flowStep.textKey) {
        const template = translations.pt[flowStep.textKey];
        responseText = typeof template === 'function' ? template(context) : template;
    } else {
        responseText = typeof flowStep.text === 'function' ? flowStep.text(context) : (flowStep.text || '');
    }
    
    const responseOptions = flowStep.options?.map(opt => {
        const payload = typeof opt.payload === 'function' ? opt.payload(context) : opt.payload;
        return {
            ...opt,
            text: (opt.textKey ? translations.pt[opt.textKey] : opt.text) || 'Option',
            payload,
        };
    });
    
    return {
        text: responseText,
        options: responseOptions,
        requiresTextInput: flowStep.requiresTextInput
    };
  }, []);
  
  const processBotTurn = useCallback(async (nextState, context, userInput, file) => {
    setIsBotTyping(true);
    
    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
        if (nextState === ChatState.AI_ASSISTANT_CHATTING) {
            if (!userInput && !file) { // First entry into AI chat
                await new Promise(res => setTimeout(res, 500));
                const botResponse = getFlowResponse(nextState, context);
                addMessage({ ...botResponse, sender: Sender.BOT });
                setCurrentChatState(nextState);
                if(aiHistory.length === 0) { // Only on first entry
                     setAiHistory([]); 
                }
            } else {
                let filePayload = null;
                if (file) {
                    const base64Data = await new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve((reader.result).split(',')[1]);
                        reader.readAsDataURL(file);
                    });
                    filePayload = { name: file.name, type: file.type, data: base64Data };
                }

                const userMessageForHistory = { role: 'user', parts: [{ text: userInput }] };

                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: userInput,
                        file: filePayload,
                        session: {
                            currentState: nextState,
                            conversationContext: context,
                            aiHistory: aiHistory
                        }
                    }),
                    signal: controller.signal,
                });
                
                if (!response.ok || !response.body) {
                    throw new Error(`Server error: ${response.statusText}`);
                }

                let finalStreamedText = '';
                const messageId = Date.now() + Math.random();
                setMessages(prev => [...prev, { id: messageId, text: '', sender: Sender.BOT }]);

                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                let reading = true;
                while(reading) {
                    const { done, value } = await reader.read();
                    if(done) {
                        reading = false;
                        break;
                    }
                    finalStreamedText += decoder.decode(value, { stream: true });
                    setMessages(prev => prev.map(msg => msg.id === messageId ? { ...msg, text: finalStreamedText } : msg));
                }

                const modelMessageForHistory = { role: 'model', parts: [{ text: finalStreamedText }] };
                setAiHistory([...aiHistory, userMessageForHistory, modelMessageForHistory]);
                
                const finalOptions = [{ text: translations.pt.backToStart, nextState: ChatState.GREETING }];
                setMessages(prev => prev.map(msg => msg.id === messageId ? { ...msg, text: finalStreamedText, options: finalOptions, requiresTextInput: true } : msg));
            }
        } else {
            await new Promise(res => setTimeout(res, 1000));
            setAiHistory([]); // Reset AI history when leaving the AI flow
            let currentState = nextState;
            let currentContext = { ...context };
            
            if(userInput && (currentChatState === ChatState.SCHEDULING_NEW_CLIENT_DETAILS || currentChatState === ChatState.SCHEDULING_EXISTING_CLIENT_DETAILS)) {
              currentContext.history[currentChatState] = userInput;
            }

            while (currentState !== undefined) {
                const flowStep = conversationFlow.get(currentState);
                if (!flowStep) {
                    currentState = ChatState.GREETING;
                    continue;
                }
                
                const botResponse = getFlowResponse(currentState, currentContext);
                addMessage({ ...botResponse, sender: Sender.BOT });
                
                setCurrentChatState(currentState);

                if (flowStep.nextState && !flowStep.requiresTextInput && (!flowStep.options || flowStep.options.length === 0)) {
                    await new Promise(res => setTimeout(res, 1000));
                    currentState = flowStep.nextState;
                } else {
                    currentState = undefined;
                }
            }
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log("Busca abortada");
            return;
        }
        console.error("Erro durante o turno do bot:", error);
        const errorMessage = "Desculpe, ocorreu um erro de comunicação com o servidor. Por favor, tente novamente.";
        const botResponse = {
            text: errorMessage,
            options: [{ text: translations.pt.backToStart, nextState: ChatState.GREETING }],
        };
        addMessage({ ...botResponse, sender: Sender.BOT });
        const fallbackState = currentChatState === ChatState.AI_ASSISTANT_CHATTING ? ChatState.AI_ASSISTANT_CHATTING : ChatState.GREETING;
        setCurrentChatState(fallbackState);
    } finally {
        setIsBotTyping(false);
        abortControllerRef.current = null;
    }
  }, [addMessage, getFlowResponse, currentChatState, aiHistory]);

  const handleUserInput = async (userInput, option) => {
    const userMessageText = option?.text ?? userInput;
    
    addMessage({
      text: userMessageText,
      sender: Sender.USER,
      file: selectedFile ? { name: selectedFile.name } : undefined,
    });
    
    const isEndSession = option?.nextState === ChatState.END_SESSION;
    if (isEndSession) {
      setIsBotTyping(true);
      await new Promise(res => setTimeout(res, 500));
      addMessage({ text: translations.pt.sessionEnded, sender: Sender.BOT });
      await new Promise(res => setTimeout(res, 1500));
      
      setMessages([]);
      setConversationContext({ history: {} });
      setAiHistory([]);
      setSelectedFile(null);

      await processBotTurn(ChatState.GREETING, {});
      return;
    }

    let nextState = option ? option.nextState : currentChatState;
    let contextUpdate = option?.payload ? { ...conversationContext, ...option.payload } : { ...conversationContext };

    if (nextState === ChatState.AI_ASSISTANT_CHATTING && option?.payload?.department) {
        contextUpdate.department = option.payload.department;
        setAiHistory([]);
    }
    
    setConversationContext(contextUpdate);
    
    await processBotTurn(nextState, contextUpdate, userInput, selectedFile || undefined);
    setSelectedFile(null);
  };
  
  useEffect(() => {
    if (messages.length === 0) {
      processBotTurn(ChatState.GREETING, {});
    }
  }, []);

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto bg-white shadow-2xl rounded-lg overflow-hidden">
       <header className="bg-[#005e54] text-white p-3 flex items-center justify-between shadow-md">
        <div className="flex items-center">
            <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center mr-3 flex-shrink-0">
               <svg className="w-8 h-8 text-[#005e54]" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-semibold">JZF Contabilidade</h1>
              <p className="text-sm text-gray-200">
                {view === 'chatbot' ? 'Assistente Virtual' : 'Painel de Atendimento'}
              </p>
            </div>
        </div>
        <button 
          onClick={() => setView(v => v === 'chatbot' ? 'attendant' : 'chatbot')}
          className="p-2 rounded-full hover:bg-white/20 transition-colors"
          title={view === 'chatbot' ? 'Ver Painel de Atendimento' : 'Ver Simulação do Chatbot'}
        >
          {view === 'chatbot' ? (
             <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          )}
        </button>
      </header>
      
      {view === 'chatbot' ? (
        <>
          <ChatWindow messages={messages} isBotTyping={isBotTyping} />
          <ChatInput
            onUserInput={handleUserInput}
            options={lastMessage?.sender === Sender.BOT ? lastMessage.options : undefined}
            requiresTextInput={lastMessage?.sender === Sender.BOT ? lastMessage.requiresTextInput : false}
            isBotTyping={isBotTyping}
            onFileChange={setSelectedFile}
            selectedFile={selectedFile}
          />
        </>
      ) : (
        <AttendantPanel />
      )}
    </div>
  );
};
// --- END: Merged from App.tsx ---


// --- Final Render Call ---
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
