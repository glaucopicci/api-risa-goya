import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// ── CONFIGURAÇÕES ───────────────────────────────────────────────────────
const WEBHOOK_ID           = process.env.PODIO_WEBHOOK_ID;
const STATIC_PODIO_TOKEN   = process.env.PODIO_ACCESS_TOKEN || "";
const OPENAI_API_KEY       = process.env.OPENAI_API_KEY;
const REVISAR_OPTION_ID    = parseInt(process.env.PODIO_STATUS_REVISAR_OPTION_ID, 10);

// ── FUNÇÃO DE REFRESH TOKEN (x-www-form-urlencoded) ─────────────────────
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
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description || JSON.stringify(j));
  return j.access_token;
}

// ── RETORNA SEMPRE UM TOKEN (refresh ou static) ─────────────────────────
async function getPodioToken() {
  try {
    return await refreshToken();
  } catch {
    console.warn("⚠️ Refresh falhou, usando token estático");
    if (!STATIC_PODIO_TOKEN) {
      throw new Error("PODIO_ACCESS_TOKEN não definido");
    }
    return STATIC_PODIO_TOKEN;
  }
}

// ── SETUP EXPRESS ───────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const PORT = process.env.PORT || 10000;

// ── HANDLER DO WEBHOOK ─────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const { type, hook_id, code, item_id, item_revision_id } = req.body;

  // 1) Só processa chamadas do seu webhook
  if (hook_id !== WEBHOOK_ID) {
    return res.status(403).send("Forbidden: webhook_id mismatch");
  }

  // 2) Validação inicial do webhook
  if (type === "hook.verify") {
    console.log("🔗 hook.verify recebido, validando…");
    let token;
    try {
      token = await getPodioToken();
    } catch (err) {
      console.error("❌ Não obteve token para validar:", err);
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
    console.log("🔐 Webhook validado e Active.");
    return res.sendStatus(200);
  }

  // 3) Apenas item.update com revision_id
  if (type === "item.update" && item_id && item_revision_id) {
    // 3.1) Pega o delta com o token estático
    let delta;
    try {
      const revId = parseInt(item_revision_id, 10);
      const prev  = revId - 1;
      const r = await fetch(
        `https://api.podio.com/item/${item_id}/revision/${prev}/${revId}`,
        {
          headers: {
            Authorization: `Bearer ${STATIC_PODIO_TOKEN}`,
            Accept: "application/json",
          },
        }
      );
      if (!r.ok) return res.sendStatus(200);
      delta = await r.json();
    } catch {
      return res.sendStatus(200);
    }

    console.log("🔍 Delta fields:", JSON.stringify(delta.fields));

    // 3.2) Filtra só o campo external_id="status"
    const changed = Array.isArray(delta.fields) ? delta.fields : [];
    const statusChange = changed.find((f) => f.external_id === "status");
    const v = statusChange?.values?.[0]?.value || {};

    // 3.3) Verifica se é “revisar” por texto ou pelo integer ID
    const isTextual = (v.text || "").toLowerCase() === "revisar";
    const isOption  = v.integer_value_of_option === REVISAR_OPTION_ID;
    if (!isTextual && !isOption) {
      return res.sendStatus(200); // silêncio total
    }

    //
    // 4) Só aqui é Revisar → processa a revisão
    //
    console.log(`📦 Status mudou para Revisar (item ${item_id})`);

    // 4.1) token fresco
    let token;
    try {
      token = await getPodioToken();
    } catch (err) {
      console.error("❌ Falha ao obter token fresco:", err);
      return res.sendStatus(500);
    }

    // 4.2) busca item completo
    let itemData;
    try {
      const ir = await fetch(`https://api.podio.com/item/${item_id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      if (!ir.ok) {
        console.error(`⚠️ item.get ${item_id} devolveu ${ir.status}`);
        return res.sendStatus(200);
      }
      itemData = await ir.json();
    } catch (err) {
      console.error("❌ Erro ao buscar item completo:", err);
      return res.sendStatus(500);
    }

    // 4.3) extrai título / cliente / briefing
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

    // 4.4) chama a OpenAI
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

    // 4.5) publica comentário
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

  // Qualquer outro evento → silêncio total
  return res.sendStatus(200);
});

// ── START ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

