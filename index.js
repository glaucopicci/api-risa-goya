import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

// ── 1) Função de Refresh Token (form-encoded) ───────────────────────────
async function getAccessToken() {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id:     process.env.PODIO_CLIENT_ID,
    client_secret: process.env.PODIO_CLIENT_SECRET,
    refresh_token: process.env.PODIO_REFRESH_TOKEN
  });

  const resp = await fetch("https://podio.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(
      `Falha ao renovar Podio token (${resp.status}): ${data.error_description}`
    );
  }
  return data.access_token;
}

// ── 2) Setup Express ────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ── 3) Handler /webhook ──────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // 3.1) Garante um token fresco antes de qualquer chamada ao Podio
  let podioToken;
  try {
    podioToken = await getAccessToken();
  } catch (err) {
    console.error("🚨 Erro ao renovar Podio token:", err);
    return res.sendStatus(500);
  }

  const { type, hook_id, code, item_id, item_revision_id } = req.body;

  // ── 3.2) Validação do webhook (hook.verify) ─────────────────────────────
  if (type === "hook.verify") {
    console.log(`🔗 Validando webhook ${hook_id}`);
    try {
      const vr = await fetch(
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
      if (!vr.ok) {
        const txt = await vr.text();
        console.error("❌ Verificação falhou:", vr.status, txt);
        return res.sendStatus(500);
      }
      console.log("🔐 Webhook validado com sucesso");
      return res.sendStatus(200);
    } catch (err) {
      console.error("❌ Erro interno na verificação:", err);
      return res.sendStatus(500);
    }
  }

  // ── 3.3) Processa item.update **SÓ** se status mudou para “revisar” ───────
  if (type === "item.update" && item_id && item_revision_id) {
    // a) Puxa só o delta da revisão
    let revData;
    try {
      const r = await fetch(
        `https://api.podio.com/item/${item_id}/revision/${item_revision_id}`,
        {
          headers: {
            Authorization: `Bearer ${podioToken}`,
            Accept: "application/json"
          }
        }
      );
      if (!r.ok) return res.sendStatus(200);
      revData = await r.json();
    } catch (err) {
      console.error("⚠️ Erro ao obter revision:", err);
      return res.sendStatus(200);
    }

    // b) Filtra apenas mudanças no campo “status”
    const changed = Array.isArray(revData.fields) ? revData.fields : [];
    const statusChange = changed.find(f => f.external_id === "status");
    const newStatus = statusChange?.values?.[0]?.value?.text?.toLowerCase();
    if (newStatus !== "revisar") return res.sendStatus(200);

    console.log("📦 Processando revisão para item_id:", item_id);

    // c) Busca item completo e extrai campos
    let itemData;
    try {
      const ir = await fetch(`https://api.podio.com/item/${item_id}`, {
        headers: {
          Authorization: `Bearer ${podioToken}`,
          Accept: "application/json"
        }
      });
      if (!ir.ok) {
        console.error(`⚠️ Erro ao buscar item ${item_id}: ${ir.status}`);
        return res.sendStatus(200);
      }
      itemData = await ir.json();
    } catch (err) {
      console.error("❌ Erro ao buscar item completo:", err);
      return res.sendStatus(200);
    }

    const fields = Array.isArray(itemData.fields) ? itemData.fields : [];
    const titulo   = fields.find(f => f.external_id==="titulo-2")?.values?.[0]?.value || "(sem título)";
    const cliente  = fields.find(f => f.external_id==="cliente")?.values?.[0]?.title || "(sem cliente)";
    const briefing = fields.find(f => f.external_id==="observacoes-e-links")?.values?.[0]?.value || "";

    const textoParaRevisar = `
Título: ${titulo}
Cliente: ${cliente}
Briefing: ${briefing}
    `.trim();
    console.log("✍️ Texto para revisão:", textoParaRevisar);

    // d) Chama a OpenAI
    let revisao;
    try {
      const or = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [
            { role: "system", content: "Você é Risa, nossa IA editorial. Revise o texto abaixo em tópicos, focando em clareza, coesão e tom de marca." },
            { role: "user", content: textoParaRevisar }
          ],
          temperature: 0.7
        })
      });
      const oj = await or.json();
      revisao = oj.choices?.[0]?.message?.content || "";
    } catch (err) {
      console.error("❌ Erro na chamada OpenAI:", err);
      return res.sendStatus(500);
    }

    console.log("✅ Revisão gerada");

    // e) Publica como comentário no Podio
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

  // ── 3.4) Qualquer outro evento → silenciar ───────────────────────────────
  return res.sendStatus(200);
});

// ── 4) Inicia o servidor ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

