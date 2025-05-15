import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const STATIC_PODIO_TOKEN = process.env.PODIO_ACCESS_TOKEN || "";

const app  = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());

// ── REFRESH TOKEN ──────────────────────────────
async function refreshToken() {
  const params = new URLSearchParams({
    grant_type:    "refresh_token",
    client_id:     process.env.PODIO_CLIENT_ID,
    client_secret: process.env.PODIO_CLIENT_SECRET,
    refresh_token: process.env.PODIO_REFRESH_TOKEN,
  });

  const res = await fetch(`https://api.podio.com/comment/item/${item_id}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:   params.toString(),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || JSON.stringify(json));
  return json.access_token;
}

// ── OBTÉM TOKEN ────────────────────────────────
async function getPodioToken() {
  try {
    return await refreshToken();
  } catch {
    console.warn("⚠️ Refresh falhou, usando token estático");
    if (!STATIC_PODIO_TOKEN) throw new Error("PODIO_ACCESS_TOKEN não definido");
    return STATIC_PODIO_TOKEN;
  }
}

// ── ROTA /revisar ──────────────────────────────
app.post("/revisar", async (req, res) => {
  const { item_id, revision_id } = req.body;

  if (!item_id || !revision_id) {
    console.warn("❌ Requisição sem item_id ou revision_id");
    return res.sendStatus(400);
  }

  console.log(`📥 Recebido do proxy: item_id=${item_id}, revision_id=${revision_id}`);

  // 1) Autentica com Podio
  let token;
  try {
    token = await getPodioToken();
  } catch (err) {
    console.error("❌ Falha ao obter token:", err);
    return res.sendStatus(500);
  }

  // 2) Busca item completo
  let itemData;
  try {
    const ir = await fetch(`https://api.podio.com/item/${item_id}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!ir.ok) {
      console.error(`⚠️ item.get falhou com ${ir.status}`);
      return res.sendStatus(500);
    }

    itemData = await ir.json();
  } catch (err) {
    console.error("❌ Erro ao buscar item:", err);
    return res.sendStatus(500);
  }

  // 3) Extrai campos
  const fields   = Array.isArray(itemData.fields) ? itemData.fields : [];
  const titulo   = fields.find(f => f.external_id === "titulo-2")?.values?.[0]?.value || "(sem título)";
  const cliente  = fields.find(f => f.external_id === "cliente")?.values?.[0]?.title  || "(sem cliente)";
  const briefing = fields.find(f => f.external_id === "observacoes-e-links")?.values?.[0]?.value || "";

  const textoParaRevisar = [
    `Título: ${titulo}`,
    `Cliente: ${cliente}`,
    `Briefing: ${briefing}`,
  ].join("\n");

  console.log("✍️ Texto para revisão:", textoParaRevisar);

  // 4) Chamada OpenAI
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
            content: "Você é Risa… revise o texto mantendo tom de marca, clareza e consistência.",
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

  console.log("✅ Revisão recebida do modelo");

  // 5) Publica no Podio como comentário (usando token dinâmico)
  try {
    const commentResponse = await fetch(`https://api.podio.com/item/${item_id}/comment/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: revisao }),
    });

    if (!commentResponse.ok) {
      const errText = await commentResponse.text();
      console.error("❌ Erro ao postar comentário:", commentResponse.status, errText);
      return res.sendStatus(500);
    }

    console.log("💬 Comentário publicado com sucesso");
  } catch (err) {
    console.error("❌ Erro inesperado ao postar comentário:", err);
    return res.sendStatus(500);
  }

  return res.sendStatus(200);
});

// ── START ──────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
