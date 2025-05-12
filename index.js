import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const PODIO_ACCESS_TOKEN = process.env.PODIO_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.post("/webhook", async (req, res) => {
  const { type, hook_id, code, item_id } = req.body;

  console.log("📨 Dados recebidos:", req.body);

  // ✅ VERIFICAÇÃO DE WEBHOOK
  if (type === "hook.verify") {
    console.log("🔑 PODIO_ACCESS_TOKEN presente?", !!PODIO_ACCESS_TOKEN);
    console.log(`🔗 Validando webhook ${hook_id} com code=${code}`);

    try {
      const validateRes = await fetch(
        `https://api.podio.com/hook/${hook_id}/verify/validate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${PODIO_ACCESS_TOKEN}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code }),
        }
      );

      const text = await validateRes.text();
      console.log("📥 Resposta do Podio:", validateRes.status, text);

      if (!validateRes.ok) throw new Error(`Status ${validateRes.status}: ${text}`);
      console.log(`🔐 Webhook validado com sucesso!`);
      return res.sendStatus(200);
    } catch (err) {
      console.error("❌ Erro na verificação:", err);
      return res.status(500).send("Erro interno na verificação");
    }
  }

  // ETAPA 2 — Só processa quando status Texto for alterado para “Revisar”
  if (type === "item.update" && item_id) {
    // 1) Busca o estado atual do item
    const podioRes = await fetch(`https://api.podio.com/item/${item_id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${PODIO_ACCESS_TOKEN}` }
    });
    if (!podioRes.ok) return res.sendStatus(200);
    const itemData = await podioRes.json();
    const fields = Array.isArray(itemData.fields) ? itemData.fields : [];

    // 2) Lê o campo Status Texto (external_id 'status')
    const statusField = fields.find(f => f.external_id === "status");
    const statusLabel = statusField?.values?.[0]?.value?.text?.toLowerCase();

    if (statusLabel !== "revisar") {
      // não é Revisar → ignora sem log nem erro
      return res.sendStatus(200);
    }

    // 3) Finalmente processa a revisão
    console.log("📦 Recebido item_id para Revisar:", item_id);

    // — seu código atual para extrair título/cliente/briefing
    // — chamada ao OpenAI para gerar `revisao`
    // — gravação no Podio ou retorno 200

    return res.status(200).send("Revisão enviada com sucesso.");
  }

  // nenhum outro tipo de evento interessa
  return res.sendStatus(200);
  }
    } catch (err) {
      console.error("❌ Erro ao processar item:", err);
      return res.status(500).send("Erro interno ao revisar item");
    }
  }

  console.log("ℹ️ Webhook recebido sem item_id nem tipo conhecido");
  return res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
