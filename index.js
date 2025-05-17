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
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('client_id', PODIO_CLIENT_ID);
  params.append('client_secret', PODIO_CLIENT_SECRET);
  params.append('refresh_token', PODIO_REFRESH_TOKEN);

  const response = await fetch('https://podio.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const text = await response.text();
  if (!response.ok) {
    console.error('❌ Erro ao renovar token:', text);
    throw new Error('Erro ao renovar token: ' + response.status);
  }

  const data = JSON.parse(text);
  podioAccessToken = data.access_token;
  console.log('🔄 Token OAuth2 renovado');
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
    const errText = await res.text();
    throw new Error('Podio GET falhou: ' + res.status + ' — ' + errText);
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
    const errText = await res.text();
    throw new Error('Podio POST falhou: ' + res.status + ' — ' + errText);
  }

  return res.json();
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.post('/revisar', async (req, res) => {
  const { item_id, revision_id } = req.body;
  console.log(`📩 Recebido do PHP: item_id=${item_id}, revision_id=${revision_id}`);

  try {
    const item = await podioGet(`item/${item_id}`);

    const statusField = item.fields.find(f => f.external_id === 'status');
    const optionId = statusField?.values?.[0]?.value?.id;

    if (optionId !== 4) {
      console.log(`⏭️ Ignorado — option_id é ${optionId}`);
      return res.status(204).send();
    }

    const title = item.fields.find(f => f.external_id === 'titulo-2')?.values?.[0]?.value || '';
    const cliente = item.fields.find(f => f.external_id === 'cliente')?.values?.[0]?.value?.title || '';
    const briefing = item.fields.find(f => f.external_id === 'observacoes-e-links')?.values?.[0]?.value || '';

    const model = OPENAI_MODEL || 'gpt-4o';
    console.log(`🤖 Chamando OpenAI com modelo: ${model}`);

    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'Você é a Risa, assistente de revisão da Goya Conteúdo.' },
        { role: 'user', content: `Título: ${title}\nCliente: ${cliente}\nBriefing: ${briefing}\n\nRevise o conteúdo.` }
      ]
    });

    const revisado = completion.choices[0].message.content;
    console.log('📝 Texto revisado:', revisado);

    const result = await podioPost(`item/${item_id}/comment`, { value: revisado });
    console.log('✅ Comentário postado no Podio:', result);

    res.status(200).send({ revisado });
  } catch (err) {
    console.error('❌ Erro:', err);
    res.status(500).send({ error: err.toString() });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Render escutando na porta ${PORT}`));

