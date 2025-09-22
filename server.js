import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// --- Setup básico do Express ---
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// --- Para usar __dirname no ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Rota principal, servindo HTML mínimo ---
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <title>Chatbot</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
        #chat { border: 1px solid #ccc; padding: 10px; height: 400px; overflow-y: scroll; background: #fff; }
        #input { width: 80%; padding: 10px; }
        #send { padding: 10px; }
      </style>
    </head>
    <body>
      <h1>Chatbot</h1>
      <div id="chat"></div>
      <input id="input" placeholder="Digite sua mensagem..." />
      <button id="send">Enviar</button>

      <script>
        const chatDiv = document.getElementById("chat");
        const input = document.getElementById("input");
        const sendBtn = document.getElementById("send");

        function addMessage(sender, message) {
          const p = document.createElement("p");
          p.innerHTML = "<b>" + sender + ":</b> " + message;
          chatDiv.appendChild(p);
          chatDiv.scrollTop = chatDiv.scrollHeight;
        }

        sendBtn.addEventListener("click", async () => {
          const msg = input.value;
          if (!msg) return;
          addMessage("Você", msg);
          input.value = "";

          // Envia para a API do servidor
          try {
            const res = await fetch("/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: msg })
            });
            const data = await res.json();
            addMessage("Bot", data.reply);
          } catch (err) {
            addMessage("Bot", "Erro ao se conectar ao servidor.");
          }
        });
      </script>
    </body>
    </html>
  `);
});

// --- Endpoint do chatbot ---
app.post("/chat", (req, res) => {
  const { message } = req.body;

  // Aqui você pode integrar seu chatbot real
  // Por enquanto, vamos retornar apenas uma resposta genérica
  const reply = "Você disse: " + message;

  res.json({ reply });
});

// --- Inicia o servidor ---
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
