import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

// ── FUNÇÃO DE REFRESH TOKEN ─────────────────────────────────────────────
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

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(
      `Falha ao renovar Podio token (${resp.status}): ${data.error_description || JSON.stringify(data)}`
    );
  }
  return data.access_token;
}

// ── CONFIGURAÇÃO DO EXPRESS ─────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ── HANDLER DO WEBHOOK ──────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // 1) Primeiro, garanta um token válido do Podio
  let podioToken;
  try {
    podioToken = await getAccessToken();
  } catch (err) {
    console.error("🚨 Erro ao renovar Podio token:", err);
    return res.sendStatus(500);
  }

  const { type, hook_id, code, item_id, item_revision_id } = req.body;

  //
  // ETAPA 1 — VALIDAÇÃO DO WEBHOOK (hook.verify)
  //
  if (type === "hook.verify") {
    console.log(`🔗 Validando webhook ${hook_id}`);
    try {
      const verifyRes = await fetch(
        `https://api.podio.com/hook/${hook_id}/verify/validate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${podioToken}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify({ code })
        }
      );
      if (!verifyRes.ok) {
        const text = await verifyRes.text();
        console.error("❌ Falha na verificação:", verifyRes.status, text);
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
  // ETAPA 2 — PROCESSAMENTO DE item.update **SOMENTE** SE status → “revisar”
  //
  if (type === "item.update" && item_id && item_revision_id) {
    // 2.1) Consulta apenas o delta da revisão
    let revData;
    try {
      const revRes = await fetch(
        `https://api.podio.com/item/${item_id}/revision/${item_revision_id}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${podioToken}`,
            Accept: "application/json"
          }
        }
      );
      if (!revRes.ok) {
        // se não conseguiu ou não mudou nada relevante, ignora
        return res.sendStatus(200);
      }
      revData = await revRes.json();
    } catch (err) {
      console.error("⚠️ Erro ao obter revision:", err);
      return res.sendStatus(200);
    }

    // 2.2) Filtra mudança no campo “status”
    const changedFields = Array.isArray(revData.fields) ? revData.fields : [];
    const statusChange = changedFields.find(f => f.external_id === "status");
    const newStatus = statusChange?.values?.[0]?.value?.text?.toLowerCase();
    if (newStatus !== "revisar") {
      // não é o status “Revisar” → fim de linha
      return res.sendStatus(200);
    }

    console.log("📦 Processando revisão para item_id:", item_id);

    //
    // ETAPA 3 — BUSCA DO ITEM COMPLETO E EXTRAÇÃO DE CAMPOS
    //
    let itemData;
    try {
      const itemRes = await fetch(
        `https://api.podio.com/item/${item_id}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${podioToken}`,
            Accept: "application/json"
          }
        }
      );
      if (!itemRes.ok) {
        console.error(`⚠️ Erro ao buscar item ${item_id}: ${itemRes.status}`);
        return res.sendStatus(200);
      }
      itemData = await itemRes.json();
    } catch (err) {
      console.error("❌ Erro ao buscar item completo:", err);
      return res.sendStatus(200);
    }

    const fields = Array.isArray(itemData.fields) ? itemData.fields : [];
    const titulo =
      fields.find(f => f.external_id === "titulo-2")?.values?.[0]?.value ||
      "(sem título)";
    const cliente =
      fields.find(f => f.external_id === "cliente")?.values?.[0]?.title ||
      "(sem cliente)";
    const briefing =
      fields.find(f => f.external_id === "observacoes-e-links")?.values?.[0]
        ?.value || "";

    const textoParaRevisar = `
Título: ${titulo}
Cliente: ${cliente}
Briefing: ${briefing}
    `.trim();

    console.log("✍️ Texto para revisão:", textoParaRevisar);

    //
    // ETAPA 4 — CHAMADA À OPENAI
    //
    let revisao;
    try {
      const openaiRes = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "gpt-4",
            messages: [
              {
                role: "system",
                content:
                  "Você é Risa, nossa IA editorial. Revise o texto abaixo em tópicos, focando em clareza, coesão e tom de marca."
              },
              { role: "user", content: textoParaRevisar }
            ],
            temperature: 0.7
          })
        }
      );
      const o = await openaiRes.json();
      revisao = o.choices?.[0]?.message?.content || "";
    } catch (err) {
      console.error("❌ Erro na chamada OpenAI:", err);
      return res.sendStatus(500);
    }

    console.log("✅ Revisão gerada");

    //
    // ETAPA 5 — GRAVAÇÃO COMO COMENTÁRIO NO PODIO
    //
    try {
      await fetch(`https://api.podio.com/item/${item_id}/comment/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${podioToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ value: revisao })
      });
      console.log("💬 Comentário registrado no Podio");
    } catch (err) {
      console.error("❌ Erro ao postar comentário:", err);
    }

    return res.sendStatus(200);
  }

  // tudo mais → silenciar
  return res.sendStatus(200);
});

// ── START DO SERVIDOR ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

