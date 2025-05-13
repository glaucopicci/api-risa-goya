import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

// ── Configurações mínimas ⬇️
const WEBHOOK_ID          = process.env.PODIO_WEBHOOK_ID;
const STATIC_PODIO_TOKEN  = process.env.PODIO_ACCESS_TOKEN || "";
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;

// ── Função de refresh (form-urlencoded) ⬇️
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
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error_description || JSON.stringify(json));
  }
  return json.access_token;
}

// ── Always try refresh, fallback to static ⬇️
async function getPodioToken() {
  try {
    return await refreshToken();
  } catch {
    return STATIC_PODIO_TOKEN;
  }
}

// ── Setup Express ⬇️
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ── Webhook handler ⬇️
app.post("/webhook", async (req, res) => {
  const { type, hook_id, code, item_id, item_revision_id } = req.body;

  // —— 1) Segurança: rejeita IDs de webhook desconhecidos
  if (hook_id !== WEBHOOK_ID) {
    return res.status(403).send("Forbidden: webhook_id mismatch");
  }

  // —— 2) Validação inicial do webhook
  if (type === "hook.verify") {
    let token = await getPodioToken();
    console.log(`🔗 Validando webhook ${hook_id}`);
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
    console.log("🔐 Webhook marcado como Active");
    return res.sendStatus(200);
  }

  // —— 3) item.update: só processa se status mudou para “revisar”
  if (type === "item.update" && item_id && item_revision_id) {
    // 3.1) usa token estático para checar o delta
    let delta;
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
      delta = await r.json();
    } catch {
      return res.sendStatus(200);
    }

    // 3.2) filtra só mudanças no external_id “status”
    const changed = Array.isArray(delta.fields) ? delta.fields : [];
    const statusChange = changed.find(f => f.external_id === "status");
    const newStatus = statusChange?.values?.[0]?.value?.text?.toLowerCase();
    if (newStatus !== "revisar") {
      // silêncio total para qualquer outra mudança
      return res.sendStatus(200);
    }

    // —— 4) é “Revisar”: processa a revisão
    console.log("📦 Status TEXT mudou para Revisar! item_id:", item_id);

    // 4.1) obtém token fresco
    let token;
    try {
      token = await refreshToken();
    } catch (err) {
      console.error("❌ Não foi possível refresh token:", err);
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

    // 4.3) extrai título/cliente/briefing
    const fields   = Array.isArray(itemData.fields) ? itemData.fields : [];
    const titulo   = fields.find(f => f.external_id==="titulo-2")?.values?.[0]?.value   || "(sem título)";
    const cliente  = fields.find(f => f.external_id==="cliente")?.values?.[0]?.title    || "(sem cliente)";
    const briefing = fields.find(f => f.external_id==="observacoes-e-links")?.values?.[0]?.value || "";

    const textoParaRevisar = `Título: ${titulo}\nCliente: ${cliente}\nBriefing: ${briefing}`;
    console.log("✍️ Texto para revisão:", textoParaRevisar);

    // 4.4) chama OpenAI
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
      console.log("💬 Comentário publicado no Podio");
    } catch (err) {
      console.error("❌ Erro ao postar comentário:", err);
    }

    return res.sendStatus(200);
  }

  // —— tudo mais → silencio total
  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

