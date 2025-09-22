import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// Ajustes para __dirname no ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { conversationFlow, translations, ChatState as ChatStateValues } from "./frontend/chatbotLogic.js"; // ajuste o caminho se necessário

const app = express();
const PORT = process.env.PORT || 10000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve o build do React
app.use(express.static(path.join(__dirname, "frontend/build")));

// Endpoint de teste do chatbot
app.post("/api/chat", (req, res) => {
  const { message } = req.body;
  // Exemplo simples de resposta
  const reply = conversationFlow[message] || "Desculpe, não entendi.";
  res.json({ reply });
});

// Qualquer rota não reconhecida retorna o index.html do React
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend/build", "index.html"));
});

// Inicializa o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
