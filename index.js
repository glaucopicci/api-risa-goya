import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// ── CONFIGURAÇÃO ───────────────────────────────────────────────────────
const WEBHOOK_ID        = process.env.PODIO_WEBHOOK_ID;
const STATIC_PODIO_TOKEN  = process.env.PODIO_ACCESS_TOKEN || "";
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const REVISAR_OPTION_ID   = parseInt(process.env.PODIO_STATUS_REVISAR_OPTION_ID, 10);

// ── FUNÇÃO DE REFRESH TOKEN (form-urlencoded) ─────────────────────────
async function refreshToken() {
  const params = new URLSearchParams({
    grant_type:    "refresh_token",
    client_id:     process.env.PODIO_CLIENT_ID,
    client_secret: process.env.PODIO_CLIENT_SECRET,
    refresh_token: process.env.PODIO_REFRESH_TOKEN,
  });
  const res = await fetch("https://podio.com/oauth/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    params.toString(),
  });
  const js = await res.json();
  if (!res.ok) {
    throw new Error(js.error_description || JSON.stringify(js));
  }
  return js.access_token;
}

async function getPodioToken() {
  try {
    return await refreshToken();
  } catch (err) {
    console.warn("⚠️ Refresh falhou, usando token estático");
    if (!STATIC_PODIO_TOKEN) {
      throw new Error("PODIO_ACCESS_TOKEN está vazio");
    }
    return STATIC_PODIO_TOKEN;
  }
}

// ── SETUP EXPRESS ─────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const PORT = process.env.PORT || 10000;

// ── HANDLER DO WEBHOOK ─────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const { type, hook_id, code, item_id, item_revision_id } = req.body;

  // —— Segurança: rejeita calls de outro webhook
  if (hook_id !== WEBHOOK_ID) {
    return res.status(403).send("Forbidden: webhook_id mismatch");
  }

  //
  // ETAPA 1 — ativa o webhook (hook.verify)
  //
  if (type === "hook.verify") {
    console.log("🔗 hook.verify recebido, validando…");
    let token;
    try {
      token = await getPodioToken();
    } catch (err) {
      console.error("❌ getPodioToken() falhou:", err);
      return res.sendStatus(500);
    }
    const vr = await fetch(
      `https://api.podio.com/hook/${hook_id}/verify/validate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ code }),
      }
    );
    if (!vr.ok) {
      console.error("❌ Verificação falhou:", vr.status, await vr.text());
      return res.sendStatus(500);
    }
    console.log("🔐 Webhook validado e marcado Active!");
    return res.sendStatus(200);
  }

  //
  // ETAPA 2 — filtra todos os item.update **exceto** Revisar
  //
  if (type === "item.update" && item_id && item_revision_id) {
    // 2.1) pega o delta de campos usando static token (mais rápido)
    let rev;
    try {
      const r = await fetch(
        `https://api.podio.com/item/${item_id}/revision/${item_revision_id}`,
        {
          headers: {
            Authorization: `Bearer ${STATIC_PODIO_TOKEN}`,
            Accept: "application/json",
          },
        }
      );
      if (!r.ok) return res.sendStatus(200);
      rev = await r.json();
    } catch {
      return res.sendStatus(200);
    }

    // **DEBUG**: veja o payload exato no log e adapte conforme necessário
    console.log("🔍 revision.fields:", JSON.stringify(rev.fields, null, 2));

    // 2.2) busca mudança no campo external_id="status"
    const changed = Array.isArray(rev.fields) ? rev.fields : [];
    const statusChange = changed.find((f) => f.external_id === "status");
    const v = statusChange?.values?.[0]?.value || {};

    // 2.3) verifica se é o texto “revisar” (textual) ou o integer_option correto
    const isRevisarText = (v.text || "").toLowerCase() === "revisar";
    const isRevisarOpt  = v.integer_value_of_option === REVISAR_OPTION_ID;
    if (!isRevisarText && !isRevisarOpt) {
      // silêncio total para qualquer outro update
      return res.sendStatus(200);
    }

    //
    // ETAPA 3 — só aqui dentro é “Revisar” — processa tudo
    //
    console.log(`📦 Processando revisão (item ${item_id})…`);

    // 3.1) obtém token fresco
    let token;
    try {
      token = await getPodioToken();
    } catch (err) {
      console.error("❌ Falha ao obter token fresco:", err);
      return res.sendStatus(500);
    }

    // 3.2) busca item completo
    let itemData;
    try {
      const ir = await fetch(`https://api.podio.com/item/${item_id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      if (!ir.ok) {
        console.error("⚠️ item.get devolveu", ir.status);
        return res.sendStatus(200);
      }
      itemData = await ir.json();
    } catch (err) {
      console.error("❌ Erro ao buscar item completo:", err);
      return res.sendStatus(500);
    }

    // 3.3) extrai título / cliente / briefing
    const fields = Array.isArray(itemData.fields) ? itemData.fields : [];
    const titulo   = fields.find(f => f.external_id==="titulo-2")?.values?.[0]?.value   || "(sem título)";
    const cliente  = fields.find(f => f.external_id==="cliente")?.values?.[0]?.title    || "(sem cliente)";
    const briefing = fields.find(f => f.external_id==="observacoes-e-links")?.values?.[0]?.value || "";

    const textoParaRevisar = `
Título: ${titulo}
Cliente: ${cliente}
Briefing: ${briefing}
    `.trim();
    console.log("✍️ Texto para revisão:", textoParaRevisar);

    // 3.4) chama a OpenAI
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
            {
              role: "system",
              content:
                "Você é Risa, nossa IA editorial. Revise o texto em tópicos, focando em clareza, coesão e tom de marca.",
            },
            { role: "user", content: textoParaRevisar },
          ],
          temperature: 0.7,
        }),
      });
      const oj = await or.json();
      revisao = oj.choices?.[0]?.message?.content || "";
    } catch (err) {
      console.error("❌ Erro na OpenAI:", err);
      return res.sendStatus(500);
    }

    console.log("✅ Revisão gerada");

    // 3.5) publica comentário
    try {
      await fetch(`https://api.podio.com/item/${item_id}/comment/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: revisao }),
      });
      console.log("💬 Comentário publicado");
    } catch (err) {
      console.error("❌ Erro ao postar comentário:", err);
    }

    return res.sendStatus(200);
  }

  // qualquer outro tipo de evento → silêncio total
  return res.sendStatus(200);
});

// ── START ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

