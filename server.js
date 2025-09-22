import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { conversationFlow, translations } from "./chatbotLogic.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("Servidor rodando!");
});

app.post("/chat", (req, res) => {
  const { message, state } = req.body;
  const response = conversationFlow(message, state);
  res.json({ response });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
