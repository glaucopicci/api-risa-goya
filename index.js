import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const WEBHOOK_ID        = process.env.PODIO_WEBHOOK_ID;
const STATIC_PODIO_TOKEN= process.env.PODIO_ACCESS_TOKEN || "";
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const REVISAR_OPTION_ID = parseInt(process.env.PODIO_STATUS_REVISAR_OPTION_ID, 10);

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

async function getPodioToken() {
  try {
    return await refreshToken();
  } catch {
    console.warn("⚠️ Refresh falhou, usando token estático");
    if (!STATIC_PODIO_TOKEN) throw new Error("PODIO_ACCESS_TOKEN não definido");
    return STATIC_PODIO_TOKEN;
  }
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.post("/webhook", async (req, res) => {
  const { type, hook_id, code, item_id, item_revision_id } = req.body;

  // — 1) Normaliza para string e compara
  if (`${hook_id}` !== `${WEBHOOK_ID}`) {
    console.warn("❌ Webhook ignorado, ID mismatch:", hook_id, WEBHOOK_ID);
    return res.sendStatus(403);
  }

  // — 2) hook.verify
  if (type === "hook.verify") {
    console.log("🔗 Validando webhook…");
    let token;
    try {
      token = await getPodioToken();
    } catch (err) {
      console.error("❌ Falha ao obter token:", err);
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
    console.log("🔐 Webhook validado e Active!");
    return res.sendStatus(200);
  }

  // — 3) item.update → filtrar apenas Revisar
  if (type === "item.update" && item_id && item_revision_id) {
    // 3.1) Busca o diff usando token estático
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

    const changed      = Array.isArray(delta.fields) ? delta.fields : [];
    const statusChange = changed.find((f) => f.external_id === "status");
    const v            = statusChange?.values?.[0]?.value || {};
    const isTextual    = (v.text || "").toLowerCase() === "revisar";
    const isOption     = v.integer_value_of_option === REVISAR_OPTION_ID;
    if (!isTextual && !isOption) {
      return res.sendStatus(200);
    }

    console.log(`📦 Status mudou para Revisar (item ${item_id})`);
    let token;
    try {
      token = await getPodioToken();
    } catch (err) {
      console.error("❌ Falha ao obter token fresco:", err);
      return res.sendStatus(500);
    }

    // busca item, chama OpenAI e comenta…
    // (restante do código igual ao que já te enviei anteriormente)
    // …

    return res.sendStatus(200);
  }

  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

