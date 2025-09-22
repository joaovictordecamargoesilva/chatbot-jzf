import React, { useState, useEffect, useCallback, useRef } from "react";
import ReactDOM from "react-dom/client";
import { conversationFlow, translations, ChatState as ChatStateValues } from "./chatbotLogic.js";

// --- START: Merged from types.ts ---
const Sender = {
  USER: "user",
  BOT: "bot",
};

const ChatState = ChatStateValues;
// --- END: Merged from types.ts ---

function App() {
  const [messages, setMessages] = useState([
    { sender: Sender.BOT, text: translations["greeting"] },
  ]);
  const [input, setInput] = useState("");
  const [chatState, setChatState] = useState(ChatState.START);
  const messagesEndRef = useRef(null);

  const addMessage = useCallback((sender, text) => {
    setMessages((prev) => [...prev, { sender, text }]);
  }, []);

  const handleUserMessage = useCallback(
    (text) => {
      addMessage(Sender.USER, text);

      const stateFlow = conversationFlow[chatState];
      if (stateFlow) {
        const response = stateFlow.responses[text.toLowerCase()];
        if (response) {
          addMessage(Sender.BOT, response.message);
          if (response.nextState) {
            setChatState(response.nextState);
          }
        } else {
          addMessage(Sender.BOT, translations["default"]);
        }
      }
    },
    [chatState, addMessage]
  );

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input.trim()) {
      handleUserMessage(input.trim());
      setInput("");
    }
  };

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map((msg, idx) => (
          <div key={idx} className={`message ${msg.sender}`}>
            {msg.text}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <form onSubmit={handleSubmit} className="input-form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Digite sua mensagem..."
        />
        <button type="submit">Enviar</button>
      </form>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
