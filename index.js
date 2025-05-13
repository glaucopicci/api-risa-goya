import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// Token estático (gerado via curl; copia/cola em ENV)
const STATIC_PODIO_TOKEN = process.env.PODIO_ACCESS_TOKEN || "";

// Função que só roda quando de fato queremos processar “Revisar”
async function getRefreshedToken() {
  const params = new URLSearchParams({
    grant_type:    "refresh_token",
    client_id:     process.env.PODIO_CLIENT_ID,
    client_secret: process.env.PODIO_CLIENT_SECRET,
    refresh_token: process.env.PODIO_REFRESH_TOKEN,
  });
  const resp = await fetch("https://podio.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error_description || JSON.stringify(data));
  }
  return data.access_token;
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT            = process.env.PORT || 10000;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;

app.post("/webhook", async (req, res) => {
  const { type, hook_id, code, item_id, item_revision_id } = req.body;

  //
  // 1) Validation Hook
  //
  if (type === "hook.verify") {
    console.log(`🔗 hook.verify recebido, validando ${hook_id}`);
    let token;
    try {
      token = await getRefreshedToken();
    } catch (err) {
      console.error("❌ Falha ao obter token para validar:", err);
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
      console.error("❌ Verificação retornou", vr.status, await vr.text());
      return res.sendStatus(500);
    }
    console.log("🔐 Webhook validado com sucesso");
    return res.sendStatus(200);
  }

  //
  // 2) item.update → FILTRO RÁPIDO via Revision API + STATIC TOKEN
  //
  if (type === "item.update" && item_id && item_revision_id) {
    // 2.1) Busca apenas o delta da revisão
    let revData;
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
      if (!r.ok) {
        // revisões menores ou sem permissão → ignora
        return res.sendStatus(200);
      }
      revData = await r.json();
    } catch {
      return res.sendStatus(200);
    }

    // 2.2) Verifica se o campo “status” mudou para “revisar”
    const changed = Array.isArray(revData.fields) ? revData.fields : [];
    const statusChange = changed.find((f) => f.external_id === "status");
    const newStatus = statusChange?.values?.[0]?.value?.text?.toLowerCase();
    if (newStatus !== "revisar") {
      // Não é Revisar → silêncio total
      return res.sendStatus(200);
    }

    //
    // 3) Aqui sim: é Revisar → obtemos token fresco e processamos
    //
    console.log("📦 Status mudou para Revisar → processando item", item_id);

    let token;
    try {
      token = await getRefreshedToken();
    } catch (err) {
      console.error("❌ Falha ao obter token fresco, abortando:", err);
      return res.sendStatus(500);
    }

    // 3.1) Busca item completo
    let itemData;
    try {
      const ir = await fetch(`https://api.podio.com/item/${item_id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      if (!ir.ok) {
        console.error(`⚠️ item.get retornou ${ir.status}`);
        return res.sendStatus(200);
      }
      itemData = await ir.json();
    } catch (err) {
      console.error("❌ Erro ao buscar item:", err);
      return res.sendStatus(500);
    }

    // 3.2) Extrai campos necessários
    const fields = itemData.fields || [];
    const titulo   = fields.find(f => f.external_id==="titulo-2")?.values?.[0]?.value   || "(sem título)";
    const cliente  = fields.find(f => f.external_id==="cliente")?.values?.[0]?.title     || "(sem cliente)";
    const briefing = fields.find(f => f.external_id==="observacoes-e-links")?.values?.[0]?.value || "";

    const textoParaRevisar = `
Título: ${titulo}
Cliente: ${cliente}
Briefing: ${briefing}
    `.trim();
    console.log("✍️ Texto para revisão:", textoParaRevisar);

    // 3.3) Chama a OpenAI
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
                "Você é Risa, nossa IA editorial. Revise o texto abaixo em tópicos, focando em clareza, coesão e tom de marca.",
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

    // 3.4) Publica comentário no Podio
    try {
      await fetch(`https://api.podio.com/item/${item_id}/comment/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: revisao }),
      });
      console.log("💬 Comentário registrado");
    } catch (err) {
      console.error("❌ Erro ao postar comentário:", err);
    }

    return res.sendStatus(200);
  }

  // Qualquer outro evento → silêncio total
  return res.sendStatus(200);
});

// Inicia servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

