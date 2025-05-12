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


  // … hook.verify fica aqui acima …

  // ETAPA 2 — Só processa se for um item.update
  if (type === 'item.update' && item_id && item_revision_id) {
    console.log('🔄 item.update detectado, consultando revisão…');

    // 1) Busca apenas os campos alterados nesta revisão
    const revRes = await fetch(
      `https://api.podio.com/item/${item_id}/revision/${item_revision_id}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${PODIO_ACCESS_TOKEN}`,
          Accept: 'application/json'
        }
      }
    );
    if (!revRes.ok) {
      console.warn(`⚠️ Não foi possível obter revision ${item_revision_id}`);
      return res.sendStatus(200);
    }
    const revData = await revRes.json();
    const changedFields = revData.fields || [];
    console.log('Campos alterados nesta revisão:', changedFields.map(f => f.external_id));

    // 2) Verifica se o 'status' mudou para 'revisar'
    const statusChange = changedFields.find(f => f.external_id === 'status');
    const newStatus = statusChange?.values?.[0]?.value?.text?.toLowerCase();
    if (newStatus !== 'revisar') {
      console.log(`⏭️ Status mudou para "${newStatus || 'outro'}" — ignorando.`);
      return res.sendStatus(200);
    }

    // 3) A partir daqui você sabe que o status foi **exatamente** alterado para Revisar
    console.log('✍️ Status alterado para Revisar — executando a Risa…');

    // 4) Agora busque o item completo e monte o textoParaRevisar…
    const podioRes = await fetch(`https://api.podio.com/item/${item_id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${PODIO_ACCESS_TOKEN}` }
    });
    const itemData = await podioRes.json();
    const fields = itemData.fields;

    // (aqui entra exatamente o seu código atual que extrai título, cliente, briefing
    //  e chama a OpenAI para gerar a revisão em `revisao`)

    // 5) Por fim, atualize o Podio ou responda com sucesso
    return res.status(200).send('Revisão enviada com sucesso.');
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

