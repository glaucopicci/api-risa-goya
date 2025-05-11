import express from "express";
import bodyParser from "body-parser";
import { config } from "dotenv";
import OpenAI from "openai";
import { api as Podio } from "podio-js";

config();

const app = express();
const port = process.env.PORT || 10000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(bodyParser.json());

// Inicialização do cliente Podio
const podio = new Podio({
  authType: "oauth",
  clientId: process.env.PODIO_CLIENT_ID,
  clientSecret: process.env.PODIO_CLIENT_SECRET,
});

// Autenticação no Podio via OAuth2 (use seus tokens)
(async () => {
  try {
    podio.setTokens({
      access_token: process.env.PODIO_ACCESS_TOKEN,
      refresh_token: process.env.PODIO_REFRESH_TOKEN,
    });
    console.log('Autenticado no Podio');
  } catch (err) {
    console.error('Erro na autenticação Podio:', err);
  }
})();

// Rota única para webhooks do Podio
app.post('/webhook', async (req, res) => {
  const { type, hook_id, code } = req.body;

  // Tratamento de verificação do webhook
  if (type === 'hook.verify') {
    try {
      await podio.request('POST', `/hook/${hook_id}/verify`, { code });
      console.log(`Webhook ${hook_id} verificado com sucesso`);
      return res.sendStatus(200);
    } catch (err) {
      console.error('Falha ao validar webhook:', err);
      return res.sendStatus(500);
    }
  }

  // Processamento de eventos (item.create, item.update, etc.)
  try {
    // Extrai o texto a ser revisado do payload
    const texto = req.body.texto || req.body.text || req.body.content;
    if (!texto) {
      console.warn('Nenhum texto encontrado no payload');
      return res.status(200).send({ mensagem: 'Nenhum texto para revisar.' });
    }

    // Chamada à OpenAI para revisão de texto
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é um assistente que revisa e melhora textos.' },
        { role: 'user', content: `Revise o seguinte texto:\n\n${texto}` },
      ],
    });

    const reply = response.choices[0]?.message?.content;
    console.log('Revisão gerada:', reply);
    return res.status(200).send({ resposta: reply });
  } catch (error) {
    console.error('Erro no processamento do webhook:', error);
    return res.status(500).send({ erro: 'Falha ao processar o evento.' });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});

