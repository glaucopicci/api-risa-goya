import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = 10000;
const PODIO_ACCESS_TOKEN = process.env.PODIO_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.post("/podio-hook", async (req, res) => {
  const { type, hook_id, code, item_id } = req.body;

  // 🔐 Verificação de webhook real
  if (type === "hook.verify" && hook_id && code) {
    console.log("🔔 Recebido hook.verify", { hook_id, code });
    try {
      const response = await fetch(`https://api.podio.com/hook/${hook_id}/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `OAuth2 ${PODIO_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({ code }),
      });

      if (response.ok) {
        console.log(`✅ Webhook ${hook_id} verificado com sucesso.`);
        return res.status(200).send();
      } else {
        throw new Error("Falha na verificação do webhook");
      }
    } catch (error) {
      console.error("❌ Erro ao verificar webhook:", error);
      return res.status(500).send();
    }
  }

  // 🚀 Disparo real com item.update
  if (item_id) {
    try {
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
        console.log("⏭️ Status diferente de 'Revisar', ignorando...");
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
      res.status(200).send("Revisão enviada com sucesso.");

    } catch (err) {
      console.error("❌ Erro ao processar item:", err);
      res.status(500).send("Erro interno");
    }
  } else {
    res.status(200).send("OK");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

