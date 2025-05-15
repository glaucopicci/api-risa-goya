import express from 'express';
import fetch from 'node-fetch';
import OpenAI from 'openai';

const app = express();
app.use(express.json());

const {
  PODIO_CLIENT_ID,
  PODIO_CLIENT_SECRET,
  PODIO_REFRESH_TOKEN,
  PODIO_ACCESS_TOKEN: initialAccessToken,
  OPENAI_API_KEY,
  OPENAI_MODEL
} = process.env;

let podioAccessToken = initialAccessToken;

async function refreshAccessToken() {
  const response = await fetch('https://podio.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: PODIO_CLIENT_ID,
      client_secret: PODIO_CLIENT_SECRET,
      refresh_token: PODIO_REFRESH_TOKEN
    })
  });

  if (!response.ok) {
    throw new Error('Falha ao renovar token: ' + response.status);
  }

  const data = await response.json();
  podioAccessToken = data.access_token;
  return podioAccessToken;
}

async function podioGet(endpoint) {
  let res = await fetch(`https://api.podio.com/${endpoint}`, {
    headers: { Authorization: `OAuth2 ${podioAccessToken}` }
  });

  if (res.status === 401) {
    await refreshAccessToken();
    res = await fetch(`https://api.podio.com/${endpoint}`, {
      headers: { Authorization: `OAuth2 ${podioAccessToken}` }
    });
  }

  if (!res.ok) {
    throw new Error('Podio GET falhou: ' + res.status);
  }

  return res.json();
}

async function podioPost(endpoint, body) {
  let res = await fetch(`https://api.podio.com/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth2 ${podioAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (res.status === 401) {
    await refreshAccessToken();
    res = await fetch(`https://api.podio.com/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `OAuth2 ${podioAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  }

  if (!res.ok) {
    throw new Error('Podio POST falhou: ' + res.status);
  }

  return res.json();
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.post('/revisar', async (req, res) => {
  const { item_id, revision_id } = req.body;
  console.log(`📥 Recebido do proxy: item_id=${item_id}, revision_id=${revision_id}`);

  try {
    const item = await podioGet(`item/${item_id}`);
    const statusField = item.fields.find(f => f.external_id === 'status');
    const status = statusField?.values?.[0]?.text;

    if (status !== 'Revisar') {
      console.log('⏭️ Status diferente de “Revisar” — ignorando.');
      return res.status(204).send();
    }

    const title = item.fields.find(f => f.external_id === 'title')?.values?.[0]?.text || '';
    const cliente = item.fields.find(f => f.external_id === 'cliente')?.values?.[0]?.text || '';
    const briefing = item.fields.find(f => f.external_id === 'briefing')?.values?.[0]?.text || '';

    const model = OPENAI_MODEL || 'g-67ddadfd22d881919a658cea6d5dc29f-risa';
    console.log(`🤖 Usando modelo: ${model}`);

    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'Você é a Risa, assistente de revisão da Goya Conteúdo.' },
        { role: 'user', content: `Título: ${title}\nCliente: ${cliente}\nBriefing: ${briefing}\n\nPor favor, revise o texto acima conforme as guidelines.` }
      ]
    });

    const revisado = completion.choices[0].message.content;
    await podioPost(`item/${item_id}/comment`, { value: revisado });
    console.log('✅ Comentário publicado no Podio');

    res.status(200).send({ revisado });
  } catch (err) {
    console.error('❌ Erro interno:', err);
    res.status(500).send({ error: err.toString() });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

