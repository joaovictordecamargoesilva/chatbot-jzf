import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { conversationFlow } from "./chatbotLogic.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve arquivos estáticos do React
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "frontend/build")));

// Rota API
app.post("/chat", (req, res) => {
  const { message, state } = req.body;
  const response = conversationFlow(message, state);
  res.json({ response });
});

// Serve React para todas as outras rotas
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend/build", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
