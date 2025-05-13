import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

// ── Função para obter um access_token sempre fresco ──
async function getAccessToken() {
  const resp = await fetch("https://podio.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: process.env.PODIO_CLIENT_ID,
      client_secret: process.env.PODIO_CLIENT_SECRET,
      refresh_token: process.env.PODIO_REFRESH_TOKEN
    })
  });

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(
      `Falha ao renovar token Podio (${resp.status}): ${json.error_description || JSON.stringify(json)}`
    );
  }

  // Opcional: se quiser atualizar o refresh_token em runtime:
  // process.env.PODIO_REFRESH_TOKEN = json.refresh_token;

  return json.access_token;
}

const app = express();

// Middlewares para parsing de JSON e form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const PODIO_ACCESS_TOKEN = process.env.PODIO_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// DEBUG: verifique no deploy se aparece true
console.log("🔑 Podio token presente?", !!PODIO_ACCESS_TOKEN);


 app.post("/webhook", async (req, res) => {
   // 1) Todo fluxo do Podio começa com um token fresco
   let podioToken;
   try {
     podioToken = await getAccessToken();
   } catch (err) {
     console.error("🚨 Não foi possível obter Podio token:", err);
     return res.sendStatus(500);
   }
   const { type, hook_id, code, item_id, item_revision_id } = req.body;


  //
  // ETAPA 2 — Validação do webhook no Podio
  //
  if (type === "hook.verify") {
    try {
      console.log(`🔗 Validando webhook ${hook_id}`);
      const verifyRes = await fetch(
        `https://api.podio.com/hook/${hook_id}/verify/validate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${podioToken}`
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code }),
        }
      );
      if (!verifyRes.ok) {
        const errText = await verifyRes.text();
        console.error("❌ Falha na verificação:", errText);
        return res.sendStatus(500);
      }
      console.log(`🔐 Webhook ${hook_id} validado com sucesso`);
      return res.sendStatus(200);
    } catch (err) {
      console.error("❌ Erro interno na verificação:", err);
      return res.sendStatus(500);
    }
  }

  //
  // ETAPA 3 — Processar ITEM.UPDATE **somente** se Status Texto for "Revisar"
  //
  if (type === "item.update" && item_id && item_revision_id) {
    try {
      // 1) Busca o item completo no Podio
      const itemRes = await fetch(`https://api.podio.com/item/${item_id}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${podioToken}`,
          Accept: "application/json",
        },
      });
      if (!itemRes.ok) {
        console.warn(`⚠️ Não foi possível buscar item ${item_id}: ${itemRes.status}`);
        return res.sendStatus(200);
      }

      const itemData = await itemRes.json();
      const fields = Array.isArray(itemData.fields) ? itemData.fields : [];

      // 2) Extrai o valor atual do campo "status" (Status Texto)
      const statusField = fields.find((f) => f.external_id === "status");
      const statusLabel = statusField?.values?.[0]?.value?.text?.toLowerCase();

      // 3) Se não for "revisar", ignora imediatamente
      if (statusLabel !== "revisar") {
        return res.sendStatus(200);
      }

      // 4) Só agora logamos e processamos
      console.log("📦 Processando revisão para item_id:", item_id);

      // 5) Extrai título, cliente e briefing
      const titulo =
        fields.find((f) => f.external_id === "titulo-2")?.values?.[0]?.value ||
        "(sem título)";
      const cliente =
        fields.find((f) => f.external_id === "cliente")?.values?.[0]?.title ||
        "(sem cliente)";
      const briefing =
        fields.find((f) => f.external_id === "observacoes-e-links")?.values?.[0]
          ?.value || "";

      const textoParaRevisar = `
Título: ${titulo}
Cliente: ${cliente}
Briefing: ${briefing}
      `.trim();

      console.log("✍️ Texto para revisão:", textoParaRevisar);

      // 6) Chama a OpenAI para gerar a revisão
      const openaiRes = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
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
                content:
                  "Você é Risa, nossa IA editorial. Revise o texto abaixo em formato de tópicos, focando em clareza, coesão e tom de marca.",
              },
              { role: "user", content: textoParaRevisar },
            ],
            temperature: 0.7,
          }),
        }
      );
      const openaiJson = await openaiRes.json();
      const revisao = openaiJson.choices?.[0]?.message?.content || "";

      console.log("✅ Revisão gerada:", revisao);

      // 7) Publica a revisão como um comentário no Podio
      await fetch(`https://api.podio.com/item/${item_id}/comment/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PODIO_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: revisao }),
      });

      return res.sendStatus(200);
    } catch (err) {
      console.error("❌ Erro ao processar item.update:", err);
      return res.sendStatus(500);
    }
  }

  // Qualquer outro evento que não seja hook.verify ou item.update → OK
  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

