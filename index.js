import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
// Parâser para urlencoded e JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const PODIO_ACCESS_TOKEN = process.env.PODIO_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.post("/webhook", async (req, res) => {
  // Desestruturação incluindo revision_id
  const { type, hook_id, code, item_id, item_revision_id } = req.body;
  //console.log("📨 Dados recebidos:", req.body);

  // ETAPA 1 — Validação do webhook (hook.verify)
  if (type === "hook.verify") {
    try {
      console.log(`🔗 Validando webhook ${hook_id}`);
      const response = await fetch(
        `https://api.podio.com/hook/${hook_id}/verify/validate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${PODIO_ACCESS_TOKEN}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code }),
        }
      );
      const text = await response.text();
      console.log("📥 Resposta do Podio:", response.status, text);
      if (!response.ok) {
        console.error("❌ Falha na verificação:", response.status, text);
        return res.status(500).send("Erro ao verificar webhook");
      }
      console.log(`🔐 Webhook ${hook_id} validado com sucesso`);
      return res.sendStatus(200);
    } catch (err) {
      console.error("❌ Erro na verificação:", err);
      return res.status(500).send("Erro interno na verificação");
    }
  }

  // ETAPA 2 — Somente se item.update e status for Revisar
  if (type === "item.update" && item_id) {
    try {
      // 1) Obter campos alterados na revisão
      const revRes = await fetch(
        `https://api.podio.com/item/${item_id}/revision/${item_revision_id}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${PODIO_ACCESS_TOKEN}`,
            Accept: "application/json",
          },
        }
      );
      if (!revRes.ok) {
        console.warn(`⚠️ Não foi possível obter revision ${item_revision_id}: ${revRes.status}`);
        return res.sendStatus(200);
      }
      const revData = await revRes.json();
      const changedFields = Array.isArray(revData.fields) ? revData.fields : [];
      console.log("Campos alterados:", changedFields.map(f => f.external_id));

      // 2) Filtrar apenas quando status mudou para "revisar"
      const statusChange = changedFields.find(f => f.external_id === "status");
      const newStatus = statusChange?.values?.[0]?.value?.text?.toLowerCase();
      if (newStatus !== "revisar") {
        console.log("📦 Processando revisão para item_id:", item_id);
        console.log(`⏭️ Status mudou para "${newStatus || 'desconhecido'}" — ignorando.`);
        return res.sendStatus(200);
      }

      console.log("📦 Recebido item_id para Revisar:", item_id);

      // 3) Buscar item completo para extrair campos
      const podioRes = await fetch(`https://api.podio.com/item/${item_id}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${PODIO_ACCESS_TOKEN}` },
      });
      if (!podioRes.ok) {
        console.error(`❌ Erro ao buscar item ${item_id}: ${podioRes.status}`);
        return res.sendStatus(500);
      }
      const itemData = await podioRes.json();
      const fields = Array.isArray(itemData.fields) ? itemData.fields : [];

      // Extrair título, cliente e briefing
      const titulo = fields.find(f => f.external_id === "titulo-2")?.values?.[0]?.value || "(sem título)";
      const cliente = fields.find(f => f.external_id === "cliente")?.values?.[0]?.title || "(sem cliente)";
      const briefing = fields.find(f => f.external_id === "observacoes-e-links")?.values?.[0]?.value || "";

      const textoParaRevisar = `
Título: ${titulo}
Cliente: ${cliente}
Briefing: ${briefing}
      `.trim();
      console.log("✍️ Texto enviado para revisão:", textoParaRevisar);

      // 4) Chamada à OpenAI
      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [
            { role: "system", content: "Você é Risa, nossa IA editorial treinada para revisar textos institucionais com clareza, coesão e tom de marca." },
            { role: "user", content: `Revise o texto abaixo com atenção à clareza, tom e coesão:\n\n${textoParaRevisar}` },
          ],
          temperature: 0.7,
        }),
      });
      const openaiJson = await openaiRes.json();
      const revisao = openaiJson.choices?.[0]?.message?.content;
      console.log("✅ Revisão gerada:", revisao);

      // 5) Enviar revisão ao Podio (comentário)
      await fetch(`https://api.podio.com/comment/${item_id}/v2/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PODIO_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: revisao }),
      });

      return res.sendStatus(200);
    } catch (err) {
      console.error("❌ Erro ao processar item:", err);
      return res.status(500).send("Erro interno ao revisar item");
    }
  }

  // Ignora outros eventos
  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

