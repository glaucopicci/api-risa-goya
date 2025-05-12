import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// Permite que o Express entenda o corpo vindo como application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));

// Também permite JSON, usado em outros momentos (ex: payload do item_id)
app.use(express.json());

const PORT = process.env.PORT || 10000;
const PODIO_ACCESS_TOKEN = process.env.PODIO_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Rota única para o webhook do Podio
app.post("/webhook", async (req, res) => {
  const { type, hook_id, code, item_id } = req.body;

  // Debug útil para entender o que o Podio está enviando
  console.log("📨 Dados recebidos:", req.body);

  // 🧩 Verificação inicial de webhook enviada pelo Podio (type = hook.verify)
  if (type === "hook.verify") {
    try {
      const response = await fetch(`https://api.podio.com/hook/${hook_id}/verify`, {
        method: "POST",
        headers: {
          Authorization: `OAuth2 ${PODIO_ACCESS_TOKEN}`,
          "Content-Type": "application/x-www-form-urlencoded", // 👈 O detalhe mais importante
        },
        body: new URLSearchParams({ code }).toString(),
      });

      if (response.ok) {
        console.log(`🔐 Webhook ${hook_id} verificado com sucesso`);
        return res.status(200).send("Verificado");
      } else {
        const errText = await response.text();
        console.error("❌ Falha na verificação:", errText);
        return res.status(500).send("Erro ao verificar webhook");
      }
    } catch (err) {
      console.error("❌ Erro ao validar webhook:", err);
      return res.status(500).send("Erro interno");
    }
  }

  // 🔄 Processamento do item após o webhook estar ativo
  if (item_id) {
    try {
      console.log("📦 Recebido item_id:", item_id);

      const podioResponse = await fetch(`https://api.podio.com/item/${item_id}`, {
        method: "GET",
        headers: {
          Authorization: `OAuth2 ${PODIO_ACCESS_TOKEN}`,
        },
      });

      const data = await podioResponse.json();
      const fields = data.fields;

      const statusField = fields.find(f => f.external_id === "status");
      const statusLabel = statusField?.values?.[0]?.value?.text;

      if (statusLabel?.toLowerCase() !== "revisar") {
        console.log("⏭️ Status não é 'Revisar' — ignorando.");
        return res.status(200).send();
      }

      const titulo = fields.find(f => f.external_id === "titulo-2")?.values?.[0]?.value || "(sem título)";
      const cliente = fields.find(f => f.external_id === "cliente")?.values?.[0]?.title || "(sem cliente)";
      const briefing = fields.find(f => f.external_id === "observacoes-e-links")?.values?.[0]?.value || "";

      const textoParaRevisar = `
Título: ${titulo}
Cliente: ${cliente}
Briefing: ${briefing}
      `.trim();

      console.log("✍️ Texto enviado para revisão:", textoParaRevisar);

      const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [
            {
              role: "system",
              content: "Você é Risa, uma IA editorial treinada para revisar textos institucionais com clareza, coesão e tom de marca.",
            },
            {
              role: "user",
              content: `Revise o texto abaixo com atenção à clareza, tom e coesão:\n\n${textoParaRevisar}`,
            },
          ],
          temperature: 0.7,
        }),
      });

      const json = await openaiResponse.json();
      const revisao = json.choices?.[0]?.message?.content;

      console.log("✅ Revisão gerada:", revisao);
      return res.status(200).send("Revisão enviada com sucesso.");
    } catch (err) {
      console.error("❌ Erro ao processar item:", err);
      return res.status(500).send("Erro interno");
    }
  } else {
    console.log("ℹ️ Webhook recebido sem item_id");
    return res.status(200).send("OK (sem item_id)");
  }
});

// Inicializa o servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

