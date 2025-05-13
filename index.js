import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// ── 1) Refresh token + fallback ─────────────────────────────────────────
async function getAccessToken() {
  const params = new URLSearchParams({
    grant_type:    "refresh_token",
    client_id:     process.env.PODIO_CLIENT_ID,
    client_secret: process.env.PODIO_CLIENT_SECRET,
    refresh_token: process.env.PODIO_REFRESH_TOKEN,
  });

  const resp = await fetch("https://podio.com/oauth/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    params.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error_description || JSON.stringify(data));
  }
  return data.access_token;
}

// Podio static token (gerado via curl e colocado em ENV)
const STATIC_PODIO_TOKEN = process.env.PODIO_ACCESS_TOKEN || "";

async function getPodioToken() {
  try {
    return await getAccessToken();
  } catch (err) {
    console.warn("🔄 Falha no refresh, usando token estático");
    if (!STATIC_PODIO_TOKEN) {
      throw new Error("Token estático não definido em PODIO_ACCESS_TOKEN");
    }
    return STATIC_PODIO_TOKEN;
  }
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.post("/webhook", async (req, res) => {
  const { type, hook_id, code, item_id, item_revision_id } = req.body;

  //
  // ETAPA 1 — Validação do webhook
  //
  if (type === "hook.verify") {
    let podioToken;
    try {
      podioToken = await getPodioToken();
      console.log(`🔗 Validando webhook ${hook_id}`);
      const vr = await fetch(
        `https://api.podio.com/hook/${hook_id}/verify/validate`,
        {
          method:  "POST",
          headers: {
            Authorization: `Bearer ${podioToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ code }),
        }
      );
      if (!vr.ok) {
        console.error("❌ Verificação falhou:", await vr.text());
        return res.sendStatus(500);
      }
      console.log("🔐 Webhook validado");
      return res.sendStatus(200);
    } catch (err) {
      console.error("🚨 Erro na verificação:", err);
      return res.sendStatus(500);
    }
  }

  //
  // ETAPA 2 — item.update → filtrar só Revisar
  //
  if (type === "item.update" && item_id && item_revision_id) {
    let podioToken;
    try {
      podioToken = await getPodioToken();
    } catch (err) {
      console.error("🚨 Não há token válido:", err);
      return res.sendStatus(500);
    }

    // a) busca delta
    let revData;
    try {
      const r = await fetch(
        `https://api.podio.com/item/${item_id}/revision/${item_revision_id}`,
        {
          headers: {
            Authorization: `Bearer ${podioToken}`,
            Accept: "application/json",
          },
        }
      );
      if (!r.ok) return res.sendStatus(200);
      revData = await r.json();
    } catch {
      return res.sendStatus(200);
    }

    // b) checa status
    const changed = Array.isArray(revData.fields) ? revData.fields : [];
    const s = changed.find((f) => f.external_id === "status");
    const newStatus = s?.values?.[0]?.value?.text?.toLowerCase();
    if (newStatus !== "revisar") {
      // silencia qualquer outra mudança
      return res.sendStatus(200);
    }

    console.log("📦 Processando revisão para item:", item_id);

    // c) busca item completo
    let itemData;
    try {
      const ir = await fetch(`https://api.podio.com/item/${item_id}`, {
        headers: {
          Authorization: `Bearer ${podioToken}`,
          Accept: "application/json",
        },
      });
      if (!ir.ok) {
        console.error("⚠️ Erro item.get:", ir.status);
        return res.sendStatus(200);
      }
      itemData = await ir.json();
    } catch (err) {
      console.error("❌ Erro ao buscar item completo:", err);
      return res.sendStatus(200);
    }

    const fields = Array.isArray(itemData.fields) ? itemData.fields : [];
    const titulo   = fields.find(f => f.external_id==="titulo-2")?.values?.[0]?.value   || "(sem título)";
    const cliente  = fields.find(f => f.external_id==="cliente")?.values?.[0]?.title     || "(sem cliente)";
    const briefing = fields.find(f => f.external_id==="observacoes-e-links")?.values?.[0]?.value || "";

    const textoParaRevisar = `Título: ${titulo}\nCliente: ${cliente}\nBriefing: ${briefing}`;
    console.log("✍️ Texto para revisão:", textoParaRevisar);

    // d) chamar OpenAI
    let revisao;
    try {
      const or = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [
            { role: "system", content: "Você é Risa… revise em tópicos." },
            { role: "user",   content: textoParaRevisar }
          ],
          temperature: 0.7,
        }),
      });
      const oj = await or.json();
      revisao = oj.choices?.[0]?.message?.content || "";
    } catch (err) {
      console.error("❌ OpenAI erro:", err);
      return res.sendStatus(500);
    }

    console.log("✅ Revisão gerada");

    // e) publica comentário
    try {
      await fetch(`https://api.podio.com/item/${item_id}/comment/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${podioToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: revisao }),
      });
      console.log("💬 Comentário registrado");
    } catch (err) {
      console.error("❌ Erro ao comentar:", err);
    }

    return res.sendStatus(200);
  }

  // tudo mais → OK silencioso
  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor ouvindo na porta ${PORT}`);
});

